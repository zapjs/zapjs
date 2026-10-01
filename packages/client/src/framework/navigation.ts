/** Validate before any location.assign fallback: it executes javascript: URLs. */
export function navigationURL(href: string, base: string): URL {
  const url = new URL(href, base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`Unsupported navigation protocol: ${url.protocol}`);
  return url;
}
