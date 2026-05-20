# M3 Spikes — Summary

**Date:** 2026-05-20

| Spike | Question | Status | Outcome |
|---|---|---|---|
| SM3-1 | Does `web-tree-sitter` parse + query in Bun? | ✅ PASS | `web-tree-sitter@0.26.9` works in Bun: `await Parser.init(); const L = await Language.load("<grammar>.wasm"); const p = new Parser(); p.setLanguage(L); const tree = p.parse(code);`. Queries use `new Query(L, sexpr)` (NOT `L.query(...)`). `(function_declaration name:(identifier) @fn)` → function names; `(call_expression function:(identifier) @c)` → callees. Verified: extracted `["compareToken","helper"]` and callee `["helper"]` from a TS snippet. Node positions via `node.startPosition.row` / `endPosition.row` (0-based). `tree-sitter-typescript` ships `tree-sitter-typescript.wasm` + `tree-sitter-tsx.wasm`. |
| SM3-2 | Is `ripgrep` available for cross-file caller search? | ✅ PASS | `rg` 15.1.0 at `/opt/homebrew/bin/rg`. `rg -n --no-heading -w <symbol> <dir>` → `file:line:text`. JS fallback (recursive read + word match) when `rg` absent; local `rg` is not blocked by sandbox rules (sandbox mode is `off` in M1/M2). |
| SM3-3 | Can the `.wasm` grammars ship inside the `bun build --compile` binary? | ⚠ OPEN (resolve in Task 9) | `bun build --compile` does NOT auto-bundle the grammar `.wasm` files. Strategy: copy `node_modules/tree-sitter-*/**.wasm` into `dist/grammars/` during build and resolve relative to `dirname(process.execPath)`, with a `node_modules` fallback for `bun run dev`. If clean bundling fails, ship symbol-graph as dev/runtime-only and **degrade gracefully** (no symbol graph, no crash) in the compiled binary. `grammars.ts` (Task 2) + the build script (Task 9) implement and verify this. |

## Key implications
- The symbol graph is real and feasible (tree-sitter callees + ripgrep callers), feeding both `research.md` and symbol-relative finding signatures.
- The one true risk is wasm packaging in the compiled binary — handled with a fail-soft resolver + graceful degradation.

## Legend
- ✅ PASS — verified with the real tool
- ⚠ OPEN — strategy chosen; verified during the dependent build task
