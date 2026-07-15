import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseUnifiedDiff } from "../../src/bench/diff-hunks.ts";
import { BenchCaseSchema } from "../../src/schemas/bench-case.ts";

const REPO = join(import.meta.dir, "../..");
const CORPUS = join(REPO, "bench/cases");
const ALPHA12_SEEDED = new Set([
  "archive-entry-escape-ts",
  "inventory-reservation-check-then-write-ts",
  "profile-update-partial-write-ts",
  "session-payload-pickle-execution-py",
  "signed-return-target-open-redirect-ts",
  "tenant-order-scope-omitted-ts",
]);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hydrate(id: string): string {
  const root = mkdtempSync(join(tmpdir(), `rg-corpus-${id}-`));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["apply", join(CORPUS, id, "diff.patch")], { cwd: root });
  return root;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function importCase<T>(root: string, relativePath: string): Promise<T> {
  return import(
    `${pathToFileURL(join(root, relativePath)).href}?oracle=${crypto.randomUUID()}`
  ) as T;
}

interface InventoryLike {
  getStock(sku: string): Promise<number>;
  setStock(sku: string, value: number): Promise<void>;
  transactionForSku(sku: string, work: (tx: InventoryLike) => Promise<unknown>): Promise<unknown>;
}

interface ProfileLike {
  displayName: string;
  updateUser(id: string, name: string): Promise<void>;
  updateSettings(): Promise<void>;
  transaction(work: (tx: ProfileLike) => Promise<unknown>): Promise<unknown>;
}

