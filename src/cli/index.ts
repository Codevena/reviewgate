// src/cli/index.ts
import { defineCommand, runMain } from "citty";
import { runAuditVerify } from "./commands/audit.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runGate } from "./commands/gate.ts";
import { runInit } from "./commands/init.ts";

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

const main = defineCommand({
  meta: { name: "reviewgate", version: "0.1.0-m1" },
  subCommands: { init, gate, doctor, audit },
});

void runMain(main);
