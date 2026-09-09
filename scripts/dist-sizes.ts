// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared sizing helpers for the bundle-size tooling.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface Sizes {
  raw: number;
  br: number;
  gz: number;
}

export interface FileSizes extends Sizes {
  name: string;
}

export function stripHash(name: string): string {
  return name.replace(/-[A-Za-z0-9_-]{8}\./, ".");
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatDelta(current: number, base?: number): string {
  if (base === undefined || base === 0 || current === base) {
    return "";
  }
  const diff = current - base;
  const sign = diff > 0 ? "+" : "-";
  return `${sign}${formatBytes(Math.abs(diff))}`;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (!entry.name.endsWith(".br") && !entry.name.endsWith(".gz")) {
      files.push(full);
    }
  }
  return files;
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

// A file with no sidecar falls back to its raw size because that is what nginx
// serves: dotli-precompressed.conf enables brotli_static and gzip_static only,
// with no dynamic compression, so an uncompressed file goes out uncompressed.
export async function collectDistSizes(
  distDir: string,
  appName: string,
): Promise<FileSizes[]> {
  const files = await walk(distDir);
  const sizes: FileSizes[] = [];
  for (const file of files.sort()) {
    const raw = await sizeOf(file);
    if (raw === undefined) continue;
    const rel = file.slice(distDir.length + 1);
    sizes.push({
      name: stripHash(`${appName}/${rel}`),
      raw,
      br: (await sizeOf(`${file}.br`)) ?? raw,
      gz: (await sizeOf(`${file}.gz`)) ?? raw,
    });
  }
  return sizes;
}

export function sumSizes(files: FileSizes[]): Sizes {
  return files.reduce<Sizes>(
    (acc, f) => ({
      raw: acc.raw + f.raw,
      br: acc.br + f.br,
      gz: acc.gz + f.gz,
    }),
    { raw: 0, br: 0, gz: 0 },
  );
}
