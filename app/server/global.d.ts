// TypeScript 7 no longer auto-includes every `@types/*` package, so Node's
// globals (`process`, `URL`, ...) only appear once something imports a
// module that pulls `@types/node` in transitively. Name it explicitly so the
// build's type-check does not depend on which files happen to exist yet.
/// <reference types="node" />

export {};
