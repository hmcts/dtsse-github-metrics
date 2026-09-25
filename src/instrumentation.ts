/**
 * Next.js's start-up hook, which does its work in the Node.js runtime only.
 *
 * NEXT COMPILES THIS FILE TWICE, once per runtime, because `proxy.ts` runs on the Edge. Everything the pod
 * does at start-up needs Node — `node:module`, `node:crypto`, `node:fs` and a Postgres pool — so the Edge copy
 * used to carry all of it and `next dev` printed a warning for every Node built-in on every recompile. Nothing
 * broke, because only the Node copy ever runs, but the warnings buried everything else in the output.
 *
 * `NEXT_RUNTIME` is replaced at build time, so in the Edge copy the dynamic import below is dead code and Next
 * drops it. That only holds if nothing Node-only is imported statically here, which is why this file imports
 * nothing and `instrumentation-node.ts` holds the rest.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node.ts");
    await registerNode();
  }
}
