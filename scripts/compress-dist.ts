// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Post-build script: generate .br and .gz pre-compressed files for dist/assets.
// Uses Node's built-in zlib, so no extra dependencies are needed.
// Run with: bun scripts/compress-dist.ts

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { join } from "node:path";

const DIST = process.env.DIST ?? "dist";
const COMPRESS_EXTENSIONS = new Set([
  ".js",
  ".wasm",
  ".json",
  ".css",
  ".html",
  ".scale",
]);
const MIN_SIZE = 1024; // Skip files smaller than 1KB

interface FileEntry {
  path: string;
  size: number;
}

async function collectFiles(dir: string): Promise<FileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: FileEntry[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (COMPRESS_EXTENSIONS.has(extOf(entry.name))) {
      const info = await stat(full);
      if (info.size >= MIN_SIZE) {
        files.push({ path: full, size: info.size });
      }
    }
  }
  return files;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i) : "";
}

async function compressBrotli(filePath: string, data: Buffer): Promise<number> {
  const out = filePath + ".br";
  const compressed = brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
    },
  });
  await writeFile(out, compressed);
  return compressed.byteLength;
}

async function compressGzip(filePath: string, data: Buffer): Promise<number> {
  const out = filePath + ".gz";
  const compressed = gzipSync(data, { level: 9 });
  await writeFile(out, compressed);
  return compressed.byteLength;
}

function fmt(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

async function main(): Promise<void> {
  const files = await collectFiles(DIST);
  let totalRaw = 0;
  let totalBr = 0;
  let totalGz = 0;

  console.log(`Compressing ${files.length} files...\n`);

  for (const { path: filePath, size } of files) {
    const data = await readFile(filePath);
    const [brSize, gzSize] = await Promise.all([
      compressBrotli(filePath, data),
      compressGzip(filePath, data),
    ]);
    const rel = filePath.replace(DIST + "/", "");
    const brPct = ((1 - brSize / size) * 100).toFixed(0);
    console.log(
      `  ${rel}: ${fmt(size)} → br ${fmt(brSize)} (-${brPct}%) / gz ${fmt(gzSize)}`,
    );
    totalRaw += size;
    totalBr += brSize;
    totalGz += gzSize;
  }

  console.log(
    `\nTotal: ${fmt(totalRaw)} → br ${fmt(totalBr)} (-${((1 - totalBr / totalRaw) * 100).toFixed(0)}%) / gz ${fmt(totalGz)}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
