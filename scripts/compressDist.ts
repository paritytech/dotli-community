// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Writes a .br and a .gz sibling beside each compressible file, for a server to send precompressed.

import { readdir, readFile, stat } from 'node:fs/promises';
import { createBrotliCompress, createGzip, constants } from 'node:zlib';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, type Transform } from 'node:stream';
import { createWriteStream } from 'node:fs';

type FileEntry = {
  path: string;
  size: number;
};

type Params = {
  data: Buffer;
  /** Where the compressed copy is written. */
  outputPath: string;
  compressor: Transform;
};

const DIST = process.env['DIST'] ?? 'dist';
const COMPRESS_EXTENSIONS = new Set(['.js', '.wasm', '.json', '.css', '.html', '.scale', '.dat']);
const MIN_SIZE = 1024;

async function main(): Promise<void> {
  const files = await collectFiles(DIST);
  let totalRaw = 0;
  let totalBr = 0;
  let totalGz = 0;

  console.log(`Compressing ${String(files.length)} files...\n`);

  for (const { path: filePath, size } of files) {
    const data = await readFile(filePath);
    const [brSize, gzSize] = await Promise.all([compressBrotli(filePath, data), compressGzip(filePath, data)]);
    const relativePath = filePath.replace(DIST + '/', '');
    const brotliSaving = ((1 - brSize / size) * 100).toFixed(0);
    console.log(
      `  ${relativePath}: ${formatBytes(size)}, br ${formatBytes(brSize)} (-${brotliSaving}%), gz ${formatBytes(gzSize)}`,
    );
    totalRaw += size;
    totalBr += brSize;
    totalGz += gzSize;
  }

  console.log(
    `\nTotal: ${formatBytes(totalRaw)}, br ${formatBytes(totalBr)} (-${((1 - totalBr / totalRaw) * 100).toFixed(0)}%), gz ${formatBytes(totalGz)}`,
  );
}

async function collectFiles(dir: string): Promise<FileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: FileEntry[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }
    if (!COMPRESS_EXTENSIONS.has(getExtension(entry.name))) {
      continue;
    }
    const info = await stat(fullPath);
    if (info.size < MIN_SIZE) {
      continue;
    }
    files.push({ path: fullPath, size: info.size });
  }
  return files;
}

function getExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index) : '';
}

function compressBrotli(filePath: string, data: Buffer): Promise<number> {
  const compressor = createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
    },
  });
  return writeCompressed({ data, outputPath: filePath + '.br', compressor });
}

function compressGzip(filePath: string, data: Buffer): Promise<number> {
  return writeCompressed({ data, outputPath: filePath + '.gz', compressor: createGzip({ level: 9 }) });
}

async function writeCompressed({ data, outputPath, compressor }: Params): Promise<number> {
  await pipeline(Readable.from(data), compressor, createWriteStream(outputPath));
  const info = await stat(outputPath);
  return info.size;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
