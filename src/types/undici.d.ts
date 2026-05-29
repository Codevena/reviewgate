// Minimal ambient types for the subset of `undici` we use. Bun bundles undici
// and resolves the bare "undici" specifier at runtime (verified end-to-end), but
// ships no type declarations for it, and we deliberately avoid adding a runtime
// dependency for a built-in. Declare only the surface src/core/brain/fetcher.ts
// touches: the Agent dispatcher (for connection IP-pinning) and undici's fetch.
declare module "undici" {
  interface AgentConnectOptions {
    lookup?: (
      hostname: string,
      options: unknown,
      callback: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void,
    ) => void;
  }
  export class Agent {
    constructor(opts?: { connect?: AgentConnectOptions });
    destroy(): Promise<void>;
  }
  export const fetch: typeof globalThis.fetch;
}
