/**
 * ZapJS Production Router with Nested Layouts
 * 
 * Features:
 * - Nested layout support
 * - Route-level code splitting
 * - Error boundaries per route
 * - Suspense boundaries
 * - Type-safe navigation
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useTransition,
  Suspense,
  memo,
  type ReactNode,
  type ComponentType,
  type MouseEvent,
} from 'react';

// ============================================================================
// Types
// ============================================================================

export interface LayoutDefinition {
  path: string;
  component: React.LazyExoticComponent<ComponentType<any>>;
  parentLayout?: string;
}

export interface RouteDefinition {
  path: string;
  pattern: RegExp;
  paramNames: string[];
  component: React.LazyExoticComponent<ComponentType<any>>;
  layoutPath?: string;
  errorComponent?: React.LazyExoticComponent<ComponentType<any>>;
  pendingComponent?: React.LazyExoticComponent<ComponentType<any>>;
  meta?: () => Promise<RouteMeta>;
}

export interface RouteMeta {
  title?: string;
  description?: string;
  keywords?: string[];
  [key: string]: any;
}

export interface RouteMatch {
  route: RouteDefinition;
  params: Record<string, string>;
  pathname: string;
}

export interface RouterState {
  pathname: string;
  search: string;
  hash: string;
  match: RouteMatch | null;
}

export interface NavigateOptions {
  replace?: boolean;
  scroll?: boolean;
  state?: unknown;
}

export interface Router {
  push(path: string, options?: NavigateOptions): void;
  replace(path: string, options?: NavigateOptions): void;
  back(): void;
  forward(): void;
  refresh(): void;
  prefetch(path: string): void;
}

// ============================================================================
// Context
// ============================================================================

interface RouterContextValue {
  state: RouterState;
  router: Router;
  routes: RouteDefinition[];
  layouts: LayoutDefinition[];
  isPending: boolean;
}

const RouterContext = createContext<RouterContextValue | null>(null);

// ============================================================================
// Route Matching
// ============================================================================

function matchRoute(pathname: string, routes: RouteDefinition[]): RouteMatch | null {
  const normalizedPath = pathname === '' ? '/' : pathname;

  for (const route of routes) {
    const match = normalizedPath.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, index) => {
        const value = match[index + 1];
        if (value !== undefined && value !== '') {
          params[name] = decodeURIComponent(value);
        }
      });

      return { route, params, pathname: normalizedPath };
    }
  }

  return null;
}

function parseUrl(url: string): { pathname: string; search: string; hash: string } {
  try {
    const parsed = new URL(url, window.location.origin);
    return {
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
    };
  } catch {
    const hashIndex = url.indexOf('#');
    const searchIndex = url.indexOf('?');

    let pathname = url;
    let search = '';
    let hash = '';

    if (hashIndex !== -1) {
      hash = url.slice(hashIndex);
      pathname = url.slice(0, hashIndex);
    }

    if (searchIndex !== -1 && (hashIndex === -1 || searchIndex < hashIndex)) {
      search = pathname.slice(searchIndex, hashIndex !== -1 ? hashIndex - searchIndex : undefined);
      pathname = pathname.slice(0, searchIndex);
    }

    return { pathname: pathname || '/', search, hash };
  }
}

// ============================================================================
// Layout Wrapper Component
// ============================================================================

interface LayoutWrapperProps {
  layouts: LayoutDefinition[];
  layoutPath?: string;
  children: ReactNode;
}

const LayoutWrapper = memo(({ layouts, layoutPath, children }: LayoutWrapperProps) => {
  if (!layoutPath) {
    return <>{children}</>;
  }

  // Find the layout and build the chain
  const layoutChain: LayoutDefinition[] = [];
  let currentPath: string | undefined = layoutPath;

  while (currentPath) {
    const layout = layouts.find(l => l.path === currentPath);
    if (layout) {
      layoutChain.unshift(layout);
      currentPath = layout.parentLayout;
    } else {
      break;
    }
  }

  // Nest layouts
  return layoutChain.reduce<ReactNode>((content, layout) => {
    const LayoutComponent = layout.component;
    return (
      <Suspense fallback={<div>Loading layout...</div>}>
        <LayoutComponent>{content}</LayoutComponent>
      </Suspense>
    );
  }, children);
});

LayoutWrapper.displayName = 'LayoutWrapper';

// ============================================================================
// RouterProvider
// ============================================================================

interface RouterProviderProps {
  routes: RouteDefinition[];
  layouts?: LayoutDefinition[];
  children: ReactNode;
  notFound?: ComponentType;
  fallback?: ReactNode;
}

export function RouterProvider({
  routes,
  layouts = [],
  children,
  notFound: NotFound,
  fallback = null,
}: RouterProviderProps): JSX.Element {
  const [isPending, startTransition] = useTransition();

  const [state, setState] = useState<RouterState>(() => {
    const { pathname, search, hash } = parseUrl(window.location.href);
    return {
      pathname,
      search,
      hash,
      match: matchRoute(pathname, routes),
    };
  });

  const navigate = useCallback(
    (path: string, options: NavigateOptions = {}) => {
      const { replace = false, scroll = true } = options;
      const { pathname, search, hash } = parseUrl(path);

      const url = pathname + search + hash;
      if (replace) {
        window.history.replaceState(options.state ?? null, '', url);
      } else {
        window.history.pushState(options.state ?? null, '', url);
      }

      startTransition(() => {
        setState({
          pathname,
          search,
          hash,
          match: matchRoute(pathname, routes),
        });
      });

      if (scroll) {
        if (hash) {
          const element = document.querySelector(hash);
          element?.scrollIntoView();
        } else {
          window.scrollTo(0, 0);
        }
      }
    },
    [routes]
  );

  const router = useMemo<Router>(
    () => ({
      push: (path, options) => navigate(path, options),
      replace: (path, options) => navigate(path, { ...options, replace: true }),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      refresh: () => {
        startTransition(() => {
          setState((prev) => ({ ...prev, match: matchRoute(prev.pathname, routes) }));
        });
      },
      prefetch: (path) => {
        const { pathname } = parseUrl(path);
        const match = matchRoute(pathname, routes);
        if (match?.route.component) {
          const component = match.route.component as any;
          if (component._payload && component._init) {
            try {
              component._init(component._payload);
            } catch {
              // Component will load when rendered
            }
          }
        }
      },
    }),
    [navigate, routes]
  );

  useEffect(() => {
    const handlePopState = () => {
      const { pathname, search, hash } = parseUrl(window.location.href);
      startTransition(() => {
        setState({
          pathname,
          search,
          hash,
          match: matchRoute(pathname, routes),
        });
      });
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [routes]);

  // Update document meta on route change
  useEffect(() => {
    if (state.match?.route.meta) {
      state.match.route.meta().then((meta) => {
        if (meta.title) {
          document.title = meta.title;
        }
        if (meta.description) {
          const metaDesc = document.querySelector('meta[name="description"]');
          if (metaDesc) {
            metaDesc.setAttribute('content', meta.description);
          }
        }
      }).catch(() => {
        // Ignore meta errors
      });
    }
  }, [state.match]);

  const contextValue = useMemo<RouterContextValue>(
    () => ({
      state,
      router,
      routes,
      layouts,
      isPending,
    }),
    [state, router, routes, layouts, isPending]
  );

  return (
    <RouterContext.Provider value={contextValue}>
      <Suspense fallback={fallback}>
        {children}
      </Suspense>
    </RouterContext.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

export function useRouter(): Router {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('useRouter must be used within a RouterProvider');
  }
  return context.router;
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('useParams must be used within a RouterProvider');
  }
  return (context.state.match?.params ?? {}) as T;
}

export function usePathname(): string {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('usePathname must be used within a RouterProvider');
  }
  return context.state.pathname;
}

export function useSearchParams(): [URLSearchParams, (params: Record<string, string>) => void] {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('useSearchParams must be used within a RouterProvider');
  }

  const searchParams = useMemo(
    () => new URLSearchParams(context.state.search),
    [context.state.search]
  );

  const setSearchParams = useCallback(
    (params: Record<string, string>) => {
      const newParams = new URLSearchParams(params);
      const newSearch = newParams.toString();
      const path = context.state.pathname + (newSearch ? `?${newSearch}` : '') + context.state.hash;
      context.router.push(path, { scroll: false });
    },
    [context.router, context.state.pathname, context.state.hash]
  );

  return [searchParams, setSearchParams];
}

export function useRouteMatch(): RouteMatch | null {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('useRouteMatch must be used within a RouterProvider');
  }
  return context.state.match;
}

export function useIsPending(): boolean {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('useIsPending must be used within a RouterProvider');
  }
  return context.isPending;
}

// ============================================================================
// Link Component
// ============================================================================

export interface LinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  replace?: boolean;
  prefetch?: boolean;
  scroll?: boolean;
  children: ReactNode;
}

export function Link({
  to,
  replace = false,
  prefetch = true,
  scroll = true,
  children,
  onClick,
  onMouseEnter,
  ...props
}: LinkProps): JSX.Element {
  const context = useContext(RouterContext);

  const handleClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);

      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }

      const href = to;
      if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) {
        return;
      }

      e.preventDefault();
      context?.router[replace ? 'replace' : 'push'](to, { scroll });
    },
    [context?.router, to, replace, scroll, onClick]
  );

  const handleMouseEnter = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      onMouseEnter?.(e);
      if (prefetch && context) {
        context.router.prefetch(to);
      }
    },
    [context, to, prefetch, onMouseEnter]
  );

  return (
    <a
      href={to}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      {...props}
    >
      {children}
    </a>
  );
}

// ============================================================================
// Route Outlet with Layout Support
// ============================================================================

interface OutletProps {
  notFound?: ComponentType;
  fallback?: ReactNode;
}

export function Outlet({ notFound: NotFound, fallback = null }: OutletProps): JSX.Element | null {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('Outlet must be used within a RouterProvider');
  }

  const { match } = context.state;

  if (!match) {
    return NotFound ? <NotFound /> : null;
  }

  const { route, params } = match;
  const Component = route.component;
  const ErrorComponent = route.errorComponent;
  const PendingComponent = route.pendingComponent;

  const routeElement = (
    <Suspense fallback={PendingComponent ? <PendingComponent /> : fallback}>
      <Component params={params} />
    </Suspense>
  );

  const wrappedElement = (
    <LayoutWrapper
      layouts={context.layouts}
      layoutPath={route.layoutPath}
    >
      {ErrorComponent ? (
        <RouteErrorBoundary fallback={<ErrorComponent />}>
          {routeElement}
        </RouteErrorBoundary>
      ) : routeElement}
    </LayoutWrapper>
  );

  return wrappedElement;
}

// ============================================================================
// Error Boundary
// ============================================================================

interface RouteErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

interface RouteErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class RouteErrorBoundary extends React.Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  constructor(props: RouteErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Route error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

// ============================================================================
// NavLink Component
// ============================================================================

interface NavLinkProps extends LinkProps {
  activeClassName?: string;
  activeStyle?: React.CSSProperties;
  exact?: boolean;
  pending?: boolean;
  pendingClassName?: string;
  pendingStyle?: React.CSSProperties;
}

export function NavLink({
  to,
  activeClassName,
  activeStyle,
  exact = false,
  pending = false,
  pendingClassName,
  pendingStyle,
  className,
  style,
  ...props
}: NavLinkProps): JSX.Element {
  const pathname = usePathname();
  const isPending = useIsPending();

  const isActive = exact
    ? pathname === to
    : pathname.startsWith(to) && (to === '/' ? pathname === '/' : true);

  const isPendingRoute = pending && isPending;

  const combinedClassName = [
    className,
    isActive && activeClassName,
    isPendingRoute && pendingClassName,
  ].filter(Boolean).join(' ').trim() || undefined;

  const combinedStyle = {
    ...style,
    ...(isActive ? activeStyle : {}),
    ...(isPendingRoute ? pendingStyle : {}),
  };

  return (
    <Link
      to={to}
      className={combinedClassName}
      style={combinedStyle}
      {...props}
    />
  );
}

// ============================================================================
// Redirect Component
// ============================================================================

interface RedirectProps {
  to: string;
  replace?: boolean;
}

export function Redirect({ to, replace = true }: RedirectProps): null {
  const router = useRouter();

  useEffect(() => {
    router[replace ? 'replace' : 'push'](to);
  }, [router, to, replace]);

  return null;
}