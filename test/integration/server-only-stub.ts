// Stands in for `server-only` under Vitest. That package exists to fail a client-side import at build time; in a
// node test there is no client, and the real module would refuse the import outright.
export {};
