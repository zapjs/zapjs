import type { ComponentType, ReactNode } from 'react';
import type { ReactFormState } from 'react-dom/client';
import type { Route } from '../compiler/graph.js';
import type { Params } from './match.js';
export interface PageProps { params: Params; searchParams: Record<string,string|string[]> }
export interface LayoutProps { children: ReactNode; params: Params }
export type RouteModule = { default?: ComponentType<any>; [method: string]: any };
export interface RuntimeLayer { key: string; layout?: () => Promise<RouteModule>; loading?: () => Promise<RouteModule>; error?: () => Promise<RouteModule> }
export type RuntimeRoute = Omit<Route, 'file' | 'layers'> & { load: () => Promise<RouteModule>; layers: RuntimeLayer[] };
export interface FlightPayload { buildId: string; root: ReactNode; url: string; formState?: ReactFormState; returnValue?: { ok: true; data: unknown } | { ok: false; data: { message: string; digest: string } } }
export interface RouteContext { params: Params }
export type RouteHandler = (request: Request, context: RouteContext) => Response | Promise<Response>;
