// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { CarWriter } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  isCarFile,
  packArchive,
  parseIpfsResponse,
} from "@dotli/content/archive";
import type { ArchiveFiles } from "@dotli/content/archive";

describe("isCarFile", () => {
  it("returns false for empty buffer", () => {
    expect(isCarFile(new Uint8Array(0))).toBe(false);
  });

  it("returns false for buffer shorter than 10 bytes", () => {
    expect(isCarFile(new Uint8Array(9))).toBe(false);
  });

  it("returns false for random bytes", () => {
    const random = new Uint8Array(64);
    crypto.getRandomValues(random);
    expect(isCarFile(random)).toBe(false);
  });

  it("detects valid CAR v1 header", () => {
    // Minimal CAR v1 header: varint length + CBOR map {roots: [...], version: 1}
    // The CBOR starts with 0xa2 (2-element map), then 0x65 "roots" key
    const header = new Uint8Array([
      0x33, // varint header length = 51
      0xa2, // CBOR: map(2)
      0x65, // CBOR: text(5)
      0x72,
      0x6f,
      0x6f,
      0x74,
      0x73, // "roots"
      0x81, // CBOR: array(1)
      0xd8,
      0x2a, // CBOR: tag(42)
      // ... rest of CAR data (pad to offset + headerLen = 1 + 51 = 52 bytes total)
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    expect(isCarFile(header)).toBe(true);
  });

  it("returns false for HTML content", () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><html>");
    expect(isCarFile(html)).toBe(false);
  });
});

describe("packArchive", () => {
  it("packs empty archive", () => {
    const result = packArchive({});
    expect(result.packed.byteLength).toBe(0);
    expect(result.index).toEqual([]);
  });

  it("packs single file", () => {
    const files: ArchiveFiles = {
      "index.html": new TextEncoder().encode("<h1>Hello</h1>"),
    };
    const result = packArchive(files);
    expect(result.index).toHaveLength(1);
    expect(result.index[0].p).toBe("index.html");
    expect(result.index[0].o).toBe(0);
    expect(result.index[0].l).toBe(14);
    expect(result.packed.byteLength).toBe(14);
  });

  it("packs multiple files with correct offsets", () => {
    const files: ArchiveFiles = {
      "index.html": new TextEncoder().encode("<h1>A</h1>"),
      "style.css": new TextEncoder().encode("body{}"),
      "app.js": new TextEncoder().encode("console.log()"),
    };
    const result = packArchive(files);
    expect(result.index).toHaveLength(3);

    // Verify offsets are sequential
    let expectedOffset = 0;
    for (const entry of result.index) {
      expect(entry.o).toBe(expectedOffset);
      expectedOffset += entry.l;
    }

    // Total size should be sum of all file sizes
    const totalSize = Object.values(files).reduce(
      (sum, data) => sum + data.byteLength,
      0,
    );
    expect(result.packed.byteLength).toBe(totalSize);
  });

  it("preserves file content correctly", () => {
    const content = "Hello, World!";
    const files: ArchiveFiles = {
      "test.txt": new TextEncoder().encode(content),
    };
    const result = packArchive(files);
    const view = new Uint8Array(result.packed);
    const extracted = new TextDecoder().decode(
      view.slice(result.index[0].o, result.index[0].o + result.index[0].l),
    );
    expect(extracted).toBe(content);
  });
});

describe("parseIpfsResponse", () => {
  it("treats non-CAR data as single index.html", async () => {
    const html = new TextEncoder().encode("<html><body>Hello</body></html>");
    const result = await parseIpfsResponse(html);
    expect(Object.keys(result)).toEqual(["index.html"]);
    expect(new TextDecoder().decode(result["index.html"])).toBe(
      "<html><body>Hello</body></html>",
    );
  });

  it("As a user, I load all inline and nested file bytes in order", async () => {
    // Given
    const blocks: { cid: CID; bytes: Uint8Array }[] = [];

    async function putRaw(bytes: Uint8Array): Promise<CID> {
      const cid = CID.createV1(0x55, await sha256.digest(bytes));
      blocks.push({ cid, bytes });
      return cid;
    }

    async function putNode(node: dagPb.PBNode): Promise<CID> {
      const bytes = dagPb.encode(node);
      const cid = CID.createV1(0x70, await sha256.digest(bytes));
      blocks.push({ cid, bytes });
      return cid;
    }

    // Four distinct raw leaves under two intermediate file stems, so the
    // program bytes are reachable only by recursing through dag-pb chunks.
    const leaves = Array.from({ length: 4 }, (_, i) =>
      new Uint8Array(1024).fill(i + 1),
    );
    const stems: CID[] = [];
    for (let stem = 0; stem < 2; stem++) {
      const pair = leaves.slice(stem * 2, stem * 2 + 2);
      const links = [];
      for (const leaf of pair) {
        links.push({ Hash: await putRaw(leaf), Tsize: leaf.byteLength });
      }
      stems.push(
        await putNode({
          Data: new UnixFS({
            type: "file",
            blockSizes: [1024n, 1024n],
          }).marshal(),
          Links: links,
        }),
      );
    }
    const prefix = new Uint8Array([9, 8, 7]);
    const fileCid = await putNode({
      Data: new UnixFS({
        type: "file",
        data: prefix,
        blockSizes: [2048n, 2048n],
      }).marshal(),
      Links: stems.map((cid) => ({ Hash: cid, Tsize: 2048 })),
    });
    const rootCid = await putNode({
      Data: new UnixFS({ type: "directory" }).marshal(),
      Links: [{ Name: "app.polkavm", Hash: fileCid, Tsize: 4099 }],
    });

    const { writer, out } = CarWriter.create([rootCid]);
    const carChunks: Uint8Array[] = [];
    const collected = (async () => {
      for await (const chunk of out) {
        carChunks.push(chunk);
      }
    })();
    for (const block of blocks) {
      await writer.put(block);
    }
    await writer.close();
    await collected;
    const car = new Uint8Array(
      carChunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    );
    let offset = 0;
    for (const chunk of carChunks) {
      car.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // When
    const result = await parseIpfsResponse(car, rootCid);
    // Then
    expect(result["app.polkavm"]).toEqual(
      new Uint8Array([...prefix, ...leaves.flatMap((leaf) => [...leaf])]),
    );
  });
});
