// Single source of truth for Reviewgate's version. Derived from package.json so
// it tracks releases instead of drifting (it was hardcoded "0.1.0-m1" since M1).
// The version feeds the review cache key, so a release naturally invalidates the
// cache. `bun build --compile` embeds JSON imports into the binary, so this works
// in the compiled `dist/reviewgate` too (not just `bun test`/`bun run dev`).
import pkg from "../package.json";

export const RG_VERSION: string = pkg.version;
