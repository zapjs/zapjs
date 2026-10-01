import { matchRoute } from './match.js';
import type { RuntimeRoute } from './types.js';

/** Enumerate only paths whose winning route explicitly opted into public rendering. */
export async function enumeratePrerenderPaths(routes: RuntimeRoute[]): Promise<string[]> {
  const paths = new Set<string>();
  for (const route of routes) {
    if (!route.prerender) continue;
    if (route.kind !== 'page') throw new Error(`prerender is only supported for pages: ${route.id}`);
    const module = await route.load();
    const dynamic = route.segments.some(segment => segment.kind !== 'static');
    if (dynamic && typeof module.generateStaticParams !== 'function') throw new Error(`${route.id} needs generateStaticParams for prerender`);
    const parameters = dynamic ? await module.generateStaticParams() : [{}];
    if (!Array.isArray(parameters) || parameters.length > 10000) throw new Error(`Invalid static parameters for ${route.id}`);
    for (const params of parameters) {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error(`Invalid static parameters for ${route.id}`);
      const parts: string[] = [];
      for (const segment of route.segments) {
        if (segment.kind === 'static') { parts.push(encodeURIComponent(segment.value)); continue; }
        const value = params[segment.value];
        if (segment.kind === 'optional' && value === undefined) continue;
        const values = segment.kind === 'dynamic' ? [value] : value;
        if (!Array.isArray(values) || (segment.kind !== 'optional' && !values.length) || values.some(item => typeof item !== 'string' || !item || /[\/\\]/.test(item) || item === '.' || item === '..')) throw new Error(`Invalid ${segment.value} static parameter for ${route.id}`);
        parts.push(...values.map(encodeURIComponent));
      }
      const path = '/' + parts.join('/');
      const winner = matchRoute(routes, path)?.route;
      if (winner !== route) throw new Error(`Cannot prerender ${path} from ${route.id}: it matches ${winner?.id ?? 'no route'}`);
      paths.add(path);
      if (paths.size > 10000) throw new Error('Prerender exceeds 10000 routes');
    }
  }
  return [...paths];
}