describe("Alpha.12 benchmark corpus", () => {
  it("contains exactly 30 valid, self-contained cases with the preregistered 16/14 mix", () => {
    const ids = readdirSync(CORPUS).sort();
    expect(ids).toHaveLength(30);
    const cases = ids.map((id) =>
      BenchCaseSchema.parse(JSON.parse(readFileSync(join(CORPUS, id, "case.json"), "utf8"))),
    );
    expect(cases.filter((entry) => entry.kind === "clean")).toHaveLength(16);
    expect(cases.filter((entry) => entry.kind === "seeded-bug")).toHaveLength(14);

    for (const entry of cases) {
      expect(ids).toContain(entry.id);
      const patch = readFileSync(join(CORPUS, entry.id, "diff.patch"), "utf8");
      const parsed = parseUnifiedDiff(patch);
      expect(parsed.ok).toBe(true);
      const root = hydrate(entry.id);
      if (entry.kind === "seeded-bug") {
        for (const expected of entry.expected) {
          const tags = Array.isArray(expected.tag) ? expected.tag : [expected.tag];
          if (ALPHA12_SEEDED.has(entry.id)) {
            expect(tags.length).toBeGreaterThanOrEqual(3);
            expect(tags.every((tag) => tag.includes(" "))).toBe(true);
          }
          const lines = readFileSync(join(root, expected.file), "utf8").split("\n");
          expect(lines[expected.line - 1]?.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("matches every corpus hash frozen in the committed Alpha.12 preregistration", () => {
    const prereg = JSON.parse(
      readFileSync(join(REPO, "bench/preregistrations/alpha12-v2.json"), "utf8"),
    ) as { corpus: { content_sha256: Record<string, string>; manifest_sha256: string } };
    const actual: Record<string, string> = {};
    for (const id of readdirSync(CORPUS).sort()) {
      const caseBytes = readFileSync(join(CORPUS, id, "case.json"));
      const diffBytes = readFileSync(join(CORPUS, id, "diff.patch"));
      actual[id] = sha256(`${sha256(caseBytes)}${sha256(diffBytes)}`);
    }
    expect(actual).toEqual(prereg.corpus.content_sha256);
    expect(sha256(JSON.stringify(actual))).toBe(prereg.corpus.manifest_sha256);
  });

  it("distinguishes the tenant authorization mutation from its safe counterpart", async () => {
    const foreignOrder = { id: "o-1", tenantId: "tenant-b", totalCents: 500 };
    const repo = {
      async getOrder() {
        return foreignOrder;
      },
    };
    const seededRoot = hydrate("tenant-order-scope-omitted-ts");
    const cleanRoot = hydrate("tenant-order-scope-enforced-ts");
    const seeded = await importCase<{
      viewOrder: (repository: typeof repo, tenantId: string, orderId: string) => Promise<unknown>;
    }>(seededRoot, "src/orders/service.ts");
    const clean = await importCase<{
      viewOrder: (repository: typeof repo, tenantId: string, orderId: string) => Promise<unknown>;
    }>(cleanRoot, "src/orders/service.ts");
    expect(await seeded.viewOrder(repo, "tenant-a", "o-1")).toEqual(foreignOrder);
    expect(await clean.viewOrder(repo, "tenant-a", "o-1")).toBeNull();
  });

  it("reproduces the inventory race while the paired transaction serializes reservations", async () => {
    const seededRoot = hydrate("inventory-reservation-check-then-write-ts");
    const cleanRoot = hydrate("inventory-reservation-serialized-ts");
    const seeded = await importCase<{
      reserve: (store: InventoryLike, sku: string, quantity: number) => Promise<boolean>;
    }>(seededRoot, "src/inventory/reserve.ts");
    const clean = await importCase<{
      reserve: (store: InventoryLike, sku: string, quantity: number) => Promise<boolean>;
    }>(cleanRoot, "src/inventory/reserve.ts");

    let racedStock = 5;
    let reads = 0;
    let releaseReads = () => {};
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const racingStore = {
      async getStock() {
        const observed = racedStock;
        reads++;
        if (reads === 2) releaseReads();
        await bothRead;
        return observed;
      },
      async setStock(_sku: string, value: number) {
        racedStock = value;
      },
      async transactionForSku(_sku: string, work: (tx: InventoryLike) => Promise<unknown>) {
        return work(this);
      },
    } satisfies InventoryLike;
    expect(
      await Promise.all([
        seeded.reserve(racingStore, "sku", 4),
        seeded.reserve(racingStore, "sku", 4),
      ]),
    ).toEqual([true, true]);
    expect(racedStock).toBe(1);

    let safeStock = 5;
    let tail = Promise.resolve();
    const serialStore = {
      async getStock() {
        return safeStock;
      },
      async setStock(_sku: string, value: number) {
        safeStock = value;
      },
      async transactionForSku(_sku: string, work: (tx: InventoryLike) => Promise<unknown>) {
        const prior = tail;
        let release = () => {};
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prior;
        try {
          return await work(this);
        } finally {
          release();
        }
      },
    } satisfies InventoryLike;
    expect(
      await Promise.all([
        clean.reserve(serialStore, "sku", 4),
        clean.reserve(serialStore, "sku", 4),
      ]),
    ).toEqual([true, false]);
    expect(safeStock).toBe(1);
  });

  it("reproduces Zip Slip and proves the paired containment guard rejects it", async () => {
    const seededRoot = hydrate("archive-entry-escape-ts");
    const cleanRoot = hydrate("archive-entry-contained-ts");
    const seeded = await importCase<{
      writeRegularEntry: (root: string, name: string, data: Uint8Array) => Promise<void>;
    }>(seededRoot, "src/archive/extract.ts");
    const clean = await importCase<{
      containedArchiveTarget: (root: string, name: string) => string;
    }>(cleanRoot, "src/archive/paths.ts");
    const extraction = join(seededRoot, "extract");
    await seeded.writeRegularEntry(extraction, "../escaped.txt", new TextEncoder().encode("owned"));
    expect(existsSync(join(seededRoot, "escaped.txt"))).toBe(true);
    expect(() =>
      clean.containedArchiveTarget(join(cleanRoot, "extract"), "../escaped.txt"),
    ).toThrow();
  });

  it("rejects cross-origin signed return targets only in the safe pair", async () => {
    const seededRoot = hydrate("signed-return-target-open-redirect-ts");
    const cleanRoot = hydrate("signed-return-target-same-origin-ts");
    const seeded = await importCase<{
      issueReturnTicket: (secret: string, origin: string, target: string) => { target: string };
    }>(seededRoot, "src/auth/ticket.ts");
    const clean = await importCase<{
      issueReturnTicket: (secret: string, origin: string, target: string) => { target: string };
    }>(cleanRoot, "src/auth/ticket.ts");
    expect(
      seeded.issueReturnTicket("secret", "https://app.test", "https://evil.test/phish").target,
    ).toBe("https://evil.test/phish");
    expect(() =>
      clean.issueReturnTicket("secret", "https://app.test", "https://evil.test/phish"),
    ).toThrow();
    expect(clean.issueReturnTicket("secret", "https://app.test", "/account").target).toBe(
      "/account",
    );
  });

  it("rolls back the paired profile transaction while the mutation leaves a partial write", async () => {
    const seededRoot = hydrate("profile-update-partial-write-ts");
    const cleanRoot = hydrate("profile-update-atomic-ts");
    const seeded = await importCase<{
      updateProfile: (db: ProfileLike, input: Record<string, string>) => Promise<void>;
    }>(seededRoot, "src/profile/update.ts");
    const clean = await importCase<{
      updateProfile: (db: ProfileLike, input: Record<string, string>) => Promise<void>;
    }>(cleanRoot, "src/profile/update.ts");
    const makeDb = (): ProfileLike => ({
      displayName: "before",
      async updateUser(_id: string, name: string) {
        this.displayName = name;
      },
      async updateSettings() {
        throw new Error("settings unavailable");
      },
      async transaction(work: (tx: ProfileLike) => Promise<unknown>) {
        const snapshot = this.displayName;
        try {
          return await work(this);
        } catch (error) {
          this.displayName = snapshot;
          throw error;
        }
      },
    });
    const input = { userId: "u-1", displayName: "after", locale: "de" };
    const partial = makeDb();
    await expect(seeded.updateProfile(partial, input)).rejects.toThrow("settings unavailable");
    expect(partial.displayName).toBe("after");
    const atomic = makeDb();
    await expect(clean.updateProfile(atomic, input)).rejects.toThrow("settings unavailable");
    expect(atomic.displayName).toBe("before");
  });

  it("keeps the Python safe pair on JSON and the seeded pair on executable pickle", () => {
    const safeRoot = hydrate("session-payload-json-validated-py");
    const seededRoot = hydrate("session-payload-pickle-execution-py");
    expect(readFileSync(join(safeRoot, "app/session/codec.py"), "utf8")).toContain("json.loads");
    expect(readFileSync(join(safeRoot, "app/session/codec.py"), "utf8")).not.toContain("pickle");
    expect(readFileSync(join(seededRoot, "app/session/codec.py"), "utf8")).toContain(
      "pickle.loads",
    );
    writeFileSync(join(safeRoot, "app/__init__.py"), "");
    writeFileSync(join(safeRoot, "app/session/__init__.py"), "");
    execFileSync(
      "python3",
      [
        "-c",
        [
          "import base64, hashlib, hmac, json",
          "from app.session.codec import decode_session",
          "secret = b'session-secret'",
          "raw = json.dumps({'user_id':7,'role':'member'}).encode()",
          "encoded = base64.urlsafe_b64encode(raw).decode().rstrip('=')",
          "signature = hmac.new(secret, encoded.encode('ascii'), hashlib.sha256).hexdigest()",
          "value = decode_session(encoded + '.' + signature, secret)",
          "assert value.user_id == 7",
          "forged = encoded + '.' + ('0' * 64)",
          "try:",
          "    decode_session(forged, secret)",
          "except ValueError:",
          "    pass",
          "else:",
          "    raise AssertionError('unsigned session accepted')",
        ].join("\n"),
      ],
      { cwd: safeRoot },
    );
  });
});
