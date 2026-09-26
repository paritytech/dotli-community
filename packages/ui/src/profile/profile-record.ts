// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The profile record a Seity contacts reference opens.
//
// A SCALE `Vec<{ kind: String, payload: Vec<u8> }>`, pinned by Seity's
// profile-core (`profile-record.ts`) and its committed vector. Kinds this host
// draws: `avatar` (a UTF-8 `cid#key` blob reference, read by
// seity-reference.ts) and `mood`. Unknown kinds are skipped, so the record can
// grow without this host changing.

export const MOOD_KINDS = [
  "calm",
  "focused",
  "hyped",
  "social",
  "low-key",
  "away",
] as const;
export const MOOD_INTENSITIES = ["soft", "steady", "loud"] as const;
export type MoodKind = (typeof MOOD_KINDS)[number];
export type MoodIntensity = (typeof MOOD_INTENSITIES)[number];

export interface Mood {
  readonly kind: MoodKind;
  readonly intensity: MoodIntensity;
  /** Unix seconds. */
  readonly setAt: number;
  readonly ttlSecs: number;
}

export interface ProfileRecord {
  readonly avatarReference?: string;
  readonly mood?: Mood;
}

const MAX_RECORD_BYTES = 8 * 1024;

class Reader {
  private offset = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  private take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) {
      throw new Error("profile record is truncated");
    }
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0];
  }

  u32(): number {
    const b = this.take(4);
    return (
      (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0
    );
  }

  u64(): number {
    const lo = this.u32();
    const hi = this.u32();
    return hi * 2 ** 32 + lo;
  }

  compact(): number {
    const first = this.u8();
    switch (first & 3) {
      case 0:
        return first >> 2;
      case 1:
        return ((first | (this.u8() << 8)) >>> 2) & 0x3fff;
      case 2: {
        const rest = this.take(3);
        return (
          ((first | (rest[0] << 8) | (rest[1] << 16) | (rest[2] << 24)) >>> 2) >>> 0
        );
      }
      default:
        throw new Error("profile record uses a big-integer length");
    }
  }

  bytesField(): Uint8Array {
    return this.take(this.compact());
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

/** Undefined for a payload this build cannot read, so a newer palette degrades to "no mood". */
function decodeMood(payload: Uint8Array): Mood | undefined {
  if (payload.length !== 14) {
    return undefined;
  }
  const reader = new Reader(payload);
  const kind = MOOD_KINDS.at(reader.u8());
  const intensity = MOOD_INTENSITIES.at(reader.u8());
  const setAt = reader.u64();
  const ttlSecs = reader.u32();
  if (kind === undefined || intensity === undefined) {
    return undefined;
  }
  return { kind, intensity, setAt, ttlSecs };
}

export function decodeProfileRecord(bytes: Uint8Array): ProfileRecord {
  if (bytes.length > MAX_RECORD_BYTES) {
    throw new Error("profile record is too large");
  }
  const reader = new Reader(bytes);
  const text = new TextDecoder("utf-8", { fatal: true });
  const lenient = new TextDecoder("utf-8");
  const count = reader.compact();
  let avatarReference: string | undefined;
  let mood: Mood | undefined;
  for (let i = 0; i < count; i++) {
    const kind = text.decode(reader.bytesField());
    const payload = reader.bytesField();
    // One unreadable signal degrades the drawer; it never sinks the read. A
    // malformed avatar reference is refused later by its own parser.
    if (kind === "avatar" && avatarReference === undefined) {
      avatarReference = lenient.decode(payload);
    } else if (kind === "mood" && mood === undefined) {
      mood = decodeMood(payload);
    }
  }
  if (!reader.done()) {
    throw new Error("profile record has trailing bytes");
  }
  return { avatarReference, mood };
}

/** True while the mood still counts, on this host's clock. */
export function moodIsCurrent(
  mood: Mood,
  nowSecs: number = Math.floor(Date.now() / 1000),
): boolean {
  return nowSecs < mood.setAt + mood.ttlSecs;
}
