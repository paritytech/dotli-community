// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { WORKSPACE_LIMITS } from "@dotli/shared/workspace-limits";
import {
  type WorkspaceEntry,
  type WorkspaceSnapshot,
} from "./polkavm-workspace-store";

const BLOCK = 512;
const MAX_PAX_BYTES = 4096;
const MAX_HEADERS =
  (WORKSPACE_LIMITS.maxFiles + WORKSPACE_LIMITS.maxDirectories + 1) * 2 + 16;
// Bound input before reading it into memory, including extended headers and padding.
export const WORKSPACE_TAR_MAX_BYTES =
  WORKSPACE_LIMITS.maxFiles * WORKSPACE_LIMITS.maxFileBytes +
  MAX_HEADERS * (BLOCK + MAX_PAX_BYTES) +
  10240;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Tree = {
  kinds: Map<string, 1 | 2>;
  declared: Set<string>;
  files: number;
  directories: number;
};

function tree(): Tree {
  return {
    kinds: new Map([["/home", 2]]),
    declared: new Set(),
    files: 0,
    directories: 0,
  };
}

function addPath(target: Tree, path: string, kind: 1 | 2): void {
  const encoded = encoder.encode(path);
  if (
    (path !== "/home" && !path.startsWith("/home/")) ||
    encoded.length > WORKSPACE_LIMITS.maxPathBytes ||
    decoder.decode(encoded) !== path ||
    path.includes("\0") ||
    path
      .slice(1)
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid workspace path: ${path}`);
  }
  if (target.declared.has(path)) {
    throw new Error(`Duplicate archive path: ${path}`);
  }
  const parts = path.split("/");
  for (let index = 2; index < parts.length; index++) {
    const parent = parts.slice(0, index).join("/");
    if (target.kinds.get(parent) === 1) {
      throw new Error(`A file is also used as a directory: ${parent}`);
    }
    if (!target.kinds.has(parent)) {
      target.kinds.set(parent, 2);
      target.directories++;
    }
  }
  const previous = target.kinds.get(path);
  if (previous !== undefined && (previous !== kind || kind === 1)) {
    throw new Error(`Conflicting file and directory paths: ${path}`);
  }
  if (previous === undefined) {
    target.kinds.set(path, kind);
    if (kind === 1) target.files++;
    else target.directories++;
  }
  target.declared.add(path);
  if (
    target.files > WORKSPACE_LIMITS.maxFiles ||
    target.directories > WORKSPACE_LIMITS.maxDirectories
  ) {
    throw new Error(
      `Project exceeds ${WORKSPACE_LIMITS.maxFiles} files or ${WORKSPACE_LIMITS.maxDirectories} directories. Split it into smaller projects.`,
    );
  }
}

function tarPath(value: string, directory: boolean): string {
  if (!value) throw new Error("Archive entry has an empty path.");
  if (value.startsWith("/")) {
    throw new Error(`Absolute archive paths are not allowed: ${value}`);
  }
  while (value.startsWith("./")) value = value.slice(2);
  if (directory && value.endsWith("/")) value = value.slice(0, -1);
  if (directory && (value === "" || value === ".")) return "/home";
  if (!value) throw new Error("Archive entry has an empty path.");
  return `/home/${value}`;
}

function field(header: Uint8Array, start: number, size: number): string {
  const end = header.indexOf(0, start);
  return decoder.decode(
    header.subarray(start, end < 0 || end >= start + size ? start + size : end),
  );
}

function octal(header: Uint8Array, start: number, size: number): number {
  const value = decoder
    .decode(header.subarray(start, start + size))
    .replace(/^[\0 ]+|[\0 ]+$/g, "");
  if (!/^[0-7]*$/.test(value))
    throw new Error("Invalid TAR numeric field (expected octal).");
  const number = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(number))
    throw new Error("TAR numeric field is too large.");
  return number;
}

function verifyHeader(header: Uint8Array): void {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (sum !== octal(header, 148, 8))
    throw new Error("TAR header checksum is invalid.");
  const magic = field(header, 257, 6);
  if (magic !== "" && magic !== "ustar" && magic !== "ustar ") {
    throw new Error(
      "Unsupported TAR format. Export an uncompressed USTAR or PAX archive.",
    );
  }
}

function paxRecords(bytes: Uint8Array): Map<string, string> {
  const values = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0 || space - offset > 8)
      throw new Error("Malformed PAX record length.");
    const digits = decoder.decode(bytes.subarray(offset, space));
    if (!/^[1-9][0-9]*$/.test(digits))
      throw new Error("Malformed PAX record length.");
    const length = Number(digits);
    const end = offset + length;
    if (end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) {
      throw new Error("Truncated or malformed PAX record.");
    }
    const record = decoder.decode(bytes.subarray(space + 1, end - 1));
    const equal = record.indexOf("=");
    if (equal <= 0 || record.includes("\0"))
      throw new Error("Malformed PAX attribute.");
    const key = record.slice(0, equal);
    const value = record.slice(equal + 1);
    if (values.has(key)) throw new Error(`Duplicate PAX attribute: ${key}`);
    if (
      /sparse/i.test(key) ||
      key === "SCHILY.filetype" ||
      (key === "hdrcharset" &&
        value !== "ISO-IR 10646 2000 UTF-8" &&
        value !== "")
    ) {
      throw new Error(
        "Sparse, special-node, or non-UTF-8 TAR entries are not supported.",
      );
    }
    values.set(key, value);
    offset = end;
  }
  return values;
}

function applyPax(
  target: Map<string, string>,
  values: Map<string, string>,
): void {
  for (const [key, value] of values) {
    if (value === "") target.delete(key);
    else target.set(key, value);
  }
}

/** Parse and validate the entire archive before the caller creates any project. */
export function importWorkspaceTar(bytes: Uint8Array): {
  files: WorkspaceEntry[];
  directories: string[];
} {
  if (bytes.byteLength > WORKSPACE_TAR_MAX_BYTES) {
    throw new Error(
      "TAR archive is too large. Split the project into smaller archives.",
    );
  }
  if (bytes.byteLength < BLOCK * 2 || bytes.byteLength % BLOCK !== 0) {
    throw new Error(
      "Truncated TAR archive. Choose an uncompressed .tar file, not .tar.gz or .zip.",
    );
  }
  const target = tree();
  const files: WorkspaceEntry[] = [];
  const globalPax = new Map<string, string>();
  let localPax: Map<string, string> | null = null;
  let offset = 0;
  let headers = 0;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (
        bytes.length - offset < BLOCK * 2 ||
        localPax !== null ||
        !bytes.subarray(offset).every((byte) => byte === 0)
      ) {
        throw new Error(
          "Malformed TAR end marker, dangling PAX header, or trailing data.",
        );
      }
      return {
        files,
        directories: [...target.kinds]
          .filter(([path, kind]) => kind === 2 && path !== "/home")
          .map(([path]) => path),
      };
    }
    if (++headers > MAX_HEADERS)
      throw new Error("TAR archive contains too many headers.");
    verifyHeader(header);
    const type = header[156];
    if (
      type !== 0 &&
      type !== 48 &&
      type !== 53 &&
      type !== 120 &&
      type !== 103
    ) {
      throw new Error(
        "Only regular files and directories can be imported. Remove links and special nodes from the TAR.",
      );
    }
    if (field(header, 157, 100) !== "")
      throw new Error("TAR links are not supported.");
    const extended = type === 120 || type === 103;
    let attributes: Map<string, string> | undefined;
    let size = octal(header, 124, 12);
    if (!extended) {
      attributes = new Map(globalPax);
      if (localPax !== null) applyPax(attributes, localPax);
      localPax = null;
      if (attributes.has("linkpath"))
        throw new Error("PAX links are not supported.");
      const value = attributes.get("size");
      if (value !== undefined) {
        if (!/^(0|[1-9][0-9]*)$/.test(value))
          throw new Error("Invalid PAX file size.");
        size = Number(value);
      }
    }
    const limit = extended ? MAX_PAX_BYTES : WORKSPACE_LIMITS.maxFileBytes;
    if (!Number.isSafeInteger(size) || size > limit) {
      throw new Error(
        extended
          ? "TAR extended metadata is too large."
          : "A file exceeds the 1 MiB workspace limit.",
      );
    }
    const start = offset + BLOCK;
    const end = start + size;
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (offset > bytes.length)
      throw new Error("TAR entry contents are truncated.");
    if (extended) {
      if (localPax !== null)
        throw new Error(
          "A PAX header must be followed by its file or directory.",
        );
      const values = paxRecords(bytes.subarray(start, end));
      if (type === 103) applyPax(globalPax, values);
      else localPax = values;
      continue;
    }
    const directory = type === 53;
    if (directory && size !== 0)
      throw new Error("TAR directories must not contain file data.");
    const name = field(header, 0, 100);
    const prefix = field(header, 257, 6).startsWith("ustar")
      ? field(header, 345, 155)
      : "";
    const path = tarPath(
      attributes?.get("path") ?? (prefix ? `${prefix}/${name}` : name),
      directory,
    );
    addPath(target, path, directory ? 2 : 1);
    if (!directory) files.push({ path, bytes: bytes.subarray(start, end) });
  }
  throw new Error("TAR archive is missing its two-block end marker.");
}

function writeText(header: Uint8Array, offset: number, value: string): void {
  header.set(encoder.encode(value), offset);
}

function makeHeader(
  name: string,
  prefix: string,
  type: string,
  size: number,
  mtime: number,
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(BLOCK);
  writeText(header, 0, name);
  writeText(header, 100, type === "5" ? "0000755\0" : "0000644\0");
  writeText(header, 108, "0000000\0");
  writeText(header, 116, "0000000\0");
  writeText(header, 124, `${size.toString(8).padStart(11, "0")}\0`);
  writeText(header, 136, `${mtime.toString(8).padStart(11, "0")}\0`);
  header.fill(32, 148, 156);
  writeText(header, 156, type);
  writeText(header, 257, "ustar\0");
  writeText(header, 263, "00");
  writeText(header, 345, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function ustarPath(path: string): { name: string; prefix: string } | null {
  if (!/^[\x20-\x7e]*$/.test(path)) return null;
  if (path.length <= 100) return { name: path, prefix: "" };
  for (
    let slash = path.lastIndexOf("/");
    slash > 0;
    slash = path.lastIndexOf("/", slash - 1)
  ) {
    if (
      slash <= 155 &&
      path.length - slash - 1 <= 100 &&
      slash < path.length - 1
    ) {
      return { name: path.slice(slash + 1), prefix: path.slice(0, slash) };
    }
  }
  return null;
}

function paxPath(path: string): Uint8Array<ArrayBuffer> {
  const payload = ` path=${path}\n`;
  const size = encoder.encode(payload).length;
  let length = size + 1;
  while (length !== size + String(length).length)
    length = size + String(length).length;
  return encoder.encode(`${length}${payload}`);
}

/** Export a persisted snapshot, never just open editor buffers or changed files. */
export function exportWorkspaceTar(snapshot: WorkspaceSnapshot): Blob {
  const target = tree();
  const contents = new Map<string, Uint8Array>();
  for (const file of snapshot.files) {
    if (contents.has(file.path))
      throw new Error(`Duplicate saved file: ${file.path}`);
    if (
      !(file.bytes instanceof Uint8Array) ||
      file.bytes.byteLength > WORKSPACE_LIMITS.maxFileBytes
    ) {
      throw new Error(`Invalid or oversized saved file: ${file.path}`);
    }
    contents.set(file.path, file.bytes);
  }
  for (const entry of snapshot.metadata.entries) {
    if (entry.kind !== 1 && entry.kind !== 2)
      throw new Error(`Unsupported saved node: ${entry.path}`);
    addPath(target, entry.path, entry.kind);
    if (entry.kind === 1 && !contents.has(entry.path))
      throw new Error(`Saved file data is missing: ${entry.path}`);
    if (entry.kind === 2 && contents.has(entry.path))
      throw new Error(`Saved directory contains file data: ${entry.path}`);
  }
  for (const path of contents.keys()) {
    if (target.kinds.get(path) !== 1)
      throw new Error(`Saved file metadata is missing: ${path}`);
  }
  const parts: BlobPart[] = [];
  const padding = new Uint8Array(BLOCK);
  const entries = [...snapshot.metadata.entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  for (const [index, entry] of entries.entries()) {
    if (entry.path === "/home") continue;
    const path =
      entry.path.slice("/home/".length) + (entry.kind === 2 ? "/" : "");
    const seconds = BigInt(entry.mtimeNs) / 1_000_000_000n;
    const mtime = Number(
      seconds < 0n ? 0n : seconds > 0o77777777777n ? 0o77777777777n : seconds,
    );
    let headerPath = ustarPath(path);
    if (headerPath === null) {
      const record = paxPath(path);
      parts.push(
        makeHeader(`PaxHeaders/entry-${index}`, "", "x", record.length, mtime),
        record,
      );
      if (record.length % BLOCK !== 0)
        parts.push(padding.subarray(0, BLOCK - (record.length % BLOCK)));
      headerPath = { name: `entry-${index}`, prefix: "" };
    }
    const bytes = contents.get(entry.path);
    parts.push(
      makeHeader(
        headerPath.name,
        headerPath.prefix,
        entry.kind === 2 ? "5" : "0",
        bytes?.length ?? 0,
        mtime,
      ),
    );
    if (bytes !== undefined) {
      if (!(bytes.buffer instanceof ArrayBuffer))
        throw new Error("Saved files must use non-shared byte buffers.");
      parts.push(
        new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
      if (bytes.length % BLOCK !== 0)
        parts.push(padding.subarray(0, BLOCK - (bytes.length % BLOCK)));
    }
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return new Blob(parts, { type: "application/x-tar" });
}
