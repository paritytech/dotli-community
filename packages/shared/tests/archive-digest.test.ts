// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { computeArchiveDigest } from "@dotli/shared/archive-digest";

const f = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("computeArchiveDigest", () => {
  it("is deterministic for the same files", async () => {
    const files = { "index.html": f("<h1>hi</h1>"), "app.js": f("run()") };
    expect(await computeArchiveDigest(files)).toBe(
      await computeArchiveDigest(files),
    );
  });

  it("is independent of object key insertion order", async () => {
    const a = await computeArchiveDigest({
      "index.html": f("a"),
      "b.css": f("b"),
      "c.js": f("c"),
    });
    const b = await computeArchiveDigest({
      "c.js": f("c"),
      "index.html": f("a"),
      "b.css": f("b"),
    });
    expect(a).toBe(b);
  });

  it("changes when any file's bytes change", async () => {
    const base = await computeArchiveDigest({ "index.html": f("v1") });
    const changed = await computeArchiveDigest({ "index.html": f("v2") });
    expect(changed).not.toBe(base);
  });

  it("changes when a file's path changes", async () => {
    const a = await computeArchiveDigest({ "a.html": f("same") });
    const b = await computeArchiveDigest({ "b.html": f("same") });
    expect(a).not.toBe(b);
  });

  it("distinguishes archives that swap content between paths", async () => {
    const a = await computeArchiveDigest({ x: f("1"), y: f("2") });
    const b = await computeArchiveDigest({ x: f("2"), y: f("1") });
    expect(a).not.toBe(b);
  });

  it("does not collide on paths/lengths that a naive delimiter would merge", async () => {
    // Under a naive `path length ` text framing these could alias; the
    // fixed-width two-hash manifest keeps them distinct.
    const a = await computeArchiveDigest({ "a 1": f("xx"), b: f("y") });
    const b = await computeArchiveDigest({ a: f("1 xxby"), "": f("") });
    expect(a).not.toBe(b);
  });

  it("accepts ArrayBuffer and Uint8Array equivalently", async () => {
    const bytes = f("payload");
    const asView = await computeArchiveDigest({ "f.bin": bytes });
    const asBuffer = await computeArchiveDigest({
      "f.bin": bytes.slice().buffer,
    });
    expect(asView).toBe(asBuffer);
  });

  it("returns a 64-char lowercase hex SHA-256 string", async () => {
    const digest = await computeArchiveDigest({ "index.html": f("x") });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles the empty archive without throwing", async () => {
    expect(await computeArchiveDigest({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
