import { Navigate, Outlet, useLocation } from 'react-router';

import { LoadingPage } from '../page';
import { useAuth } from '../provider/auth';
import * as path from './path-internal';

export const ProtectedRoute = () => {
  const { signedIn, loading } = useAuth();
  const location = useLocation();
  if (!signedIn && loading) {
    return <LoadingPage />;
  }
  if (!signedIn) {
    return <Navigate to={path.login()} state={{ from: location }} replace />;
  }
  return <Outlet />;
};
