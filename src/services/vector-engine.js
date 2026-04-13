import { DIMENSIONS } from './embedding.js';

/**
 * In-memory vector store with cosine similarity search.
 * Stores vectors in a Map keyed by id.
 */
class VectorEngine {
  constructor() {
    /** @type {Map<string, { id: string, vector: number[], metadata: object }>} */
    this.store = new Map();
  }

  /**
   * Cosine similarity between two vectors.
   */
  cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Add a vector to the store.
   */
  addVector(id, vector, metadata = {}) {
    this.store.set(id, { id, vector, metadata });
    return { id, dimensions: vector.length, stored: true };
  }

  /**
   * Search for the top-K most similar vectors.
   * Optional filter: an object whose keys must match metadata values.
   */
  search(queryVector, topK = 5, filter = {}) {
    const results = [];

    for (const [id, entry] of this.store) {
      // Apply metadata filters
      let match = true;
      for (const [key, val] of Object.entries(filter)) {
        if (entry.metadata[key] !== val) {
          match = false;
          break;
        }
      }
      if (!match) continue;

      const score = this.cosineSimilarity(queryVector, entry.vector);
      results.push({ id, score, metadata: entry.metadata });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Delete a vector by id.
   */
  deleteVector(id) {
    return this.store.delete(id);
  }

  /**
   * Get a single vector entry by id.
   */
  getVector(id) {
    return this.store.get(id) || null;
  }

  /**
   * Return store statistics.
   */
  getStats() {
    return {
      total_vectors: this.store.size,
      dimensions: DIMENSIONS,
      engine: 'in-memory-cosine',
      index_type: 'brute-force',
    };
  }
}

// Singleton instance
const vectorEngine = new VectorEngine();
export default vectorEngine;
