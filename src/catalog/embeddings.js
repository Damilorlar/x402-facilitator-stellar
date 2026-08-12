import { fetch } from 'undici';

export class EmbeddingClient {
  constructor(url) {
    this.url = url;
  }

  /**
   * Composes a single text document from the resource for embedding.
   */
  composeDocument(resource) {
    const parts = [
      resource.serviceName || '',
      resource.description || '',
      (resource.tags || []).join(' '),
      resource.type || '',
    ];

    if (resource.extensions) {
      for (const [extName, extData] of Object.entries(resource.extensions)) {
        if (extData && extData.parameters) {
          parts.push(`Extension ${extName} parameters:`);
          for (const [paramName, paramDesc] of Object.entries(extData.parameters)) {
            parts.push(`${paramName}: ${paramDesc}`);
          }
        }
      }
    }

    return parts.filter(Boolean).join('. ');
  }

  /**
   * Fetches an embedding for the given text.
   * Returns an array of numbers (the vector), or null if the provider is unavailable.
   */
  async embed(text) {
    if (!this.url) return null;

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: text }),
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      return data.embedding;
    } catch {
      // Network failure, degrade gracefully
      return null;
    }
  }

  /**
   * Optional reranking pass using a cross-encoder model via an API.
   * Takes a query and a list of resources, returns the reranked list of resources.
   * If reranking is disabled or unavailable, returns the list unchanged.
   */
  async rerank(query, resources) {
    if (!this.url) return resources;

    try {
      // Hypothetical cross-encoder API endpoint that expects query + pairs
      const response = await fetch(`${this.url}/rerank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          documents: resources.map(r => this.composeDocument(r)),
        }),
      });

      if (!response.ok) {
        return resources;
      }

      const data = await response.json();
      // Expecting { scores: [0.9, 0.1, 0.5] } matching the documents array
      if (data.scores && data.scores.length === resources.length) {
        const paired = resources.map((res, i) => ({ res, score: data.scores[i] }));
        paired.sort((a, b) => b.score - a.score);
        return paired.map(p => p.res);
      }

      return resources;
    } catch {
      return resources;
    }
  }
}
