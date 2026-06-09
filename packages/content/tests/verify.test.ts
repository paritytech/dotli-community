// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { CID } from "multiformats/cid";
import { create } from "multiformats/hashes/digest";
import {
  assertBlockMatchesCid,
  assertSameContentId,
  verifyingBlockSource,
  rootVerifyingBlockSource,
} from "@dotli/content/verify";

const RAW = 0x55;
const DAG_PB = 0x70;
const SHA2_256 = 0x12;
const BLAKE2B_256 = 0xb220;
const SHA2_512 = 0x13;

function sha256Cid(bytes: Uint8Array, codec = RAW): CID {
  return CID.createV1(codec, create(SHA2_256, sha256(bytes)));
}

function blake2bCid(bytes: Uint8Array, codec = RAW): CID {
  return CID.createV1(
    codec,
    create(BLAKE2B_256, blake2b(bytes, { dkLen: 32 })),
  );
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("assertBlockMatchesCid", () => {
  it("accepts bytes that hash to their sha2-256 CID", () => {
    const bytes = enc("hello dot.li");
    expect(() => {
      assertBlockMatchesCid(sha256Cid(bytes), bytes);
    }).not.toThrow();
  });

  it("accepts bytes that hash to their blake2b-256 CID", () => {
    const bytes = enc("bulletin content");
    expect(() => {
      assertBlockMatchesCid(blake2bCid(bytes), bytes);
    }).not.toThrow();
  });

  it("rejects bytes substituted under a valid CID (tamper)", () => {
    const cid = sha256Cid(enc("the real index.html"));
    const tampered = enc("<script>steal()</script>");
    expect(() => {
      assertBlockMatchesCid(cid, tampered);
    }).toThrow(/hash mismatch/i);
  });

  it("rejects a single flipped byte", () => {
    const bytes = enc("a".repeat(1000));
    const cid = sha256Cid(bytes);
    const flipped = bytes.slice();
    flipped[500] ^= 0x01;
    expect(() => {
      assertBlockMatchesCid(cid, flipped);
    }).toThrow(/hash mismatch/i);
  });

  it("fails closed on a multihash it cannot recompute", () => {
    // CID whose multihash claims sha2-512: we can't recompute it, so we must
    // refuse rather than wave the bytes through unverified.
    const bytes = enc("payload");
    const cid = CID.createV1(RAW, create(SHA2_512, new Uint8Array(64)));
    expect(() => {
      assertBlockMatchesCid(cid, bytes);
    }).toThrow(/unsupported multihash/i);
  });
});

describe("verifyingBlockSource", () => {
  it("passes through bytes that match the requested CID", async () => {
    const bytes = enc("block bytes");
    const cid = sha256Cid(bytes);
    const wrapped = verifyingBlockSource(() => Promise.resolve(bytes));
    await expect(wrapped(cid)).resolves.toEqual(bytes);
  });

  it("throws when the source returns bytes for the wrong CID", async () => {
    const cid = sha256Cid(enc("expected"));
    const wrapped = verifyingBlockSource(() =>
      Promise.resolve(enc("attacker")),
    );
    await expect(wrapped(cid)).rejects.toThrow(/hash mismatch/i);
  });
});

describe("rootVerifyingBlockSource", () => {
  it("verifies the root block and rejects a tampered root", async () => {
    const rootCid = sha256Cid(enc("root"), DAG_PB);
    const good = rootVerifyingBlockSource(rootCid, () =>
      Promise.resolve(enc("root")),
    );
    await expect(good(rootCid)).resolves.toEqual(enc("root"));

    const bad = rootVerifyingBlockSource(rootCid, () =>
      Promise.resolve(enc("tampered root")),
    );
    await expect(bad(rootCid)).rejects.toThrow(/hash mismatch/i);
  });

  it("passes interior (non-root) blocks through without verifying them", async () => {
    // Only the root is re-checked here; interior blocks are trusted to the
    // underlying transport (smoldot). A non-root CID whose bytes don't match
    // must NOT throw.
    const rootCid = sha256Cid(enc("root"), DAG_PB);
    const childCid = sha256Cid(enc("child"));
    const wrapped = rootVerifyingBlockSource(rootCid, () =>
      Promise.resolve(enc("not the child bytes")),
    );
    await expect(wrapped(childCid)).resolves.toEqual(
      enc("not the child bytes"),
    );
  });
});

describe("assertSameContentId", () => {
  it("accepts an identical CID", () => {
    const cid = sha256Cid(enc("root"), DAG_PB);
    expect(() => {
      assertSameContentId(cid, cid);
    }).not.toThrow();
  });

  it("treats CIDv0 and CIDv1 of the same content as equal", () => {
    // CIDv0 is dag-pb + sha2-256; its v1 form has the same codec + multihash.
    const v1 = sha256Cid(enc("same content"), DAG_PB);
    const v0 = v1.toV0();
    expect(() => {
      assertSameContentId(v0, v1);
    }).not.toThrow();
    expect(() => {
      assertSameContentId(v1, v0);
    }).not.toThrow();
  });

  it("rejects a different root (attacker-declared CAR root)", () => {
    const requested = sha256Cid(enc("legit site"), DAG_PB);
    const attacker = sha256Cid(enc("phishing clone"), DAG_PB);
    expect(() => {
      assertSameContentId(attacker, requested);
    }).toThrow(/does not match requested/i);
  });

  it("rejects a CID with a matching hash but a different codec", () => {
    const bytes = enc("ambiguous");
    expect(() => {
      assertSameContentId(sha256Cid(bytes, RAW), sha256Cid(bytes, DAG_PB));
    }).toThrow(/does not match requested/i);
  });
});
