// @vitest-environment node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  exportWorkspaceTar,
  importWorkspaceTar,
} from "./polkavm-workspace-archive";
import { WORKSPACE_LIMITS } from "@dotli/shared/workspace-limits";
import { type WorkspaceSnapshot } from "./polkavm-workspace-store";

const encoder = new TextEncoder();

type TarEntry = {
  name: string;
  prefix?: string;
  type?: string;
  bytes?: Uint8Array;
  size?: number;
};

// Independent USTAR fixtures also cover imports not produced by our exporter.
function tar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    header.set(encoder.encode(entry.name));
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    header.set(
      encoder.encode(
        `${(entry.size ?? entry.bytes?.length ?? 0).toString(8).padStart(11, "0")}\0`,
      ),
      124,
    );
    header.set(encoder.encode("00000000000\0"), 136);
    header.fill(32, 148, 156);
    header.set(encoder.encode(entry.type ?? "0"), 156);
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    header.set(encoder.encode(entry.prefix ?? ""), 345);
    header.set(
      encoder.encode(
        `${header
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, "0")}\0 `,
      ),
      148,
    );
    parts.push(header);
    if (entry.bytes !== undefined) {
      parts.push(entry.bytes);
      if (entry.bytes.length % 512)
        parts.push(new Uint8Array(512 - (entry.bytes.length % 512)));
    }
  }
  parts.push(new Uint8Array(1024));
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function pax(key: string, value: string): Uint8Array {
  const suffix = ` ${key}=${value}\n`;
  const bytes = encoder.encode(suffix).length;
  let length = bytes + 1;
  while (length !== bytes + String(length).length)
    length = bytes + String(length).length;
  return encoder.encode(`${length}${suffix}`);
}

function snapshot(
  files: WorkspaceSnapshot["files"],
  directories: string[],
): WorkspaceSnapshot {
  const entries: WorkspaceSnapshot["metadata"]["entries"] = [
    ...directories.map((path) => ({
      path,
      kind: 2 as const,
      inode: "",
      mtimeNs: "1234567890000000000",
    })),
    ...files.map(({ path }) => ({
      path,
      kind: 1 as const,
      inode: "",
      mtimeNs: "1234567890000000000",
    })),
  ].map((entry, index) => ({ ...entry, inode: String(index + 1) }));
  return {
    project: {
      id: "local-test-project",
      name: "Unicode project",
      revision: 7,
      createdAt: 1,
      updatedAt: 2,
    },
    files,
    metadata: {
      version: 1,
      nextInode: String(entries.length + 1),
      clockNs: "1234567890000000001",
      entries,
    },
  };
}

