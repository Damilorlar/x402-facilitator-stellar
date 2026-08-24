import {
  isValidRouteTemplate,
  isValidServiceName,
  isValidIconUrl,
  sanitizeTags,
  extractDiscoveryInfo,
  validateDiscoveryExtension,
} from '@x402/extensions';

/**
 * Distinguishes a hostile routeTemplate (path traversal, protocol smuggling,
 * unparseable percent-encoding) from one that is merely low-quality, such as
 * the wildcard ("*") pattern upstream's own SDK registers by default. Both
 * fail isValidRouteTemplate() identically, but only the former is a security
 * boundary worth discarding the whole resource over — see #65.
 */
function isHostileRouteTemplate(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return true;
  }
  return decoded.includes('..') || decoded.includes('://');
}

export function validateForCatalog(paymentPayload, paymentRequirements) {
  const result = {
    hardDrop: false,
    reason: null,
    softDrops: [],
    resource: null,
  };

  // We rely on upstream extraction for base structure, then enforce our policy
  const extracted = extractDiscoveryInfo(paymentPayload, paymentRequirements, false);

  if (!extracted) {
    result.hardDrop = true;
    result.reason = 'missing_or_invalid_discovery_extension';
    return result;
  }

  // 1. extension validation (validate schema of bazaar.info)
  const rawBazaar = paymentPayload.extensions && paymentPayload.extensions['bazaar'];
  if (rawBazaar) {
    const schemaResult = validateDiscoveryExtension(rawBazaar);
    if (!schemaResult.valid) {
      result.hardDrop = true;
      result.reason = 'invalid_extension_schema';
      return result;
    }
  }

  // 2. routeTemplate validation
  //
  // Path traversal and protocol smuggling stay a hard drop — that is a real
  // security boundary (SSRF / traversal), not a quality issue. But a wildcard
  // ("*") route is low-quality discovery metadata, not a malformed or hostile
  // one: upstream's own SDK registers it by default and warns that it
  // degrades to auto-generated parameter names (var1, var2, ...) rather than
  // refusing to emit it. Hard-dropping the whole resource over that punishes
  // a seller for the stock SDK's defaults, so this is a soft drop instead —
  // the resource still lands, without the routeTemplate (extractDiscoveryInfo
  // above already leaves it undefined and falls back to the payment's own
  // resource URL), and the quality issue is surfaced via
  // softDrops/EXTENSION-RESPONSES so the seller can improve it. See #23 for
  // the soft-drop policy this stays consistent with, and #65 for the
  // decision.
  const rawTemplate = rawBazaar?.routeTemplate;
  if (rawTemplate !== undefined && !isValidRouteTemplate(rawTemplate)) {
    if (isHostileRouteTemplate(rawTemplate)) {
      result.hardDrop = true;
      result.reason = 'invalid_routeTemplate';
      return result;
    }
    result.softDrops.push('routeTemplate');
  }

  // 3. serviceName validation
  const rawServiceName = paymentPayload.resource?.serviceName;
  if (rawServiceName !== undefined) {
    if (!isValidServiceName(rawServiceName)) {
      result.softDrops.push('serviceName');
      delete extracted.serviceName;
    } else {
      extracted.serviceName = rawServiceName;
    }
  }

  // 4. iconUrl validation
  const rawIconUrl = paymentPayload.resource?.iconUrl;
  if (rawIconUrl !== undefined) {
    if (!isValidIconUrl(rawIconUrl)) {
      result.softDrops.push('iconUrl');
      delete extracted.iconUrl;
    } else {
      extracted.iconUrl = rawIconUrl;
    }
  }

  // 5. description validation and truncation
  const rawDesc = paymentPayload.resource?.description;
  if (typeof rawDesc === 'string') {
    let safeDesc = rawDesc.replace(/<[^>]*>?/gm, '').trim();
    if (safeDesc.length > 200) {
      safeDesc = safeDesc.substring(0, 200);
      result.softDrops.push('description_truncated');
    }
    extracted.description = safeDesc;
  }

  // 6. tags validation
  const rawTags = paymentPayload.resource?.tags;
  if (Array.isArray(rawTags)) {
    const cleanTags = sanitizeTags(rawTags);
    if (
      cleanTags.length !== rawTags.length ||
      JSON.stringify(cleanTags) !== JSON.stringify(rawTags)
    ) {
      result.softDrops.push('tags_filtered');
    }
    extracted.tags = cleanTags;
  }

  // Create final record shape expected by MemoryCatalogStore
  const record = {
    type: extracted.toolName ? 'mcp' : 'http',
    url: extracted.resourceUrl,
    toolName: extracted.toolName, // undefined for http
    serviceName: extracted.serviceName,
    description: extracted.description,
    tags: extracted.tags,
    iconUrl: extracted.iconUrl,
    scheme: extracted.discoveryInfo?.scheme,
    network: paymentRequirements.network,
    extensions: extracted.extensions,
    payTo: paymentRequirements.payTo,
  };

  result.resource = record;
  return result;
}
