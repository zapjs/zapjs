/**
 * @zap-js/client
 *
 * ZapJS Client Package - TypeScript Declarations
 * Runtime utilities and router for ZapJS applications
 */

/**
 * RPC call function for internal use
 * @internal - Use rpc.call from @zap-js/server instead
 */
export declare function rpcCall<T = unknown>(
  functionName: string,
  params?: Record<string, unknown>
): Promise<T>;

/**
 * Types namespace
 */
export declare const types: {
  [key: string]: any;
};

/**
 * Router Link component
 */
export declare function Link(props: {
  to: string;
  replace?: boolean;
  children?: React.ReactNode;
  className?: string;
  [key: string]: any;
}): JSX.Element;

/**
 * Router NavLink component with active state
 */
export declare function NavLink(props: {
  to: string;
  activeClassName?: string;
  replace?: boolean;
  children?: React.ReactNode;
  className?: string;
  [key: string]: any;
}): JSX.Element;

/**
 * Router hooks
 */
export declare function useRouter(): {
  push(path: string): void;
  replace(path: string): void;
  back(): void;
  forward(): void;
  prefetch(path: string): void;
};

export declare function usePathname(): string;

export declare function useParams<T extends Record<string, string> = Record<string, string>>(): T;

export declare function useSearchParams(): [
  URLSearchParams,
  (params: URLSearchParams | Record<string, string>) => void
];

/**
 * Router provider component
 */
export declare function RouterProvider(props: {
  children: React.ReactNode;
}): JSX.Element;

/**
 * Outlet component for nested routes
 */
export declare function Outlet(): JSX.Element;

/**
 * Error boundary component
 */
export declare function ErrorBoundary(props: {
  fallback?: React.ComponentType<{ error: Error; reset: () => void }>;
  children: React.ReactNode;
}): JSX.Element;

/**
 * Hook to access route error
 */
export declare function useRouteError(): {
  error: Error;
  reset: () => void;
};

/**
 * Default error component
 */
export declare function DefaultErrorComponent(props: {
  error: Error;
  reset: () => void;
}): JSX.Element;

/**
 * Router namespace - all router exports in one place
 */
export declare const router: {
  Link: typeof Link;
  NavLink: typeof NavLink;
  useRouter: typeof useRouter;
  usePathname: typeof usePathname;
  useParams: typeof useParams;
  useSearchParams: typeof useSearchParams;
  RouterProvider: typeof RouterProvider;
  Outlet: typeof Outlet;
  ErrorBoundary: typeof ErrorBoundary;
  useRouteError: typeof useRouteError;
  DefaultErrorComponent: typeof DefaultErrorComponent;
};

/**
 * Errors namespace
 */
export declare const errors: {
  useRouteError: typeof useRouteError;
  ErrorBoundary: typeof ErrorBoundary;
  DefaultErrorComponent: typeof DefaultErrorComponent;
};
