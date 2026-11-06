import { buildProvidersTree } from './provider';
import { AuthProvider } from './provider/auth';
import { ThemeProvider } from './provider/theme';
import { ToastProvider } from './provider/toast';
import { AppRouter } from './router/';

// `ThemeProvider` is first, so it renders outermost — `buildProvidersTree`
// nests each subsequent entry inside the previous one.
const ProvidersTree = buildProvidersTree([[ThemeProvider], [AuthProvider], [ToastProvider]]);

export const App = () => (
  <ProvidersTree>
    <AppRouter />
  </ProvidersTree>
);
