import { z } from "zod";
import { SeverityCoerced } from "./finding.ts";

// reviewgate bench — corpus case schema (spec §3). One directory per case:
// `case.json` (this shape) + `diff.patch`. The schema is the source of truth for
// what a labelled case looks like; the runner (P1) validates every case against it
// and a malformed case makes the whole run benchmark-invalid (exit 4).

/** True if the string contains a null byte or ASCII control character. */
function hasControlChar(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    if (p.charCodeAt(i) <= 0x1f) return true;
  }
  return false;
}

// A repo-relative path with no absolute root and no parent-traversal segment.
// The schema is the declared validation layer for P1's filesystem operations
// (it names sandbox dirs from `id` and resolves context files from `file`), so a
// case carrying `../../etc/passwd`, `/etc/passwd`, a UNC/Windows root, a `.`/`..`
// segment or a control character must be rejected HERE, not by the runner.
function isSafeRelPath(p: string): boolean {
  if (p.length === 0) return false;
  if (hasControlChar(p)) return false; // null byte / CR / LF / ESC etc.
  if (p.startsWith("/") || p.startsWith("\\")) return false; // POSIX absolute + UNC
  if (/^[A-Za-z]:/.test(p)) return false; // Windows drive (C:\…)
  // Every path segment must be a real name — no empty ("a//b"), current-dir (".")
  // or parent-dir ("..") segments, any of which alias a directory in a path join.
  return p.split(/[\\/]/).every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}
const SafeRelPath = z.string().min(1).refine(isSafeRelPath, {
  message:
    "must be a repo-relative path with no absolute/UNC root, control char, or `.`/`..` segment",
});

// A case id becomes a directory name — restrict it to a safe slug that starts with
// an alphanumeric, so "." / ".." (alias parent/self) and leading-dot hidden names
// are rejected outright.
const SafeCaseId = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "id must be a slug starting with [A-Za-z0-9]")
  .refine((v) => !v.includes(".."), { message: "id must not contain `..`" });

// The optimal-assignment matcher is exponential in the label count in the worst
// case; cap `expected` (and `allowed`, same DoS surface) so a malformed/hostile
// corpus case cannot force a blowup (the matcher also guards internally, defence in
// depth). 25 ≫ the 1–3 the spec targets, ≪ anything pathological.
const MAX_EXPECTED_LABELS = 25;
const MAX_ALLOWED_ENTRIES = 25;

export const ExpectedLabelSchema = z
  .object({
    tag: z.string().min(1),
    file: SafeRelPath,
    line: z.number().int().positive(),
    min_severity: SeverityCoerced,
  })
  .strict();

export const AllowedEntrySchema = z
  .object({
    tag: z.string().min(1),
    file: SafeRelPath,
    line: z.number().int().positive(),
  })
  .strict();

export const BenchCaseSchema = z
  .object({
    schema: z.literal("reviewgate.bench.case.v1"),
    id: SafeCaseId,
    kind: z.enum(["seeded-bug", "clean"]),
    language: z.string().min(1),
    expected: z.array(ExpectedLabelSchema).max(MAX_EXPECTED_LABELS),
    allowed: z.array(AllowedEntrySchema).max(MAX_ALLOWED_ENTRIES).default([]),
    strict_region: z.boolean().default(true),
    source: z.enum(["hand-written", "derived-from-cve", "mutation"]),
    notes: z.string().optional(),
  })
  .strict()
  // A clean case is a *correct* change — it must carry no expected labels, so every
  // blocking finding on it is scored by the region rules (spec §3/§4).
  .refine((c) => c.kind !== "clean" || c.expected.length === 0, {
    message: "a `clean` case must have an empty `expected` array",
    path: ["expected"],
  })
  // A seeded-bug case MUST declare at least one expected label — otherwise a missed
  // planted bug contributes no FN and recall/quality-gate results are unsound (§3).
  .refine((c) => c.kind !== "seeded-bug" || c.expected.length >= 1, {
    message: "a `seeded-bug` case must declare at least one `expected` label",
    path: ["expected"],
  });

export type ExpectedLabel = z.infer<typeof ExpectedLabelSchema>;
export type AllowedEntry = z.infer<typeof AllowedEntrySchema>;
export type BenchCase = z.infer<typeof BenchCaseSchema>;
