// src/cli/index.ts
import { defineCommand, runMain } from "citty";
import { RG_VERSION } from "../version.ts";
import { runAuditVerify } from "./commands/audit.ts";
import { runBrainList, runBrainRevoke, runBrainShow } from "./commands/brain.ts";
import { runDoctor } from "./commands/doctor.ts";
import {
  runFpAudit,
  runFpClusters,
  runFpList,
  runFpPin,
  runFpShow,
  runFpUnpin,
} from "./commands/fp.ts";
import { runGate } from "./commands/gate.ts";
import { runInit } from "./commands/init.ts";
import { runLearnStatus } from "./commands/learn-status.ts";
import { runReport } from "./commands/report.ts";
import { runReviewPlan } from "./commands/review-plan.ts";
import { runSetup, setupTip } from "./commands/setup.ts";
import { runStats } from "./commands/stats.ts";
import { validateSince, validateWeek } from "./validate-time-args.ts";

/** Print a one-line CLI error to stderr and exit non-zero (no stack trace). */
function failArg(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

const init = defineCommand({
  meta: { name: "init", description: "Install Reviewgate hooks into .claude/settings.json" },
  args: { mode: { type: "string", default: "agent-loop" } },
  async run({ args }) {
    await runInit({ repoRoot: process.cwd(), mode: args.mode as "agent-loop" });
    process.stdout.write("Reviewgate installed.\n");
    const tip = setupTip(Boolean(process.stdout.isTTY));
    if (tip) process.stdout.write(`${tip}\n`);
  },
});

const gate = defineCommand({
  meta: { name: "gate", description: "Run the review gate (internal hook entry point)" },
  args: { hook: { type: "string", default: "stop" } },
  async run({ args }) {
    let raw = "";
    try {
      raw = await Bun.stdin.text();
    } catch {
      raw = "";
    }
    const res = await runGate({
      repoRoot: process.cwd(),
      hook: args.hook as "trigger" | "stop" | "reset",
      hookStdinRaw: raw,
    });
    if (res.stdout) process.stdout.write(res.stdout);
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

const audit = defineCommand({
  meta: { name: "audit", description: "Audit utilities" },
  subCommands: {
    verify: defineCommand({
      meta: {
        name: "verify",
        description: "Verify the audit log's hash chain is intact (tamper check)",
      },
      args: {
        file: { type: "string", description: "Audit .jsonl file to verify (default: latest)" },
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
      args: { id: { type: "string", description: "Brain entry id (from `brain list`)" } },
      async run({ args }) {
        if (!args.id) {
          process.stderr.write("brain show: --id <entry-id> is required\n");
          process.exit(2);
        }
        const exitCode = await runBrainShow({ repoRoot: process.cwd(), id: args.id as string });
        process.exit(exitCode);
      },
    }),
    revoke: defineCommand({
      meta: {
        name: "revoke",
        description: "Revoke (archive) a brain entry so it stops being recalled",
      },
      args: { id: { type: "string", description: "Brain entry id (from `brain list`)" } },
      async run({ args }) {
        if (!args.id) {
          process.stderr.write("brain revoke: --id <entry-id> is required\n");
          process.exit(2);
        }
        const exitCode = await runBrainRevoke({ repoRoot: process.cwd(), id: args.id as string });
        process.exit(exitCode);
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
      args: { id: { type: "string", description: "FP id, e.g. FP-001 (from `fp list`)" } },
      async run({ args }) {
        if (!args.id) {
          process.stderr.write("fp show: --id <id> is required\n");
          process.exit(2);
        }
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
      args: { id: { type: "string", description: "FP id to unpin, e.g. FP-001" } },
      async run({ args }) {
        if (!args.id) {
          process.stderr.write("fp unpin: --id <id> is required\n");
          process.exit(2);
        }
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
  meta: { name: "setup", description: "Interactive configuration wizard" },
  args: { global: { type: "boolean" }, print: { type: "boolean" } },
  async run({ args }) {
    process.exit(
      await runSetup({
        repoRoot: process.cwd(),
        global: args.global === true,
        print: args.print === true,
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

const main = defineCommand({
  meta: {
    name: "reviewgate",
    version: RG_VERSION,
    description: "Heterogeneous LLM code-review gate that runs inside Claude Code's agent loop",
  },
  subCommands: {
    init,
    gate,
    "review-plan": reviewPlan,
    doctor,
    audit,
    brain,
    fp,
    stats,
    report,
    setup,
    learn,
  },
});

void runMain(main);
