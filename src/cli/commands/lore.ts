// src/cli/commands/lore.ts — `reviewgate lore status` (read-only inspection),
// `reviewgate lore verify` (recompute + write back verified_tree/verified_at)
// and `reviewgate lore approve` (human canon approval). Mirrors the shape of
// brain.ts's CLI commands.
import {
  type LoreApprovePreflight,
  approveLoreEntry,
  loreApprovePreflight,
} from "../../core/lore/approve.ts";
import { classifyEntry } from "../../core/lore/staleness.ts";
import { loadLore } from "../../core/lore/store.ts";
import { verifyLoreEntry } from "../../core/lore/verify.ts";

export interface LoreStatusInput {
  repoRoot: string;
  write?: (s: string) => void;
}

export async function runLoreStatus(input: LoreStatusInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const { entries, invalid } = loadLore(input.repoRoot);

  if (entries.length === 0 && invalid.length === 0) {
    out("No lore entries found in .reviewgate/lore/.\n");
    return 0;
  }

  let canon = 0;
  let draft = 0;
  let stale = 0;
  let inert = 0;
  for (const entry of entries) {
    if (entry.status === "canon") canon++;
    else draft++;
    const cls = classifyEntry(input.repoRoot, entry);
    if (cls.state === "stale") stale++;
    if (cls.state === "broad" || cls.state === "zero-match") inert++;
    out(`${entry.id} · ${entry.status} · ${cls.state} · ${entry.anchors.join(", ")}\n`);
  }
  for (const inv of invalid) {
    out(`${inv.file} · invalid · ${inv.error}\n`);
  }

  out(
    `Total: ${canon} canon, ${draft} draft, ${stale} stale, ${inert} inert, ${invalid.length} invalid\n`,
  );
  return 0;
}

export interface LoreVerifyInput {
  repoRoot: string;
  slugs?: string[];
  all?: boolean;
  write?: (s: string) => void;
}

// `reviewgate lore verify <slug> [<slug>...]` / `--all`. Unlike `status`, this
// WRITES (it recomputes + persists verified_tree/verified_at), so it must
// signal failure: exit 1 when any requested entry couldn't be verified
// (not found / zero-match / broad) — a write command that silently no-ops on
// error is worse than one that never ran.
export async function runLoreVerify(input: LoreVerifyInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));

  // `--all` must also surface unparseable lore files (loadLore's `invalid`
  // bucket), not just the entries that parsed cleanly — otherwise a broken
  // .reviewgate/lore/*.md is silently skipped and `--all` reports a false-clean
  // exit 0. Named-slug mode is unaffected: `invalid` stays empty there.
  let slugs: string[];
  let invalid: { file: string; error: string }[] = [];
  if (input.all) {
    const loaded = loadLore(input.repoRoot);
    slugs = loaded.entries.map((e) => e.id);
    invalid = loaded.invalid;
  } else {
    slugs = input.slugs ?? [];
  }

  if (slugs.length === 0 && invalid.length === 0) {
    out("no lore entries\n");
    return 0;
  }

  let anyError = false;
  const now = new Date();
  for (const slug of slugs) {
    const result = verifyLoreEntry(input.repoRoot, slug, now);
    if (!result.ok) {
      anyError = true;
      out(`${slug} · ERROR · ${result.error}\n`);
      continue;
    }
    if (result.changed) {
      const oldShort = (result.oldTree ?? "").slice(0, 8);
      const newShort = (result.newTree ?? "").slice(0, 8);
      out(`${slug} · updated · ${oldShort}…→${newShort}… · ${result.verifiedAt}\n`);
    } else {
      out(`${slug} · already fresh · ${result.verifiedAt}\n`);
    }
  }
  // Invalid (unparseable) files are reported but never written to — there's
  // nothing safe to recompute against a file that didn't parse.
  for (const inv of invalid) {
    anyError = true;
    out(`${inv.file} · ERROR · ${inv.error}\n`);
  }
  return anyError ? 1 : 0;
}

