import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { HomePage, LoginPage, RecoverPage, ResetPage } from '~/page';

import * as path from './path-internal';
import { ProtectedRoute } from './protected-route';
import { UnprotectedRoute } from './unprotected-route';

export const AppRouter = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<UnprotectedRoute />}>
          <Route path={path.login()} element={<LoginPage />} />
          <Route path={path.recover()} element={<RecoverPage />} />
          <Route path={path.reset()} element={<ResetPage />} />
        </Route>

        <Route element={<ProtectedRoute />}>
          <Route path={path.home()} element={<HomePage />} />
          <Route path="*" element={<Navigate to={path.home()} replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
};
