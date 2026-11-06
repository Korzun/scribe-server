import { Navigate, Outlet, useLocation } from 'react-router';

import { LoadingPage } from '../page';
import { useAuth } from '../provider/auth';
import * as path from './path-internal';

export const UnprotectedRoute = () => {
  const { signedIn, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return <LoadingPage />;
  }
  // `from` is the FULL location `ProtectedRoute` redirected here with
  // (`state={{ from: location }}`) — pathname AND search, so a query string
  // survives the round trip through /login.
  const from = location.state?.from;
  // Guarded on `from?.pathname`, not just `from`: `state` is untrusted history
  // data, and `from` existing without a `pathname` would otherwise navigate to
  // the literal string "undefined" instead of falling back home.
  const destination = from?.pathname ? `${from.pathname}${from.search ?? ''}` : path.home();
  return signedIn ? <Navigate to={destination} replace /> : <Outlet />;
};
