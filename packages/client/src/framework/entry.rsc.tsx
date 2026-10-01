import React, { Suspense } from 'react';
import { renderToReadableStream, createTemporaryReferenceSet, decodeReply, loadServerAction, decodeAction, decodeFormState } from '@vitejs/plugin-rsc/rsc/server';
import { routes, notFound } from 'zap:routes';
import runtimeConfig from 'zap:config';
import buildId from 'zap:build';
import { matchRoute } from './match.js';
import { acceptsFlight, searchParameters } from './http.js';
import { enumeratePrerenderPaths } from './prerender.js';
import { RouteBoundary } from './boundary.js';
import { reportError, actionFailure } from './errors.js';
import { handleRequest, authorizeAction, sealCookies } from './server.js';
import type { FlightPayload, RuntimeRoute, PageProps } from './types.js';

async function renderRoute(route: RuntimeRoute, props: PageProps): Promise<React.ReactNode> {
  const module = await route.load();
  if (!module.default) throw new Error(`Page ${route.id} must export a default React component`);
  const Page = module.default;
  const identity = `${route.id}:${JSON.stringify(props.params)}`;
  const resetKey = `${identity}:${JSON.stringify(props.searchParams)}`;
  let node: React.ReactNode = <Page {...props} key={identity} />;
  const layers = await Promise.all(route.layers.map(async layer => ({
    ...layer, modules: await Promise.all([layer.layout?.(), layer.loading?.(), layer.error?.()]),
  })));
  for (const layer of layers.reverse()) {
    const [layout, loading, error] = layer.modules;
    // Shared ancestors retain identity; changing a dynamic segment remounts only
    // that segment and its descendants, including their client component state.
    const names = [...layer.key.matchAll(/\[(?:\[)?(?:\.\.\.)?(\w+)\]/g)].map(match => match[1]);
    const params = Object.fromEntries(names.map(name => [name, props.params[name]]));
    const key = `${layer.key}:${JSON.stringify(params)}`;
    if (loading?.default) { const Loading = loading.default; node = <Suspense fallback={<Loading />} key={`loading:${key}`}>{node}</Suspense>; }
    if (error?.default) node = <RouteBoundary fallback={error.default} resetKey={resetKey} key={`error:${key}`}>{node}</RouteBoundary>;
    if (layout?.default) { const Layout = layout.default; node = <Layout params={params} key={`layout:${key}`}>{node}</Layout>; }
  }
  return node;
}

async function limitedActionRequest(request: Request): Promise<Request> {
  const limit = 1024 * 1024;
  if (Number(request.headers.get('content-length')) > limit) throw new Response('Action payload too large', { status: 413 });
  const reader = request.body?.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        request.signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); throw new Response('Action payload too large', { status: 413 }); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  return new Request(request.url, { method: 'POST', headers: request.headers, body, signal: request.signal });
}

