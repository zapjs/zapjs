import type { Route } from '../compiler/graph.js';
export type Params = Record<string, string | string[]>;
type RouteShape = Pick<Route, 'segments'>;
type Candidate<T> = { route: T; index: number };
type Trie<T> = { literals: Map<string, Trie<T>>; dynamic?: Trie<T>; terminal?: Candidate<T>; catchall?: Candidate<T>; optional?: Candidate<T>; first: number };
const compiled = new WeakMap<readonly RouteShape[], Trie<RouteShape>>();
const node = <T>(): Trie<T> => ({ literals: new Map(), first: Infinity });

/** Route arrays are immutable graph snapshots; HMR replaces the snapshot. */
function compile<T extends RouteShape>(routes: readonly T[]): Trie<T> {
  const cached = compiled.get(routes);
  if (cached) return cached as Trie<T>;
  const root = node<T>();
  routes.forEach((route, index) => {
    const candidate = { route, index };
    let current = root;
    current.first = Math.min(current.first, index);
    for (const segment of route.segments) {
      if (segment.kind === 'catchall' || segment.kind === 'optional') {
        current[segment.kind] ??= candidate;
        return;
      }
      if (segment.kind === 'dynamic') current = current.dynamic ??= node<T>();
      else {
        let child = current.literals.get(segment.value);
        if (!child) current.literals.set(segment.value, child = node<T>());
        current = child;
      }
      current.first = Math.min(current.first, index);
    }
    current.terminal ??= candidate;
  });
  compiled.set(routes, root);
  return root;
}

export function matchRoute<T extends RouteShape>(routes: readonly T[], pathname: string): { route: T; params: Params } | undefined {
  let parts: string[];
  try { parts = pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return; }
  if (parts.some(part => part.includes('/') || part.includes('\\') || part === '.' || part === '..')) return;
  let best: Candidate<T> | undefined;
  const consider = (candidate: Candidate<T> | undefined) => {
    if (candidate && (!best || candidate.index < best.index)) best = candidate;
  };
  const visit = (current: Trie<T>, offset: number): void => {
    if (best && current.first >= best.index) return;
    if (offset === parts.length) { consider(current.terminal); consider(current.optional); return; }
    consider(current.catchall);
    consider(current.optional);
    const literal = current.literals.get(parts[offset]);
    if (literal) visit(literal, offset + 1);
    if (current.dynamic) visit(current.dynamic, offset + 1);
  };
  visit(compile(routes), 0);
  if (!best) return;
  const route: T = best.route;
  const entries: [string, string | string[]][] = [];
  let offset = 0;
  for (const segment of route.segments) {
    if (segment.kind === 'catchall' || segment.kind === 'optional') { entries.push([segment.value, parts.slice(offset)]); break; }
    if (segment.kind === 'dynamic') entries.push([segment.value, parts[offset]]);
    offset++;
  }
  return { route, params: Object.fromEntries(entries) };
}
