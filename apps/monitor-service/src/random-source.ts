import { createHmac, randomInt } from "node:crypto";

/** A uniform integer in [0, n), n >= 1. */
export type RandomInt = (n: number) => number;

const WORD_BYTES = 6; // 48 bits, the widest range node:crypto's randomInt accepts
const WORD_RANGE = 2 ** (WORD_BYTES * 8);

function assertValidBound(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > WORD_RANGE) {
    throw new RangeError(
      `n must be an integer in [1, ${WORD_RANGE}], got ${n}`,
    );
  }
}

/** Unseeded uses the OS CSPRNG; seeded is a deterministic HMAC-SHA256(seed, counter) stream. */
export function createRandomInt(seed?: string): RandomInt {
  if (seed === undefined) {
    return (n) => {
      assertValidBound(n);
      return randomInt(n);
    };
  }

  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 0;

  const nextWord = (): number => {
    if (offset + WORD_BYTES > block.length) {
      block = createHmac("sha256", seed).update(String(counter++)).digest();
      offset = 0;
    }
    const word = block.readUIntBE(offset, WORD_BYTES);
    offset += WORD_BYTES;
    return word;
  };

  return (n) => {
    assertValidBound(n);
    // Rejecting the uneven tail of the word range avoids modulo bias.
    const limit = WORD_RANGE - (WORD_RANGE % n);
    let word = nextWord();
    while (word >= limit) word = nextWord();
    return word % n;
  };
}
