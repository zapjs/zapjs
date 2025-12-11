/**
 * @zap-js/client/router
 * 
 * Clean router API with everything you need for routing
 */

import {
  RouterProvider,
  Link,
  NavLink,
  Outlet,
  Redirect,
  useRouter,
  useParams,
  usePathname,
  useSearchParams,
  useRouteMatch,
  useIsPending,
} from '../internal/runtime/src/router.js';

// Main router object with all functionality
const router = {
  // Provider component
  Provider: RouterProvider,
  
  // Components
  Link,
  NavLink,
  Outlet,
  Redirect,
  
  // Hooks
  useRouter,
  useParams,
  usePathname,
  useSearchParams,
  useRouteMatch,
  useIsPending,
};

export default router;