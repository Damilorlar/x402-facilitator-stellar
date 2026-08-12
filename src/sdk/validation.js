export function validateDiscoveryDeclaration(decl) {
  const errors = [];
  if (!decl || typeof decl !== 'object') {
    return ['Declaration must be an object'];
  }
  if (!decl.routeTemplate) errors.push('routeTemplate is required');

  // Check for parameter descriptions if parameters exist in template
  if (decl.routeTemplate) {
    const matches = decl.routeTemplate.match(/\{([^}]+)\}/g);
    if (matches) {
      const params = matches.map(m => m.slice(1, -1));
      params.forEach(p => {
        if (!decl.parameters || !decl.parameters[p]) {
          errors.push(`Missing description for parameter: ${p}`);
        }
      });
    }
  }

  if (!decl.pricing || typeof decl.pricing !== 'object') {
    errors.push('pricing object is required');
  } else {
    if (!decl.pricing.amount) errors.push('pricing.amount is required');
    if (!decl.pricing.asset) errors.push('pricing.asset is required');
  }

  return errors;
}
