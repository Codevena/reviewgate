import { createHash } from "node:crypto";

export interface OrderedResponseHash {
  readonly kind: string;
  readonly ordinal: number;
  readonly sha256: string;
}

function compareByteOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Holds response digests in logical call order. The raw response is hashed at
 * the boundary and is never retained by this object.
 */
export class OrderedResponseHashes {
  readonly #entries = new Map<string, OrderedResponseHash>();

  record(kind: string, ordinal: number, rawText?: string): void {
    if (rawText === undefined) return;
    if (kind.length === 0) throw new Error("response hash kind must not be empty");
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new Error("response hash ordinal must be a non-negative safe integer");
    }

    const identity = JSON.stringify([kind, ordinal]);
    if (this.#entries.has(identity)) {
      throw new Error(`duplicate response hash call identity: ${kind}:${ordinal}`);
    }

    this.#entries.set(identity, {
      kind,
      ordinal,
      sha256: createHash("sha256").update(Buffer.from(rawText, "utf8")).digest("hex"),
    });
  }

  entries(): OrderedResponseHash[] {
    return [...this.#entries.values()]
      .sort(
        (left, right) => left.ordinal - right.ordinal || compareByteOrder(left.kind, right.kind),
      )
      .map((entry) => ({ ...entry }));
  }

  values(): string[] {
    return this.entries().map((entry) => entry.sha256);
  }
}
