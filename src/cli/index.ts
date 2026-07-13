// src/cli/index.ts
import { defineCommand, runMain } from "citty";
import { controlPlaneStatus } from "../config/control-plane.ts";
import type { AgentHostSelection } from "../hosts/hooks.ts";
import type { ProviderId } from "../providers/registry.ts";
import { RG_VERSION } from "../version.ts";
import { runAuditVerify } from "./commands/audit.ts";
import { runBenchMatrix, runBenchReport, runBenchRun } from "./commands/bench.ts";
import { runBrainList, runBrainRevoke, runBrainShow } from "./commands/brain.ts";
import { formatControlPlaneStatus, runConfigApprove, runConfigStatus } from "./commands/config.ts";
import { runDoctor } from "./commands/doctor.ts";
import {
  runFpAudit,
  runFpClusters,
  runFpList,
  runFpPin,
  runFpShow,
  runFpUnpin,
} from "./commands/fp.ts";
import { runGate, runGateSafe } from "./commands/gate.ts";
import { runInit } from "./commands/init.ts";
import { runLearnStatus } from "./commands/learn-status.ts";
import { runLoreStatus, runLoreVerify } from "./commands/lore.ts";
import { runPrePush } from "./commands/pre-push.ts";
import { runReport } from "./commands/report.ts";
import { runReset } from "./commands/reset.ts";
import { runReviewPlan } from "./commands/review-plan.ts";
import { runSetup } from "./commands/setup.ts";
import { runStats } from "./commands/stats.ts";
import { hookFeedbackMessage } from "./hook-feedback.ts";
import { readHookStdin } from "./hook-stdin.ts";
import { validateSince, validateWeek } from "./validate-time-args.ts";

