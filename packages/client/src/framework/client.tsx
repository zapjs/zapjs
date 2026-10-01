'use client';
import React, { createContext, useContext } from 'react';
export interface Router { pathname: string; search: string; pending: boolean; push(href: string): void; replace(href: string): void; refresh(): void; back(): void }
const Context = createContext<Router | null>(null);
export const RouterProvider = Context.Provider;
export function useRouter(): Router {
  const router = useContext(Context);
  if (!router) throw new Error('Router hooks require the Zap application root');
  return router;
}
export function usePathname(): string { return useRouter().pathname; }
export function useSearchParams(): URLSearchParams { return new URLSearchParams(useRouter().search); }
export const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link(props, ref) { return <a {...props} ref={ref} />; });
export type { PageProps, LayoutProps, RouteHandler, RouteContext } from './types.js';
export type { Params } from './match.js';
