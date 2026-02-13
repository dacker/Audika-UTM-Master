
export const splitUrl = (urlStr: string) => {
  if (!urlStr || typeof urlStr !== 'string') {
    return { cleanUrl: '', params: {} };
  }

  const trimmedUrl = urlStr.trim();
  let searchPart = '';
  let cleanUrl = trimmedUrl;

  // Remove fragment if present for param parsing
  const [urlWithoutFragment] = trimmedUrl.split('#');

  if (urlWithoutFragment.includes('?')) {
    // Standard URL with query parameters
    const queryIndex = urlWithoutFragment.indexOf('?');
    cleanUrl = urlWithoutFragment.substring(0, queryIndex);
    searchPart = urlWithoutFragment.substring(queryIndex + 1);
  } else {
    // Check if it's a "naked" query string (e.g., utm_source=google&utm_medium=cpc)
    // Heuristic: Contains '=' and either no dots/slashes or explicitly contains known UTM keys
    const hasEquals = urlWithoutFragment.includes('=');
    const hasStructure = urlWithoutFragment.includes('.') || urlWithoutFragment.includes('/');
    const isExplicitUtm = urlWithoutFragment.toLowerCase().includes('utm_');

    if (hasEquals && (!hasStructure || isExplicitUtm)) {
      searchPart = urlWithoutFragment;
      cleanUrl = '';
    }
  }

  const extractedParams: Record<string, string> = {};
  if (searchPart) {
    try {
      // URLSearchParams is natively order-agnostic
      const params = new URLSearchParams(searchPart);
      params.forEach((value, key) => {
        // Only set if key is valid
        if (key) {
          extractedParams[key] = value;
        }
      });
    } catch (e) {
      console.warn("Failed to parse query string:", searchPart);
    }
  }

  return {
    cleanUrl,
    params: extractedParams
  };
};

export const mergeUrl = (
  cleanUrl: string,
  parameters: Record<string, string>
) => {
  try {
    if (!cleanUrl && Object.keys(parameters).length === 0) return '';
    
    const params = new URLSearchParams();
    Object.entries(parameters).forEach(([key, value]) => {
      if (value && value.trim() !== '') {
        params.set(key, value);
      }
    });
    
    const queryString = params.toString();
    if (!cleanUrl) return queryString;

    return queryString ? `${cleanUrl}${cleanUrl.includes('?') ? '&' : '?'}${queryString}` : cleanUrl;
  } catch (e) {
    return cleanUrl;
  }
};
