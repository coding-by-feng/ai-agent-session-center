// Type declarations for runtime-only ESM imports from the server module.
// The server runs as ESM but electron main process compiles to CJS.
// These declarations prevent TypeScript from following into server/ files.

declare module '../../server/index.js' {
  export function startServer(port?: number): Promise<number>
}

declare module '../server/index.js' {
  export function startServer(port?: number): Promise<number>
}
