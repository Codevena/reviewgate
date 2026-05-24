// A locale-INDEPENDENT, deterministic string comparator. `String.localeCompare`
// depends on the active ICU locale (LANG/LC_COLLATE), so the same inputs sort
// differently across machines — and that order seeds aggregator clustering and
// the review cache key, which must be reproducible everywhere. JS `<`/`>` on
// strings compares by UTF-16 code unit: machine-independent and total.
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
