// src/cli/commands/audit.ts
import { existsSync } from "node:fs";
import { verifyChain } from "../../audit/verifier.ts";

export interface AuditVerifyInput {
  file: string;
}

export async function runAuditVerify(input: AuditVerifyInput): Promise<number> {
  if (!input.file) {
    process.stderr.write("audit verify: --file <path> is required\n");
    return 2;
  }
  if (!existsSync(input.file)) {
    process.stderr.write(`audit verify: file not found: ${input.file}\n`);
    return 2;
  }
  // verifyChain reports corruption (a malformed/tampered/truncated line) as a
  // broken-chain RESULT, not an exception — but guard against any unexpected throw
  // (fs race, decode error) so `audit verify` always prints a clean one-line error
  // and exits non-zero rather than dumping a raw stack trace to the user.
  let v: Awaited<ReturnType<typeof verifyChain>>;
  try {
    v = await verifyChain(input.file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✗ audit verify: could not read/parse ${input.file}: ${msg}\n`);
    return 1;
  }
  if (v.ok) {
    process.stdout.write(`✓ audit chain verified — ${v.totalLines} events, all hashes match.\n`);
    return 0;
  }
  process.stderr.write(
    `✗ audit chain broken/corrupt at line ${v.brokenAtLine} of ${v.totalLines}.\n`,
  );
  return 1;
}
