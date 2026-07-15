# Alpha.12 Benchmark v2 — Attempt 01 (non-authoritative)

Attempt 01 ran from commit
`5599f2c2c23d0e4dc73f0b3ad3dd16c087f88694` with compiled runner SHA-256
`c1678a9f50b6c95fe497678a28254cb25de9c12567f29f6248499e318124d4c4`.

The preregistered run completed 30 unique cases × 3 correlated repeats but exited
`4` because mandatory coverage was incomplete:

- aggregate panel coverage: `50%`;
- Codex reviewer coverage: `0/90`;
- Claude Code reviewer coverage: `90/90`;
- eligible critic coverage: `81/85`.

This attempt is preserved under the no-overwrite rerun policy. It is explicitly
**non-authoritative** and none of its precision, recall or false-positive values
may be used as an Alpha.12 headline.

Root-cause reproduction after the run showed that Codex loaded an ambient Vercel
MCP definition and exited with an MCP authentication error before reaching the
model. `codex exec --ignore-user-config` succeeded in the same fresh checkout.
The critic failures were three transient errors and one empty/unparseable result;
the pinned `deepseek/deepseek-v4-flash` → `alibaba` route passed a fresh probe.

Only the normalized result artifact is retained. No prompts, raw model transcripts,
credentials or request bodies are published.
