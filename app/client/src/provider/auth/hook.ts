import { use } from 'react';

import { Context, type AuthContext } from './context';

export const useAuth = (): AuthContext => use(Context);
