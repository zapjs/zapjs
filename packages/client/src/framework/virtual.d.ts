/// <reference types="vite/client" />
/// <reference types="@vitejs/plugin-rsc/types" />
declare module 'zap:routes' {
  export const routes: import('./types.js').RuntimeRoute[];
  export const notFound: (() => Promise<import('./types.js').RouteModule>) | undefined;
}
declare module 'zap:config' { const config: import('./server.js').RuntimeConfig; export default config; }

declare module 'zap:build' { const buildId: string; export default buildId; }
