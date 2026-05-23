import { defaultConfig } from "./defaults.ts";
import type { DeepPartial, ReviewgateConfig } from "./define-config.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// Recursively keep only what differs from `base`. Objects recurse (an empty diff
// is dropped); arrays + scalars + null compare whole and are emitted intact when
// they differ. Operates on two fully-resolved configs (no explicit-vs-omitted
// ambiguity). The result, fed back through defineConfig, reproduces the input.
// Precondition: value and base are both fully-resolved configs (same key set).
function diff(value: unknown, base: unknown): { changed: boolean; value: unknown } {
  if (isPlainObject(value) && isPlainObject(base)) {
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const k of Object.keys(value)) {
      const r = diff(value[k], base[k]);
      if (r.changed) {
        out[k] = r.value;
        changed = true;
      }
    }
    return { changed, value: out };
  }
  return { changed: !deepEqual(value, base), value };
}

export function diffFromDefaults(cfg: ReviewgateConfig): DeepPartial<ReviewgateConfig> {
  return diff(cfg, defaultConfig).value as DeepPartial<ReviewgateConfig>;
}
