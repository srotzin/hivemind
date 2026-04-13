import crypto from 'node:crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEV_DIMENSIONS = 128;
const PROD_DIMENSIONS = 1536;

export const DIMENSIONS = OPENAI_API_KEY ? PROD_DIMENSIONS : DEV_DIMENSIONS;

/**
 * Generate a deterministic pseudo-embedding from text using SHA-512 hashing.
 * Produces a unit-length vector so cosine similarity works correctly.
 */
function hashEmbed(text) {
  const normalized = text.toLowerCase().trim();
  const vec = new Float64Array(DEV_DIMENSIONS);

  // Generate enough hash material to fill the vector
  const rounds = Math.ceil(DEV_DIMENSIONS / 8);
  for (let r = 0; r < rounds; r++) {
    const hash = crypto.createHash('sha512').update(`${r}:${normalized}`).digest();
    for (let i = 0; i < 8 && r * 8 + i < DEV_DIMENSIONS; i++) {
      // Read 8 bytes as a float-like value in [-1, 1]
      const bytes = hash.subarray(i * 8, i * 8 + 8);
      const val = bytes.readInt32BE(0) / 2147483647;
      vec[r * 8 + i] = val;
    }
  }

  // Normalize to unit length
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }

  return Array.from(vec);
}

/**
 * Call OpenAI text-embedding-3-small API.
 */
async function openaiEmbed(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embedding failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

/**
 * Embed text into a vector. Uses OpenAI in production, hash-based in dev.
 */
export async function embed(text) {
  if (OPENAI_API_KEY) {
    return openaiEmbed(text);
  }
  return hashEmbed(text);
}

export function getEmbeddingMode() {
  return OPENAI_API_KEY ? 'openai' : 'hash-pseudo';
}