describe("browser workspace TAR", () => {
  it("round-trips every saved binary file, Unicode and long paths, hidden files, and empty directories", async () => {
    const prefix = "a".repeat(110);
    const project = snapshot(
      [
        {
          path: "/home/.hidden",
          bytes: new Uint8Array([0, 255, 13, 10, 195, 40]),
        },
        {
          path: `/home/目录/${"é".repeat(80)}.txt`,
          bytes: encoder.encode("unchanged saved text\r\n"),
        },
        { path: `/home/${"b".repeat(194)}`, bytes: new Uint8Array(0) },
        { path: `/home/${prefix}/leaf`, bytes: new Uint8Array([42]) },
        { path: "/home/\ufeffname", bytes: new Uint8Array([1]) },
        { path: "/home/literal\\name:one", bytes: new Uint8Array([2]) },
        { path: "/home/line\nbreak", bytes: new Uint8Array([3]) },
      ],
      [
        "/home",
        "/home/empty",
        "/home/.hidden-dir",
        "/home/目录",
        `/home/${prefix}`,
      ],
    );
    const restored = importWorkspaceTar(
      new Uint8Array(await exportWorkspaceTar(project).arrayBuffer()),
    );
    expect(
      new Map(restored.files.map(({ path, bytes }) => [path, [...bytes]])),
    ).toEqual(
      new Map(project.files.map(({ path, bytes }) => [path, [...bytes]])),
    );
    expect(new Set(restored.directories)).toEqual(
      new Set(
        project.metadata.entries
          .filter((entry) => entry.kind === 2 && entry.path !== "/home")
          .map((entry) => entry.path),
      ),
    );
  });

  it("imports independent USTAR prefixes and a directory declared after its child", () => {
    const imported = importWorkspaceTar(
      tar([
        { name: "./", type: "5" },
        { prefix: "tree", name: ".hidden", bytes: new Uint8Array([0, 254]) },
        { name: "tree/", type: "5" },
      ]),
    );
    expect(imported.files).toEqual([
      { path: "/home/tree/.hidden", bytes: new Uint8Array([0, 254]) },
    ]);
    expect(imported.directories).toEqual(["/home/tree"]);
  });

  it("uses byte-counted PAX paths and does not leak a local path override to the next file", () => {
    const path = `目录/${"界".repeat(40)}`;
    const imported = importWorkspaceTar(
      tar([
        { name: "pax", type: "x", bytes: pax("path", path) },
        { name: "placeholder", bytes: new Uint8Array([255]) },
        { name: "next", bytes: new Uint8Array([7]) },
      ]),
    );
    expect(imported.files.map(({ path, bytes }) => [path, [...bytes]])).toEqual(
      [
        [`/home/${path}`, [255]],
        ["/home/next", [7]],
      ],
    );
  });

  it("rejects traversal in a PAX override before exposing any imported tree", () => {
    expect(() =>
      importWorkspaceTar(
        tar([
          { name: "valid", bytes: new Uint8Array([1]) },
          { name: "pax", type: "x", bytes: pax("path", "../outside") },
          { name: "innocent" },
        ]),
      ),
    ).toThrow();
  });

  it("rejects absolute paths, duplicate aliases, and file-versus-parent collisions", () => {
    expect(() => importWorkspaceTar(tar([{ name: "/absolute" }]))).toThrow();
    expect(() =>
      importWorkspaceTar(tar([{ name: "same" }, { name: "./same" }])),
    ).toThrow();
    expect(() =>
      importWorkspaceTar(tar([{ name: "tree/child" }, { name: "tree" }])),
    ).toThrow();
  });

  it.each(["1", "2", "3", "4", "6"])(
    "rejects unsupported TAR node type %s",
    (type) => {
      expect(() => importWorkspaceTar(tar([{ name: "node", type }]))).toThrow();
    },
  );

  it("rejects checksum damage, missing content, missing end markers, and trailing archives", () => {
    const damaged = tar([{ name: "file" }]);
    damaged[0] ^= 1;
    expect(() => importWorkspaceTar(damaged)).toThrow();
    expect(() =>
      importWorkspaceTar(
        tar([{ name: "short", bytes: new Uint8Array([1]), size: 2048 }]),
      ),
    ).toThrow();
    const intact = tar([{ name: "file" }]);
    expect(() =>
      importWorkspaceTar(intact.subarray(0, intact.length - 512)),
    ).toThrow();
    const concatenated = new Uint8Array(intact.length * 2);
    concatenated.set(intact);
    concatenated.set(intact, intact.length);
    expect(() => importWorkspaceTar(concatenated)).toThrow();
  });

  it("rejects malformed and dangling PAX records and sparse expansion", () => {
    expect(() =>
      importWorkspaceTar(
        tar([
          { name: "pax", type: "x", bytes: encoder.encode("99 path=x\n") },
          { name: "x" },
        ]),
      ),
    ).toThrow();
    expect(() =>
      importWorkspaceTar(
        tar([{ name: "pax", type: "x", bytes: pax("path", "x") }]),
      ),
    ).toThrow();
    expect(() =>
      importWorkspaceTar(
        tar([
          {
            name: "pax",
            type: "x",
            bytes: pax("GNU.sparse.size", "999999999"),
          },
          { name: "x" },
        ]),
      ),
    ).toThrow();
  });

  it("enforces file-size, file-count, inferred-directory and UTF-8 path limits", () => {
    expect(() =>
      importWorkspaceTar(
        tar([{ name: "large", size: WORKSPACE_LIMITS.maxFileBytes + 1 }]),
      ),
    ).toThrow();
    expect(() =>
      importWorkspaceTar(
        tar(
          Array.from({ length: WORKSPACE_LIMITS.maxFiles + 1 }, (_, index) => ({
            name: `file-${index}`,
          })),
        ),
      ),
    ).toThrow();
    expect(() =>
      importWorkspaceTar(
        tar([
          ...Array.from(
            { length: WORKSPACE_LIMITS.maxDirectories },
            (_, index) => ({ name: `dir-${index}/`, type: "5" }),
          ),
          { name: "inferred/file" },
        ]),
      ),
    ).toThrow();
    expect(() =>
      importWorkspaceTar(
        tar([
          { name: "pax", type: "x", bytes: pax("path", "é".repeat(98)) },
          { name: "long" },
        ]),
      ),
    ).toThrow();
  });

  it("refuses to silently omit saved file bytes missing from snapshot metadata", () => {
    const project = snapshot(
      [{ path: "/home/orphan", bytes: new Uint8Array([1]) }],
      ["/home"],
    );
    project.metadata.entries = project.metadata.entries.filter(
      (entry) => entry.kind === 2,
    );
    expect(() => exportWorkspaceTar(project)).toThrow();
  });
});