// Terminal-display defang. Every field below comes from a file the agent under
// review can write, and it is rendered in the maintainer's terminal — so raw
// C0/C1 control bytes would let that agent clear the screen, reposition the
// cursor or overwrite the challenge line, showing the human text that is NOT
// what challengeFor() hashed. The human would then knowingly approve bytes they
// never saw, which is precisely what this whole command exists to prevent.
// Newline and tab survive (the body is legitimately multi-line); everything
// else in \x00-\x1f, \x7f-\x9f becomes U+FFFD so tampering stays VISIBLE rather
// than silently dropped.
//
// Stripping C0/C1 alone is NOT enough, and the gap is the same attack in a
// different alphabet: Unicode bidirectional overrides and isolates (the Trojan
// Source class, CVE-2021-42574) make a terminal render text in an order that
// differs from the byte order, and zero-width characters hide boundaries
// outright. Both let an agent-written body READ as something other than what
// challengeFor() hashed — the exact "human approves bytes they never saw"
// outcome the C0 strip above exists to prevent. So the set below also covers:
//   U+200B-U+200F  zero-width space/non-joiner/joiner, LRM/RLM
//   U+202A-U+202E  LRE/RLE/PDF/LRO/RLO  (embeddings + overrides)
//   U+2060-U+2064  word joiner + invisible operators
//   U+2066-U+2069  LRI/RLI/FSI/PDI      (isolates — the modern variant)
//   U+FEFF         BOM / zero-width no-break space
// Tradeoff accepted deliberately: ZWJ emoji sequences (U+200D) render with a
// U+FFFD between their parts. In a technical why-note that is a cosmetic cost;
// letting an invisible character survive into a security prompt is not.
const CONTROL_CHARS_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function defangForTerminal(s: string): string {
  return s.replace(CONTROL_CHARS_RE, "�");
}

// What the human sees BEFORE typing the challenge. The body is printed in full
// and unabbreviated on purpose: approving is what turns this text into trusted
// reviewer context, so it is the one thing that must not be summarised away.
export function formatLoreApprovePreflight(pre: LoreApprovePreflight): string {
  const lines: string[] = [];
  if (!pre.eligible || !pre.entry) {
    lines.push(`Lore entry \`${pre.slug}\`: ${pre.reason ?? "not approvable"}`);
    return `${lines.join("\n")}\n`;
  }
  const e = pre.entry;
  const d = defangForTerminal;
  lines.push(`Lore entry:   ${d(e.id)}`);
  lines.push(`  file:       ${d(e.file)}`);
  lines.push(
    `  status:     ${d(e.status)} (anchors: ${pre.state}, ${pre.anchorFileCount} file(s))`,
  );
  lines.push(`  anchors:    ${d(e.anchors.join(", "))}`);
  lines.push(`  verified:   ${d(e.verified_at)}`);
  for (const w of pre.warnings) lines.push(`  ⚠ ${d(w)}`);
  lines.push("");
  lines.push("Approving makes the text below TRUSTED context in every reviewer prompt whose");
  lines.push("diff touches those anchors. Read it as if you were writing it yourself:");
  lines.push("────────────────────────────────────────────────────────────");
  // Every body line is prefixed, so text inside the entry cannot impersonate
  // this command's own output — a forged "Type exactly …" line planted in the
  // body is visibly INSIDE the quoted block, not below it.
  for (const line of d(e.body).split("\n")) lines.push(`│ ${line}`);
  lines.push("────────────────────────────────────────────────────────────");
  return `${lines.join("\n")}\n`;
}

export interface LoreApproveInput {
  repoRoot: string;
  slug: string;
  /** `null` = the prompt was closed without an answer (EOF / Ctrl-D). */
  confirmation: string | null;
  now?: Date;
  write?: (s: string) => void;
}

// Exit codes: 0 = approved (or already approved — a re-run is a no-op, not a
// failure), 1 = nothing was written. Never 0 on a refusal: this command's whole
// value is that its exit code means "the ledger line exists".
export function runLoreApprove(input: LoreApproveInput): number {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  // EOF at the prompt must NOT look like success. readline's question() never
  // settles once the interface closes, so an unguarded await would drain the
  // event loop and exit 0 having written nothing — an exit code claiming an
  // approval that does not exist.
  if (input.confirmation === null) {
    out("Aborted: no confirmation read — nothing was approved.\n");
    return 1;
  }
  const result = approveLoreEntry(input.repoRoot, input.slug, input.confirmation, {
    now: input.now ?? new Date(),
  });
  if (result.alreadyApproved) {
    out(`Lore entry \`${input.slug}\` is already approved — nothing to do.\n`);
    return 0;
  }
  if (!result.ok) {
    out(`${result.error ?? "not approvable"}\n`);
    return 1;
  }
  out(
    `Lore entry \`${input.slug}\` approved — the approvals.jsonl line is written.\nCommit .reviewgate/lore/approvals.jsonl so the approval travels with the repo.\n`,
  );
  return 0;
}

export { loreApprovePreflight };