/** Print a one-line CLI error to stderr and exit non-zero (no stack trace). */
function failArg(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

const init = defineCommand({
  meta: {
    name: "init",
    description: "Complete first-run setup: policy, agent hosts, hooks, LKG and health check",
  },
  args: {
    mode: { type: "string", default: "agent-loop" },
    host: {
      type: "string",
      description: "Agent host: claude, codex, or both (interactive default: prompt)",
    },
    quick: {
      type: "boolean",
      description: "Use the recommended policy preset without interactive policy questions",
    },
    "hooks-only": {
      type: "boolean",
      description: "Repair/reinstall host hooks without changing configuration",
    },
    "skip-doctor": {
      type: "boolean",
      description: "Skip the final health check",
    },
  },
  async run({ args }) {
    const rawHost = typeof args.host === "string" ? args.host : undefined;
    if (rawHost && rawHost !== "claude" && rawHost !== "codex" && rawHost !== "both") {
      failArg(`invalid --host "${rawHost}": expected claude, codex, or both`);
    }
    const host = rawHost as AgentHostSelection | undefined;
    if (args["hooks-only"] === true) {
      const result = await runInit({
        repoRoot: process.cwd(),
        mode: args.mode as "agent-loop",
        host: host ?? "both",
      });
      process.stdout.write(
        `Reviewgate hooks installed for ${result.installedHosts.join(" + ")}.\n` +
          `${result.prePushHook.installed ? "✔" : "ℹ"} pre-push: ${result.prePushHook.note}\n`,
      );
      for (const warning of result.warnings) process.stdout.write(`⚠ ${warning}\n`);
      if (result.installedHosts.includes("codex")) {
        process.stdout.write(
          "Codex activation: start or restart Codex in this repo, open `/hooks`, inspect SessionStart/PostToolUse/Stop, and trust their exact current hash. Installation alone does not activate new project hooks.\n",
        );
      }
      return;
    }

    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    process.exit(
      await runSetup({
        repoRoot: process.cwd(),
        install: true,
        projectOnly: true,
        commandName: "reviewgate init",
        quick: args.quick === true || !interactive,
        keepExistingOnQuick: !interactive,
        skipDoctor: args["skip-doctor"] === true,
        ...(host ? { host } : {}),
      }),
    );
  },
});

const gate = defineCommand({
  meta: { name: "gate", description: "Run the review gate (internal hook entry point)" },
  args: { hook: { type: "string", default: "stop" } },
  async run({ args }) {
    const hook = args.hook as "trigger" | "stop" | "reset";
    // Backstop (M-A0.1): a truly uncaught exception (Node/Bun's default is to
    // terminate the process → EMPTY stdout → Claude Code reads the Stop hook as
    // "allow" → un-reviewed turn = fail-OPEN). For a STOP hook, intercept it and
    // emit a block instead (fail CLOSED — strictly better than dying silently).
    // Only for `stop`; trigger/reset are not the review and must not block.
    if (hook === "stop") {
      const failClosed = (err: unknown): never => {
        const msg = err instanceof Error ? err.message : String(err);
        const reason = `🔴 Reviewgate · GATE CLOSED — internal error: ${msg}. Run \`reviewgate doctor\`; end your turn again to retry.`;
        try {
          process.stdout.write(JSON.stringify({ decision: "block", reason }));
        } catch {
          /* stdout gone — nothing more we can do */
        }
        process.exit(0);
      };
      process.on("uncaughtException", failClosed);
      // Mirror the uncaughtException backstop for a rejected fire-and-forget promise
      // (no .catch()). Without this, an unhandled rejection terminates the process
      // with EMPTY stdout → Claude Code reads the Stop hook as "allow" → the turn
      // ends UN-reviewed = fail-OPEN, exactly what this gate prevents. Fail CLOSED.
      process.on("unhandledRejection", failClosed);
    }
    // runGateSafe wraps the WHOLE pipeline (incl. readHookStdin) in a
    // fail-closed catch so no awaited throw can escape to citty. Never block on
    // an interactive TTY — only the piped hook payload is read (see readHookStdin).
    const res = await runGateSafe({ repoRoot: process.cwd(), hook, hookStdinRaw: "" }, async () => {
      const raw = await readHookStdin();
      return runGate({ repoRoot: process.cwd(), hook, hookStdinRaw: raw });
    });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    // Interactive-only confirmation (a human running the hook by hand); silent
    // under a real piped hook so the hook protocol is never polluted.
    const feedback = hookFeedbackMessage(hook, Boolean(process.stdout.isTTY));
    if (feedback) process.stdout.write(`${feedback}\n`);
    process.exit(res.exitCode);
  },
});

const prePush = defineCommand({
  meta: {
    name: "pre-push",
    description:
      "Git pre-push hook entry point: WARN (never block) when the pushed commit has no recorded clean Reviewgate PASS.",
  },
  async run() {
    // git feeds the pre-push hook its ref lines on stdin; read them (best-effort —
    // a TTY/no-stdin invocation just yields no shas → no warning). Always exit 0.
    const raw = await readHookStdin();
    const res = await runPrePush({ repoRoot: process.cwd(), stdinRaw: raw });
    if (res.stderr) process.stderr.write(res.stderr);
    process.exit(res.exitCode);
  },
});

const doctor = defineCommand({
  meta: { name: "doctor", description: "Health-check Reviewgate dependencies" },
  async run() {
    const exitCode = await runDoctor({ repoRoot: process.cwd() });
    process.exit(exitCode);
  },
});

const config = defineCommand({
  meta: { name: "config", description: "Inspect and approve the gate policy control plane" },
  subCommands: {
    status: defineCommand({
      meta: {
        name: "status",
        description: "Show approved and pending gate-policy fingerprints",
      },
      async run() {
        const result = await runConfigStatus(process.cwd());
        process.stdout.write(result.stdout);
        process.exit(result.exitCode);
      },
    }),
    approve: defineCommand({
      meta: {
        name: "approve",
        description: "Explicitly approve a policy candidate after its last-known-good review",
      },
      async run() {
        // No --yes escape hatch: this forces an interactive checkpoint on the
        // normal Claude Code Bash path. It is intentionally procedural, not a
        // cryptographic identity boundary against same-user shell/state access;
        // SECURITY.md documents that limit explicitly.
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          process.stderr.write(
            "Error: policy approval requires a real interactive terminal (TTY); no non-interactive override exists.\n",
          );
          process.exit(1);
        }
        const status = await controlPlaneStatus(process.cwd());
        process.stdout.write(`${formatControlPlaneStatus(status)}\n`);
        if (!status.challenge) {
          process.stdout.write(
            status.state?.pending
              ? "This candidate is not eligible for human approval yet; follow the Next step above.\n"
              : "No policy change requires approval.\n",
          );
          process.exit(0);
        }
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await rl.question(`Type exactly \"${status.challenge}\" to approve: `);
          const result = await runConfigApprove(process.cwd(), answer.trim());
          process.stdout.write(result.stdout);
          process.exit(result.exitCode);
        } finally {
          rl.close();
        }
      },
    }),
  },
});

