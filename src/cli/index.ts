// src/cli/index.ts
import { defineCommand, runMain } from "citty";
import { runAuditVerify } from "./commands/audit.ts";
import { runBrainList, runBrainRevoke, runBrainShow } from "./commands/brain.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runFpAudit, runFpList, runFpPin, runFpShow, runFpUnpin } from "./commands/fp.ts";
import { runGate } from "./commands/gate.ts";
import { runInit } from "./commands/init.ts";
import { runReport } from "./commands/report.ts";
import { runReviewPlan } from "./commands/review-plan.ts";
import { runSetup } from "./commands/setup.ts";
import { runStats } from "./commands/stats.ts";

const init = defineCommand({
  meta: { name: "init", description: "Install Reviewgate hooks into .claude/settings.json" },
  args: { mode: { type: "string", default: "agent-loop" } },
  async run({ args }) {
    await runInit({ repoRoot: process.cwd(), mode: args.mode as "agent-loop" });
    process.stdout.write("Reviewgate installed.\n");
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
      meta: { name: "verify" },
      args: { file: { type: "string" } },
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
      meta: { name: "list" },
      args: { filter: { type: "string" } },
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
      meta: { name: "show" },
      args: { id: { type: "string" } },
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
      meta: { name: "revoke" },
      args: { id: { type: "string" } },
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
      meta: { name: "list" },
      args: { filter: { type: "string" } },
      async run({ args }) {
        const filter = typeof args.filter === "string" ? args.filter : undefined;
        process.exit(
          await runFpList({ repoRoot: process.cwd(), ...(filter !== undefined ? { filter } : {}) }),
        );
      },
    }),
    show: defineCommand({
      meta: { name: "show" },
      args: { id: { type: "string" } },
      async run({ args }) {
        if (!args.id) {
          process.stderr.write("fp show: --id <id> is required\n");
          process.exit(2);
        }
        process.exit(await runFpShow({ repoRoot: process.cwd(), id: args.id as string }));
      },
    }),
    pin: defineCommand({
      meta: { name: "pin" },
      args: { id: { type: "string" }, signature: { type: "string" }, by: { type: "string" } },
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
      meta: { name: "unpin" },
      args: { id: { type: "string" } },
      async run({ args }) {
        if (!args.id) {
          process.stderr.write("fp unpin: --id <id> is required\n");
          process.exit(2);
        }
        process.exit(await runFpUnpin({ repoRoot: process.cwd(), id: args.id as string }));
      },
    }),
    audit: defineCommand({
      meta: { name: "audit" },
      async run() {
        process.exit(await runFpAudit({ repoRoot: process.cwd() }));
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
  async run() {
    process.exit(await runSetup({ repoRoot: process.cwd() }));
  },
});

const main = defineCommand({
  meta: { name: "reviewgate", version: "0.1.0-m1" },
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
  },
});

void runMain(main);
