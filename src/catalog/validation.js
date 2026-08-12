import {
  isValidRouteTemplate,
  isValidServiceName,
  isValidIconUrl,
  sanitizeTags,
  extractDiscoveryInfo,
  validateDiscoveryExtension,
} from '@x402/extensions';

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
  const rawTemplate = rawBazaar?.routeTemplate;
  if (rawTemplate !== undefined) {
    if (!isValidRouteTemplate(rawTemplate)) {
      result.hardDrop = true;
      result.reason = 'invalid_routeTemplate';
      return result;
    }
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