const reset = defineCommand({
  meta: {
    name: "reset",
    description:
      "Re-arm the gate: clear this session's review state (pending findings, decisions, escalation, session state). Learned memory (FP-ledger, brain) is preserved.",
  },
  async run() {
    // No stdin read, no --hook: this is the user-facing alias for the
    // SessionStart reset path. Shares handleReset → 1:1 parity.
    process.exit(await runReset({ repoRoot: process.cwd() }));
  },
});

const audit = defineCommand({
  meta: { name: "audit", description: "Audit utilities" },
  subCommands: {
    verify: defineCommand({
      meta: {
        name: "verify",
        description: "Verify the audit log's hash chain is intact (tamper check)",
      },
      args: {
        file: {
          type: "string",
          required: true,
          description: "Audit .jsonl file to verify",
        },
      },
      async run({ args }) {
        const exitCode = await runAuditVerify({ file: args.file as string });
        process.exit(exitCode);
      },
    }),
  },
});

const reviewPlan = defineCommand({
  meta: {
    name: "review-plan",
    description: "Review a plan/spec markdown file (one-shot, committed or not)",
  },
  args: { file: { type: "positional", required: true, description: "Path(s) to plan file(s)" } },
  async run({ args }) {
    const files = (args._ ?? []).filter((s) => typeof s === "string" && s.length > 0);
    const res = await runReviewPlan({ repoRoot: process.cwd(), files });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    process.exit(res.exitCode);
  },
});

const brain = defineCommand({
  meta: { name: "brain", description: "Brain entry management" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List brain (repo-memory) entries by stage" },
      args: {
        filter: {
          type: "string",
          description: "Filter by stage (active|candidate|stale|archived)",
        },
      },
      async run({ args }) {
        const filter = typeof args.filter === "string" ? args.filter : undefined;
        const exitCode = await runBrainList({
          repoRoot: process.cwd(),
          ...(filter !== undefined ? { filter } : {}),
        });
        process.exit(exitCode);
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show a single brain entry by id" },
      args: {
        id: { type: "string", required: true, description: "Brain entry id (from `brain list`)" },
      },
      async run({ args }) {
        const exitCode = await runBrainShow({ repoRoot: process.cwd(), id: args.id as string });
        process.exit(exitCode);
      },
    }),
    revoke: defineCommand({
      meta: {
        name: "revoke",
        description: "Revoke (archive) a brain entry so it stops being recalled",
      },
      args: {
        id: { type: "string", required: true, description: "Brain entry id (from `brain list`)" },
      },
      async run({ args }) {
        const exitCode = await runBrainRevoke({ repoRoot: process.cwd(), id: args.id as string });
        process.exit(exitCode);
      },
    }),
  },
});

const lore = defineCommand({
  meta: {
    name: "lore",
    description: "Per-repo curated project knowledge (lore, draft->canon) inspection",
  },
  subCommands: {
    status: defineCommand({
      meta: {
        name: "status",
        description:
          "Read-only table of lore entries (id, status, state, anchors) + totals; exit 0 always",
      },
      async run() {
        process.exit(await runLoreStatus({ repoRoot: process.cwd() }));
      },
    }),
    verify: defineCommand({
      meta: {
        name: "verify",
        description:
          "Recompute verified_tree/verified_at for one or more lore entries (or --all) and write them back; exit 1 if any entry errors",
      },
      args: {
        slug: {
          type: "positional",
          required: false,
          description: "Lore entry id(s) to verify (omit when using --all)",
        },
        all: { type: "boolean", description: "Verify every entry under .reviewgate/lore/" },
      },
      async run({ args }) {
        const all = args.all === true;
        const slugs = (args._ ?? []).filter((s) => typeof s === "string" && s.length > 0);
        process.exit(
          await runLoreVerify({
            repoRoot: process.cwd(),
            all,
            slugs,
          }),
        );
      },
    }),
  },
});

