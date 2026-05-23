# Contributing to Reviewgate

Thanks for your interest! Reviewgate is early-stage alpha, so the most useful
contributions right now are bug reports, real-world feedback, and small,
well-scoped fixes.

## Development setup

Runtime is **[Bun](https://bun.sh)** (Node 20+ only runs the compiled binary).

```bash
git clone https://github.com/Codevena/reviewgate.git
cd reviewgate
bun install
bun run dev <subcommand>   # run the CLI from source
```

## Before you open a PR

All four must be clean — CI enforces them:

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome check src tests
bun test            # full suite
bun run build       # compile single binary
```

Run the full `bun test` after changing any schema or config.

## Conventions

- Use `bun` / `bunx`, not `npm` / `node` / `npx`.
- zod schemas in `src/schemas/` are the source of truth for every persisted
  artifact — validate against them rather than hand-rolling shapes.
- **Verify provider changes against a real CLI**, not just stubs. `codex exec`
  must run in the foreground with stdin closed (`</dev/null`) or it hangs.
- `REVIEW_OUTPUT_SCHEMA` must stay OpenAI/codex strict-mode valid: every object
  needs `additionalProperties: false` and every key in `required`; express
  optional fields as nullable types, never by omission.

## Commit & PR

- Keep PRs focused; one logical change per PR.
- Describe what you changed and how you verified it (paste the relevant test /
  CLI output).
- This repo dogfoods itself — a `.reviewgate/` gate may review your diff.

## Reporting bugs

Open a [GitHub issue](https://github.com/Codevena/reviewgate/issues) with your
OS, Bun version, the command you ran, and the full output. For **security**
issues, follow [SECURITY.md](SECURITY.md) instead — do not file them publicly.
