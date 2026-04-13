import { DIMENSIONS } from './embedding.js';
import { pool, isPostgresEnabled } from './db.js';

/**
 * Vector engine with pgvector backend and in-memory fallback.
 *
 * When DATABASE_URL is set, all vector operations go through PostgreSQL
 * using the pgvector extension's <=> (cosine distance) operator.
 * When DATABASE_URL is not set, falls back to in-memory brute-force search.
 */
class VectorEngine {
  constructor() {
    /** @type {Map<string, { id: string, vector: number[], metadata: object }>} */
    this.store = new Map();
  }

  // ─── In-memory helpers (fallback) ───────────────────────────────

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

  _searchInMemory(queryVector, topK, filter) {
    const results = [];
    for (const [id, entry] of this.store) {
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

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Add a vector to the store.
   * With PostgreSQL: stores embedding in hivemind.memory_nodes.embedding column.
   * Without: stores in the in-memory Map.
   */
  async addVector(id, vector, metadata = {}) {
    if (isPostgresEnabled()) {
      try {
        const vectorStr = `[${vector.join(',')}]`;
        await pool.query(
          `UPDATE hivemind.memory_nodes SET embedding = $1::vector WHERE node_id = $2`,
          [vectorStr, id]
        );
        return { id, dimensions: vector.length, stored: true, backend: 'pgvector' };
      } catch (err) {
        // Fall through to in-memory if the row doesn't exist yet
        // (vector may be added before the memory_nodes row)
        this.store.set(id, { id, vector, metadata });
        return { id, dimensions: vector.length, stored: true, backend: 'in-memory-fallback' };
      }
    }

    this.store.set(id, { id, vector, metadata });
    return { id, dimensions: vector.length, stored: true, backend: 'in-memory' };
  }

  /**
   * Search for the top-K most similar vectors.
   * With PostgreSQL: uses pgvector <=> (cosine distance) operator.
   * Without: brute-force cosine similarity in memory.
   */
  async search(queryVector, topK = 5, filter = {}) {
    if (isPostgresEnabled()) {
      try {
        const vectorStr = `[${queryVector.join(',')}]`;
        const conditions = ['embedding IS NOT NULL'];
        const params = [vectorStr, topK];
        let paramIdx = 3;

        if (filter.did) {
          conditions.push(`did = $${paramIdx++}`);
          params.push(filter.did);
        }
        if (filter.tier) {
          conditions.push(`tier = $${paramIdx++}`);
          params.push(filter.tier);
        }
        if (filter.namespace) {
          conditions.push(`namespace = $${paramIdx++}`);
          params.push(filter.namespace);
        }

        const whereClause = conditions.join(' AND ');
        const result = await pool.query(
          `SELECT node_id, 1 - (embedding <=> $1::vector) AS score, did, tier, namespace, semantic_tags
           FROM hivemind.memory_nodes
           WHERE ${whereClause}
           ORDER BY embedding <=> $1::vector
           LIMIT $2`,
          params
        );

        return result.rows.map(row => ({
          id: row.node_id,
          score: parseFloat(row.score),
          metadata: {
            did: row.did,
            tier: row.tier,
            namespace: row.namespace,
            tags: row.semantic_tags,
          },
        }));
      } catch {
        // Fall through to in-memory search
        return this._searchInMemory(queryVector, topK, filter);
      }
    }

    return this._searchInMemory(queryVector, topK, filter);
  }

  /**
   * Delete a vector by id.
   * With PostgreSQL: sets embedding to NULL (row deletion handled by memory-store).
   * Without: removes from the in-memory Map.
   */
  async deleteVector(id) {
    if (isPostgresEnabled()) {
      try {
        await pool.query(
          'UPDATE hivemind.memory_nodes SET embedding = NULL WHERE node_id = $1',
          [id]
        );
        return true;
      } catch {
        return this.store.delete(id);
      }
    }
    return this.store.delete(id);
  }

  /**
   * Get a single vector entry by id.
   */
  async getVector(id) {
    if (isPostgresEnabled()) {
      try {
        const result = await pool.query(
          'SELECT node_id, embedding, did, tier, namespace, semantic_tags FROM hivemind.memory_nodes WHERE node_id = $1',
          [id]
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        return {
          id: row.node_id,
          vector: row.embedding,
          metadata: { did: row.did, tier: row.tier, namespace: row.namespace, tags: row.semantic_tags },
        };
      } catch {
        return this.store.get(id) || null;
      }
    }
    return this.store.get(id) || null;
  }

  /**
   * Return store statistics.
   */
  async getStats() {
    if (isPostgresEnabled()) {
      try {
        const result = await pool.query(
          'SELECT COUNT(*) AS total FROM hivemind.memory_nodes WHERE embedding IS NOT NULL'
        );
        return {
          total_vectors: parseInt(result.rows[0].total, 10),
          dimensions: DIMENSIONS,
          engine: 'pgvector',
          index_type: 'ivfflat',
        };
      } catch {
        return {
          total_vectors: this.store.size,
          dimensions: DIMENSIONS,
          engine: 'in-memory-cosine',
          index_type: 'brute-force',
        };
      }
    }
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
