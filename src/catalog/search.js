export function scoreResource(resource, query) {
  if (!query || !query.trim()) return 0;

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let score = 0;

  const serviceName = (resource.serviceName || '').toLowerCase();
  const description = (resource.description || '').toLowerCase();

  // Extract parameter descriptions from extensions
  const extDocs = [];
  if (resource.extensions && typeof resource.extensions === 'object') {
    // Deep search for "description" keys or just JSON stringify
    const extStr = JSON.stringify(resource.extensions).toLowerCase();
    extDocs.push(extStr);
  }

  for (const token of tokens) {
    if (serviceName.includes(token)) score += 10;

    if (resource.tags && Array.isArray(resource.tags)) {
      if (resource.tags.some(t => t.toLowerCase() === token)) {
        score += 8;
      } else if (resource.tags.some(t => t.toLowerCase().includes(token))) {
        score += 4;
      }
    }

    if (description.includes(token)) score += 3;

    for (const doc of extDocs) {
      if (doc.includes(token)) score += 1;
    }
  }

  if (score === 0) return 0;

  if (resource.source === 'payment') {
    score += 5; // Payment-verified boost
  }

  // Recency decay (half-life of ~30 days)
  if (resource.last_seen_at) {
    const daysOld = (Date.now() - resource.last_seen_at.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOld > 0) {
      score = score * Math.exp(-daysOld / 43); // e^(-x/43) is approx 0.5 at x=30
    }
  }

  return score;
}
