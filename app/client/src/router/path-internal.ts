export const home = () => '/';
export const login = () => '/login';
/** Forgot password: sign in with a recovery code and choose a new password (Task 13). */
export const recover = () => '/recover';
/** Lost everything: the keys-lost reset that deletes the library (Task 13). */
export const reset = () => '/reset';
/** First run: a fresh vault with no library creates one from the browser. */
export const setup = () => '/setup';
/** OAuth consent for an MCP assistant (spec §10): the authorize endpoint sends the browser here. */
export const connect = () => '/connect';
