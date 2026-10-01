import { expect, test } from 'bun:test';
import { navigationURL } from './navigation.js';
import { enumeratePrerenderPaths } from './prerender.js';
import { matchRoute } from './match.js';
import { acceptsFlight, searchParameters } from './http.js';
import type { RuntimeRoute } from './types.js';

const base = 'https://example.com/products/42';
test('imperative navigation rejects executable and non-HTTP schemes before fallback', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '\njavascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd']) expect(() => navigationURL(href, base)).toThrow('Unsupported navigation');
  expect(navigationURL('../43', base).href).toBe('https://example.com/43');
  expect(navigationURL('https://other.example/path', base).origin).toBe('https://other.example');
});
function route(id: string, segments: RuntimeRoute['segments'], prerender: boolean, parameters?: unknown[]): RuntimeRoute {
  return { id, path: id, kind: 'page', segments, prerender, layers: [], load: async () => ({ generateStaticParams: () => parameters }) };
}
test('dynamic prerender may not publish a higher-priority route that never opted in', async () => {
  const routes = [route('/admin', [{kind:'static',value:'admin'}], false), route('/[id]', [{kind:'dynamic',value:'id'}], true, [{id:'admin'}])];
  await expect(enumeratePrerenderPaths(routes)).rejects.toThrow('it matches /admin');
  routes[1].load = async () => ({generateStaticParams:()=>[{id:'article'}]});
  expect(await enumeratePrerenderPaths(routes)).toEqual(['/article']);
});
test('optional catchall cannot prerender the separately owned index route', async () => {
  const routes = [route('/', [], false), route('/[[...path]]', [{kind:'optional',value:'path'}], true, [{}])];
  await expect(enumeratePrerenderPaths(routes)).rejects.toThrow('it matches /');
});
test('special parameter names preserve object prototype and own values', () => {
  for (const kind of ['dynamic','catchall'] as const) {
    const result = matchRoute([route('test', [{kind,value:'__proto__'}], false)], '/hello')!;
    expect(Object.getPrototypeOf(result.params)).toBe(Object.prototype);
    expect(Object.hasOwn(result.params,'__proto__')).toBe(true);
    expect(result.params.__proto__).toEqual(kind === 'dynamic' ? 'hello' : ['hello']);
  }
});
test('Flight negotiation honors rejection, HTML preference and explicit media types', () => {
  for (const accept of [null, '*/*', 'text/html', 'text/x-component;q=0,text/html', 'text/x-component;q=0.2,text/html;q=0.8', 'text/x-component;q=0.2,*/*', 'text/x-component;q=2']) expect(acceptsFlight(accept)).toBe(false);
  for (const accept of ['text/x-component', 'TEXT/X-COMPONENT; q=1', 'text/x-component,text/html', 'text/html;q=0,text/x-component;q=0.3,*/*']) expect(acceptsFlight(accept)).toBe(true);
});

test('query records preserve special keys without invoking prototype setters', () => {
  const query = searchParameters(new URLSearchParams('__proto__=a&__proto__=b&constructor=c'));
  expect(Object.getPrototypeOf(query)).toBe(Object.prototype);
  expect(Object.hasOwn(query,'__proto__')).toBe(true);
  expect(query.__proto__).toEqual(['a','b']);
  expect(query.constructor).toBe('c');
});
