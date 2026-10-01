import React from 'react';
import { createFromReadableStream, getClientEntryUrl } from '@vitejs/plugin-rsc/ssr';
import { renderToReadableStream } from 'react-dom/server.edge';
import { limitFlight, injectFlight } from './stream.js';
import type { FlightPayload } from './types.js';
import { RouterProvider } from './client.js';

export async function renderHTML(stream: ReadableStream<Uint8Array>, options: { signal: AbortSignal; formState?: FlightPayload['formState']; onError?: (error: unknown) => string }) {
  const [render, hydration] = limitFlight(stream, { signal: options.signal }).tee();
  let payload: Promise<FlightPayload> | undefined;
  function Root() {
    payload ??= createFromReadableStream<FlightPayload>(render);
    const value = React.use(payload);
    const url = new URL(value.url, 'http://zap.internal');
    const navigate = () => { throw new Error('Navigation cannot execute during server rendering'); };
    return <RouterProvider value={{ pathname: url.pathname, search: url.search, pending: false, push: navigate, replace: navigate, refresh: navigate, back: navigate }}>{value.root}</RouterProvider>;
  }
  const bootstrapScriptContent = `import(${JSON.stringify(getClientEntryUrl())})`;
  let html: ReadableStream<Uint8Array>;
  let status: number | undefined;
  try {
    html = await renderToReadableStream(<Root />, { bootstrapScriptContent, formState: options.formState, signal: options.signal, onError: options.onError });
  } catch (error) {
    if (options.signal.aborted) { await hydration.cancel(error); throw error; }
    status = 500;
    html = await renderToReadableStream(<html><body><noscript>Unable to render this page</noscript></body></html>, { signal: options.signal, bootstrapScriptContent: `self.__ZAP_CSR=1;${bootstrapScriptContent}` });
  }
  return { stream: injectFlight(html, hydration, { signal: options.signal }), status };
}
