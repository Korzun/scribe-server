---
description: How to run tests and lint for this project
---

# Scribe vault: Running Tests and Lint

## Tests

From the repo root, run both workspaces:

```bash
npm test
```

Or one at a time: server vitest runs from `app/server`, client vitest from `app/client`.

```bash
cd app/server && npm test
cd app/client && npm test
```

The dev-loop scripts have their own `node --test` suite:

```bash
npm run test:scripts
```

## Lint

**Always run from the repo root.** The project has two npm workspaces (`app/client` and `app/server`), each with its own lint config. Running from inside one workspace silently skips the other.

```bash
npm run lint
```

**Never** run `npm run lint` from `app/server` or `app/client` alone when changes span both — it will pass even if the other workspace has errors.

## Before pushing

Run all three from the root:

```bash
npm test
npm run lint
npm run test:scripts
```
