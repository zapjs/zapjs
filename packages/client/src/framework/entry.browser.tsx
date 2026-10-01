import React, { startTransition, useEffect, useState, useTransition } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { createFromReadableStream, createFromFetch, setServerCallback, createTemporaryReferenceSet, encodeReply } from '@vitejs/plugin-rsc/browser';
import { rscStream } from 'rsc-html-stream/client';
import { RouterProvider, type Router } from './client.js';
import { RouteBoundary } from './boundary.js';
import { navigationURL } from './navigation.js';
import type { FlightPayload } from './types.js';

async function main() {
  const initial = await createFromReadableStream<FlightPayload>(rscStream);
  let queuedPayload: FlightPayload | undefined;
  let setCurrentPayload: React.Dispatch<React.SetStateAction<FlightPayload>> | undefined;
  const update = (payload: FlightPayload) => {
    if (setCurrentPayload) setCurrentPayload(payload);
    else queuedPayload = payload;
  };
  let navigation: AbortController | undefined;
  let generation = 0;
  let transition = startTransition;
  async function navigate(href: string, historyMode?: 'push' | 'replace') {
    const url = navigationURL(href, location.href);
    if (url.origin !== location.origin) { location.assign(url.href); return; }
    navigation?.abort();
    const controller = new AbortController();
    navigation = controller;
    const current = ++generation;
    transition(async () => {
      try {
        const response = fetch(url, { headers: { accept: 'text/x-component', 'x-zap-build': initial.buildId }, signal: controller.signal });
        const result = await response;
        if (result.headers.has('x-zap-build') && result.headers.get('x-zap-build') !== initial.buildId) { location.assign(url.href); return; }
        if (!result.headers.get('content-type')?.startsWith('text/x-component')) { location.assign(url.href); return; }
        const payload = await createFromFetch<FlightPayload>(Promise.resolve(result));
        if (generation !== current) return;
        if (historyMode) history[historyMode === 'push' ? 'pushState' : 'replaceState']({}, '', url);
        update(payload);
        if (historyMode) requestAnimationFrame(() => url.hash ? document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView() : window.scrollTo(0, 0));
      } catch (error) {
        if (!controller.signal.aborted) { console.error('[zap] Navigation failed', error); location.assign(url.href); }
      }
    });
  }
  function Root() {
    const [payload, setPayload] = useState(() => queuedPayload ?? initial);
    queuedPayload = undefined;
    const [pending, begin] = useTransition();
    setCurrentPayload = setPayload;
    transition = begin;
    useEffect(() => {
      const pop = () => { void navigate(location.href); };
      const click = (event: MouseEvent) => {
        const target = event.target instanceof Element ? event.target.closest('a') : null;
        if (!(target instanceof HTMLAnchorElement) || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || target.hasAttribute('download') || target.target && target.target !== '_self' || target.dataset.zapReload !== undefined) return;
        const url = new URL(target.href);
        if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) return;
        if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
        event.preventDefault();
        void navigate(url.href, 'push');
      };
      window.addEventListener('popstate', pop);
      window.addEventListener('zap:refresh', pop);
      document.addEventListener('click', click);
      return () => { window.removeEventListener('popstate', pop); window.removeEventListener('zap:refresh', pop); document.removeEventListener('click', click); };
    }, []);
    const url = new URL(payload.url, location.origin);
    const router: Router = { pathname: url.pathname, search: url.search, pending, push: href => { void navigate(href, 'push'); }, replace: href => { void navigate(href, 'replace'); }, refresh: () => { void navigate(location.href); }, back: () => history.back() };
    return <RouterProvider value={router}><RouteBoundary document resetKey={payload.url}>{payload.root}</RouteBoundary></RouterProvider>;
  }
  setServerCallback(async (id, args) => {
    const actionGeneration = generation;
    const actionLocation = location.href;
    const temporaryReferences = createTemporaryReferenceSet();
    const body = await encodeReply(args, { temporaryReferences });
    const response = await fetch(actionLocation, { method: 'POST', headers: { accept: 'text/x-component', 'x-zap-action': id, 'x-zap-build': initial.buildId }, body });
    if (response.status === 409 && response.headers.has('x-zap-build')) { location.reload(); throw new Error('Deployment changed; reload before retrying the action'); }
    if (!response.headers.get('content-type')?.startsWith('text/x-component')) throw new Error(`Server action failed (HTTP ${response.status})`);
    const payload = await createFromFetch<FlightPayload>(Promise.resolve(response), { temporaryReferences });
    if (actionGeneration === generation && actionLocation === location.href) startTransition(() => update(payload));
    if (!payload.returnValue) throw new Error('Invalid server action response');
    if (!payload.returnValue.ok) throw Object.assign(new Error(payload.returnValue.data.message), { digest: payload.returnValue.data.digest });
    return payload.returnValue.data;
  });
  if ('__ZAP_CSR' in globalThis) createRoot(document).render(<Root />);
  else hydrateRoot(document, <Root />, { formState: initial.formState });
  if (import.meta.hot) import.meta.hot.on('rsc:update', () => { void navigate(location.href); });
}
void main().catch(error => {
  console.error('[zap] Hydration failed', error);
  createRoot(document).render(<html><body><main role="alert"><h1>Unable to load this page</h1><button onClick={() => location.reload()}>Reload</button></main></body></html>);
});