export default async function fetchHandler(request: Request, internal?: { prerender?: boolean; onError?: (error: unknown) => void; onFlight?: (stream: ReadableStream<Uint8Array>) => void }): Promise<Response> {
  const url = new URL(request.url);
  const match = matchRoute(routes, url.pathname);
  const clientBuild = request.headers.get('x-zap-build');
  if (clientBuild && clientBuild !== buildId && (request.headers.has('x-zap-action') || acceptsFlight(request.headers.get('accept')))) return new Response('Deployment changed; reload before retrying', { status: 409, headers: { 'x-zap-build': buildId, 'cache-control': 'no-store' } });
  const isAction = request.method === 'POST' && match?.route.kind === 'page';
  return handleRequest(request, async () => {
    request.signal.throwIfAborted();
    if (match?.route.kind === 'route') {
      const module = await match.route.load();
      const method = request.method === 'HEAD' && !module.HEAD ? 'GET' : request.method;
      const handler = module[method];
      if (typeof handler !== 'function') return new Response('Method Not Allowed', { status: 405, headers: { allow: Object.keys(module).filter(key => /^[A-Z]+$/.test(key)).join(', ') } });
      const response = await handler(request, { params: match.params });
      if (!(response instanceof Response)) throw new Error(`Route handler ${match.route.id} must return a Response`);
      return response;
    }
    if (!isAction && request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD, POST' } });
    let returnValue: FlightPayload['returnValue'];
    let formState: FlightPayload['formState'];
    let temporaryReferences: ReturnType<typeof createTemporaryReferenceSet> | undefined;
    let status = match ? 200 : 404;
    if (isAction) {
      if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') return new Response('Forbidden action origin', { status: 403 });
      const id = request.headers.get('x-zap-action');
      if (request.headers.has('x-zap-action') && (!id || id.length > 2048 || /[\x00-\x20]/.test(id))) return new Response('Invalid server action identifier', { status: 400 });
      await authorizeAction();
      const bounded = await limitedActionRequest(request);
      if (id) {
        const body = bounded.headers.get('content-type')?.startsWith('multipart/form-data') ? await bounded.formData() : await bounded.text();
        temporaryReferences = createTemporaryReferenceSet();
        const args = await decodeReply(body, { temporaryReferences });
        if (!Array.isArray(args)) return new Response('Invalid action arguments', { status: 400 });
        const action = await loadServerAction(id);
        try { returnValue = { ok: true, data: await action(...args) }; }
        catch (error) { returnValue = { ok: false, data: actionFailure(error) }; status = 500; }
      } else {
        const data = await bounded.formData();
        const action = await decodeAction(data);
        if (typeof action !== 'function') return new Response('Invalid server action', { status: 400 });
        formState = await decodeFormState(await action(), data);
      }
    }
    // Actions finish mutating before React schedules the new streamed render.
    sealCookies();
    const searchParams = searchParameters(url.searchParams);
    const root = match ? await renderRoute(match.route, { params: match.params, searchParams }) : notFound ? await renderRoute({ id: '__not-found', path: url.pathname, kind: 'page', segments: [], prerender: false, load: notFound, layers: routes[0]?.layers.slice(0, 1) ?? [] }, { params: {}, searchParams }) : <html><body><h1>404 — Page not found</h1></body></html>;
    const payload: FlightPayload = { buildId, root, url: url.pathname + url.search, returnValue, formState };
    const onError = (error: unknown) => { internal?.onError?.(error); return reportError(error); };
    let stream = renderToReadableStream(payload, { temporaryReferences, signal: request.signal, onError });
    if (internal?.onFlight) { const [render, capture] = stream.tee(); stream = render; internal.onFlight(capture); }
    const headers = new Headers({ 'x-zap-build': buildId, vary: 'Accept', 'cache-control': internal?.prerender ? 'public, max-age=0, must-revalidate' : 'private, no-store' });
    if (acceptsFlight(request.headers.get('accept'))) {
      headers.set('content-type', 'text/x-component; charset=utf-8');
      return new Response(stream, { status, headers });
    }
    const ssr = await import.meta.viteRsc.loadModule<typeof import('./entry.ssr.js')>('ssr', 'index');
    const result = await ssr.renderHTML(stream, { signal: request.signal, formState, onError });
    headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(result.stream, { status: result.status ?? status, headers });
  }, { mode: isAction ? 'action' : match?.route.kind === 'route' ? 'route' : 'render', prerender: internal?.prerender }, runtimeConfig).catch(error => {
    if (error instanceof Response) return error;
    if (request.signal.aborted) throw error;
    const digest = reportError(error);
    return new Response('Internal Server Error', { status: 500, headers: { 'x-zap-error': digest } });
  });
}
if (import.meta.hot) import.meta.hot.accept();

/** Enumerate only explicit public build-time routes. */
export function prerenderEntries(): Promise<string[]> { return enumeratePrerenderPaths(routes); }
