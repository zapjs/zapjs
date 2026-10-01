/** Flight is selected only when explicitly accepted and preferred to HTML. */
export function acceptsFlight(accept: string | null): boolean {
  const ranges = (accept ?? '').split(',').map(part => {
    const [media, ...parameters] = part.trim().toLowerCase().split(';');
    const quality = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    const raw = quality?.slice(2);
    const q = raw === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw) ? Number(raw) : 0;
    return { media: media.trim(), q };
  });
  const quality = (media: string) => {
    for (const pattern of [media, 'text/*', '*/*']) {
      const values = ranges.filter(range => range.media === pattern);
      if (values.length) return Math.max(...values.map(value => value.q));
    }
    return 0;
  };
  const flight = ranges.filter(range => range.media === 'text/x-component');
  return flight.length > 0 && quality('text/x-component') > 0 && quality('text/x-component') >= quality('text/html');
}

/** Create own properties even for query keys such as __proto__. */
export function searchParameters(search: URLSearchParams): Record<string, string | string[]> {
  return Object.fromEntries([...new Set(search.keys())].map(key => {
    const values = search.getAll(key);
    return [key, values.length > 1 ? values : values[0]];
  }));
}