const fp = defineCommand({
  meta: { name: "fp", description: "FP-ledger (known false positives) management" },
  subCommands: {
    list: defineCommand({
      meta: {
        name: "list",
        description: "List FP-ledger entries (known false positives) by stage",
      },
      args: {
        filter: { type: "string", description: "Filter by stage (candidate|active|sticky)" },
      },
      async run({ args }) {
        const filter = typeof args.filter === "string" ? args.filter : undefined;
        process.exit(
          await runFpList({ repoRoot: process.cwd(), ...(filter !== undefined ? { filter } : {}) }),
        );
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show a single FP-ledger entry by id" },
      args: {
        id: { type: "string", required: true, description: "FP id, e.g. FP-001 (from `fp list`)" },
      },
      async run({ args }) {
        process.exit(await runFpShow({ repoRoot: process.cwd(), id: args.id as string }));
      },
    }),
    pin: defineCommand({
      meta: {
        name: "pin",
        description: "Pin an entry as a sticky known-FP so matching findings are always suppressed",
      },
      args: {
        id: { type: "string", description: "FP id to pin, e.g. FP-001 (from `fp list`)" },
        signature: { type: "string", description: "Pin by signature instead of id" },
        by: { type: "string", description: "Who pinned it (recorded for audit)" },
      },
      async run({ args }) {
        process.exit(
          await runFpPin({
            repoRoot: process.cwd(),
            ...(typeof args.id === "string" ? { id: args.id } : {}),
            ...(typeof args.signature === "string" ? { signature: args.signature } : {}),
            ...(typeof args.by === "string" ? { by: args.by } : {}),
          }),
        );
      },
    }),
    unpin: defineCommand({
      meta: { name: "unpin", description: "Remove a pin so the entry reverts to its earned stage" },
      args: {
        id: { type: "string", required: true, description: "FP id to unpin, e.g. FP-001" },
      },
      async run({ args }) {
        process.exit(await runFpUnpin({ repoRoot: process.cwd(), id: args.id as string }));
      },
    }),
    audit: defineCommand({
      meta: {
        name: "audit",
        description: "Print FP-ledger health/stats (entries per stage, pins)",
      },
      async run() {
        process.exit(await runFpAudit({ repoRoot: process.cwd() }));
      },
    }),
    clusters: defineCommand({
      meta: {
        name: "clusters",
        description:
          "F3 Phase 1 — derived (rule_id_token0 × file) view over the FP ledger; read-only, no schema change. --file <substr> filters by path.",
      },
      args: { file: { type: "string" } },
      async run({ args }) {
        const file = typeof args.file === "string" ? args.file : undefined;
        process.exit(
          await runFpClusters({
            repoRoot: process.cwd(),
            ...(file !== undefined ? { file } : {}),
          }),
        );
      },
    }),
  },
});

const stats = defineCommand({
  meta: {
    name: "stats",
    description: "Show review stats (verdicts, cost, reviewers, learn-state)",
  },
  args: { since: { type: "string" }, last: { type: "string" }, json: { type: "boolean" } },
  async run({ args }) {
    const since = typeof args.since === "string" ? args.since : undefined;
    if (since !== undefined) {
      const err = validateSince(since);
      if (err) failArg(err);
    }
    const last = typeof args.last === "string" ? Number(args.last) : undefined;
    const output = await runStats({
      repoRoot: process.cwd(),
      ...(since !== undefined ? { since } : {}),
      ...(last !== undefined && Number.isFinite(last) ? { last } : {}),
      json: args.json === true,
    });
    process.stdout.write(`${output}\n`);
  },
});

const report = defineCommand({
  meta: {
    name: "report",
    description: "Generate a weekly review report (Markdown + .reviewgate/reports/<iso>.md)",
  },
  args: { week: { type: "string" }, json: { type: "boolean" } },
  async run({ args }) {
    const week = typeof args.week === "string" ? args.week : undefined;
    if (week !== undefined) {
      const err = validateWeek(week);
      if (err) failArg(err);
    }
    const output = await runReport({
      repoRoot: process.cwd(),
      ...(week !== undefined ? { week } : {}),
      json: args.json === true,
    });
    process.stdout.write(`${output}\n`);
  },
});

const setup = defineCommand({
  meta: {
    name: "setup",
    description: "Alias for the interactive init wizard; --global remains config-only",
  },
  args: {
    global: { type: "boolean" },
    print: { type: "boolean" },
    host: { type: "string", description: "Agent host: claude, codex, or both" },
    quick: { type: "boolean" },
    "skip-doctor": { type: "boolean" },
  },
  async run({ args }) {
    const rawHost = typeof args.host === "string" ? args.host : undefined;
    if (rawHost && rawHost !== "claude" && rawHost !== "codex" && rawHost !== "both") {
      failArg(`invalid --host "${rawHost}": expected claude, codex, or both`);
    }
    process.exit(
      await runSetup({
        repoRoot: process.cwd(),
        global: args.global === true,
        print: args.print === true,
        install: args.global !== true && args.print !== true,
        projectOnly: args.global !== true,
        commandName: "reviewgate setup",
        quick: args.quick === true,
        skipDoctor: args["skip-doctor"] === true,
        ...(rawHost ? { host: rawHost as AgentHostSelection } : {}),
      }),
    );
  },
});

const learn = defineCommand({
  meta: {
    name: "learn",
    description: "Self-learning subsystem status (brain, FP-ledger, reputation, proposal pools)",
  },
  subCommands: {
    status: defineCommand({
      meta: {
        name: "status",
        description:
          "Snapshot every self-learning subsystem: brain entries, cross-run candidates, F2 proposal pools, curator decisions, FP ledger + clusters, reviewer reputation. --since <ISO> defaults to 30d. --json for machine output.",
      },
      args: { since: { type: "string" }, json: { type: "boolean" } },
      async run({ args }) {
        const since = typeof args.since === "string" ? args.since : undefined;
        if (since !== undefined) {
          const err = validateSince(since);
          if (err) failArg(err);
        }
        process.exit(
          await runLearnStatus({
            repoRoot: process.cwd(),
            ...(since !== undefined ? { since } : {}),
            json: args.json === true,
          }),
        );
      },
    }),
  },
});

const bench = defineCommand({
  meta: {
    name: "bench",
    description: "Benchmark the reviewer panel against a labelled ground-truth corpus",
  },
  subCommands: {
    run: defineCommand({
      meta: {
        name: "run",
        description:
          "Run every case in a corpus and write a reviewgate.bench.result.v1 JSON (precision/recall/FP-rate + per-provider + provenance)",
      },
      args: {
        corpus: {
          type: "string",
          required: true,
          description: "Corpus directory (dir of case dirs)",
        },
        out: { type: "string", required: true, description: "Output results JSON path" },
        providers: {
          type: "string",
          description:
            "Comma-separated reviewer PANEL, e.g. codex,gemini,claude-code (1 vs. N reviewers). Omitted → single codex.",
        },
        window: { type: "string", description: "Line-match window radius (default 5)" },
        "include-advisory": {
          type: "boolean",
          description: "Fold INFO/advisory findings into scoring",
        },
        "no-cache": {
          type: "boolean",
          description:
            "No-op in P1: bench always measures cold (the review cache is force-disabled because a cache hit omits the per-provider raw layer). Accepted for forward-compat.",
        },
        "min-clean": { type: "string", description: "Quality-gate floor on scored clean cases" },
        "min-seeded": { type: "string", description: "Quality-gate floor on scored seeded cases" },
        "max-failed-frac": {
          type: "string",
          description: "Max review-error fraction before benchmark-invalid (default 0.1)",
        },
        repeat: {
          type: "string",
          description:
            "Run the corpus K times; report mean ± spread per metric (tames LLM variance)",
        },
        critic: {
          type: "string",
          description: "Enable the post-review LLM critic with this provider (e.g. openrouter)",
        },
        "no-scope-to-diff": {
          type: "boolean",
          description: "Ablation: score the whole file, not just changed hunks",
        },
        "confidence-floor": {
          type: "string",
          description: "Ablation: low-confidence demote floor (0 disables)",
        },
        "no-reputation": { type: "boolean", description: "Ablation: disable reputation demote" },
      },
      async run({ args }) {
        const num = (v: unknown): number | undefined => {
          if (typeof v !== "string" || v.length === 0) return undefined;
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        const providers =
          typeof args.providers === "string" && args.providers.length > 0
            ? (args.providers
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean) as ProviderId[])
            : undefined;
        const window = num(args.window);
        const minClean = num(args["min-clean"]);
        const minSeeded = num(args["min-seeded"]);
        const maxFailedFrac = num(args["max-failed-frac"]);
        const repeat = num(args.repeat);
        const confidenceFloor = num(args["confidence-floor"]);
        const suppressors = {
          ...(typeof args.critic === "string" && args.critic.length > 0
            ? { critic: args.critic.trim() as ProviderId }
            : {}),
          ...(confidenceFloor !== undefined ? { confidenceFloor } : {}),
          ...(args["no-scope-to-diff"] === true ? { scopeToDiff: false } : {}),
          ...(args["no-reputation"] === true ? { reputation: false } : {}),
        };
        const res = await runBenchRun({
          repoRoot: process.cwd(),
          corpus: args.corpus as string,
          out: args.out as string,
          ...(providers ? { providers } : {}),
          ...(window !== undefined ? { window } : {}),
          includeAdvisory: args["include-advisory"] === true,
          ...(minClean !== undefined ? { minClean } : {}),
          ...(minSeeded !== undefined ? { minSeeded } : {}),
          ...(maxFailedFrac !== undefined ? { maxFailedFrac } : {}),
          ...(repeat !== undefined ? { repeat } : {}),
          ...(Object.keys(suppressors).length > 0 ? { suppressors } : {}),
        });
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        process.exit(res.exitCode);
      },
    }),
    report: defineCommand({
      meta: {
        name: "report",
        description:
          "Render a saved bench results JSON to a terminal table + a paste-ready markdown block",
      },
      args: {
        file: { type: "positional", required: true, description: "Path to a results JSON" },
        markdown: { type: "boolean", description: "Print only the markdown block (for piping)" },
      },
      async run({ args }) {
        const res = await runBenchReport({
          repoRoot: process.cwd(),
          file: args.file as string,
          markdown: args.markdown === true,
        });
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        process.exit(res.exitCode);
      },
    }),
    matrix: defineCommand({
      meta: {
        name: "matrix",
        description:
          "Ablation: run the corpus with suppression layers toggled and print the per-layer Δ (spec §8 money-shot)",
      },
      args: {
        corpus: { type: "string", required: true, description: "Corpus directory" },
        out: { type: "string", required: true, description: "Output matrix JSON path" },
        ablate: {
          type: "string",
          required: true,
          description: "Comma-separated layers: critic,confidence-floor,reputation,scope-to-diff",
        },
        providers: {
          type: "string",
          description: "Reviewer panel, e.g. codex,gemini,claude-code (omitted → single codex)",
        },
        critic: {
          type: "string",
          description: "Critic provider enabled in the baseline (required to ablate `critic`)",
        },
        repeat: { type: "string", description: "Run each variant K times (mean pooled)" },
        window: { type: "string", description: "Line-match window radius (default 5)" },
        "include-advisory": { type: "boolean" },
      },
      async run({ args }) {
        const num = (v: unknown): number | undefined => {
          if (typeof v !== "string" || v.length === 0) return undefined;
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        const csv = (v: unknown): string[] =>
          typeof v === "string" && v.length > 0
            ? v
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [];
        const providers = csv(args.providers) as ProviderId[];
        const window = num(args.window);
        const repeat = num(args.repeat);
        const res = await runBenchMatrix({
          repoRoot: process.cwd(),
          corpus: args.corpus as string,
          out: args.out as string,
          ablate: csv(args.ablate),
          ...(providers.length > 0 ? { providers } : {}),
          ...(typeof args.critic === "string" && args.critic.length > 0
            ? { criticProvider: args.critic.trim() as ProviderId }
            : {}),
          ...(repeat !== undefined ? { repeat } : {}),
          ...(window !== undefined ? { window } : {}),
          includeAdvisory: args["include-advisory"] === true,
        });
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        process.exit(res.exitCode);
      },
    }),
  },
});

const main = defineCommand({
  meta: {
    name: "reviewgate",
    version: RG_VERSION,
    description: "Heterogeneous LLM code-review gate for Claude Code and Codex agent loops",
  },
  subCommands: {
    init,
    gate,
    "pre-push": prePush,
    "review-plan": reviewPlan,
    doctor,
    reset,
    config,
    audit,
    brain,
    lore,
    fp,
    stats,
    report,
    setup,
    learn,
    bench,
  },
});

void runMain(main);
