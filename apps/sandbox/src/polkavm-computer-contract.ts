// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const DOT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function expectedComputerHostOrigin(
  sandboxHostname: string,
  protocol: string,
  port: string,
  baseDomain: string,
  ancestorOrigin: string | null,
  referrer: string,
): string | null {
  if (protocol !== "https:" && protocol !== "http:") {
    return null;
  }
  const localSuffix = ".app.localhost";
  const productionSuffix = `.app.${baseDomain}`;
  const local = sandboxHostname.endsWith(localSuffix);
  const suffix = local ? localSuffix : productionSuffix;
  if (!sandboxHostname.endsWith(suffix)) {
    return null;
  }
  const label = sandboxHostname.slice(0, -suffix.length);
  if (!DOT_LABEL.test(label) || (!local && protocol !== "https:")) {
    return null;
  }

  const host = local ? `${label}.localhost` : `${label}.${baseDomain}`;
  const expected = `${protocol}//${host}${port === "" ? "" : `:${port}`}`;
  for (const candidate of [ancestorOrigin, referrer]) {
    if (candidate === null || candidate === "") {
      continue;
    }
    try {
      if (new URL(candidate).origin !== expected) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return expected;
}

interface ComputerDatabase {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): void;
}

export function computerNetworkEnabled(
  requested: boolean,
  relayUrl: string,
): boolean {
  return requested && relayUrl !== "";
}

export function ensureComputerDatabaseStores(database: ComputerDatabase): void {
  for (const name of ["saves", "translations"]) {
    if (!database.objectStoreNames.contains(name)) {
      database.createObjectStore(name);
    }
  }
}

export interface NetworkPermissionSession {
  decide(domain: string, request: () => Promise<boolean>): Promise<boolean>;
}

export function createNetworkPermissionSession(
  maxDistinctDomains: number,
  maxConcurrentRequests: number,
): NetworkPermissionSession {
  const decisions = new Map<string, Promise<boolean>>();
  let pending = 0;
  return {
    decide(domain, request) {
      const key = domain.toLowerCase().replace(/\.$/, "");
      if (key === "") {
        return Promise.resolve(false);
      }
      const existing = decisions.get(key);
      if (existing !== undefined) {
        return existing;
      }
      if (
        decisions.size >= maxDistinctDomains ||
        pending >= maxConcurrentRequests
      ) {
        return Promise.resolve(false);
      }
      pending += 1;
      const decision = Promise.resolve()
        .then(request)
        .finally(() => {
          pending -= 1;
        });
      decisions.set(key, decision);
      void decision.catch(() => {
        if (decisions.get(key) === decision) {
          decisions.delete(key);
        }
      });
      return decision;
    },
  };
}

export function createRetryableLazyPromise<T>(
  factory: () => Promise<T>,
): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return (): Promise<T> => {
    if (cached !== null) {
      return cached;
    }
    const attempt = factory();
    cached = attempt;
    void attempt.catch(() => {
      if (cached === attempt) {
        cached = null;
      }
    });
    return attempt;
  };
}

export const MAX_SAVE_BYTES = 64 * 1024 * 1024 + 128 * 1024;
const SAVE_FORMAT_VERSION = 2;
const filesystemDecoder = new TextDecoder("utf-8", { fatal: true });
const filesystemEncoder = new TextEncoder();

export interface FilesystemMetadata {
  version: 1;
  nextInode: string;
  clockNs: string;
  entries: {
    path: string;
    kind: 1 | 2;
    mtimeNs: string;
    inode: string;
  }[];
}

export interface SavedFilesystem {
  files: Map<string, Uint8Array>;
  metadata: FilesystemMetadata | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes;
}

export function encodeFilesystem(
  files: Map<string, Uint8Array>,
  metadata: FilesystemMetadata,
): Uint8Array | null {
  const metadataBytes = filesystemEncoder.encode(JSON.stringify(metadata));
  let total = 5 + metadataBytes.byteLength;
  for (const [path, bytes] of files) {
    total += 8 + filesystemEncoder.encode(path).byteLength + bytes.byteLength;
  }
  if (total > MAX_SAVE_BYTES) {
    return null;
  }
  const record = new Uint8Array(total);
  const view = new DataView(record.buffer);
  record[0] = SAVE_FORMAT_VERSION;
  view.setUint32(1, metadataBytes.byteLength, true);
  record.set(metadataBytes, 5);
  let offset = 5 + metadataBytes.byteLength;
  for (const [path, bytes] of files) {
    const pathBytes = filesystemEncoder.encode(path);
    view.setUint32(offset, pathBytes.byteLength, true);
    record.set(pathBytes, offset + 4);
    offset += 4 + pathBytes.byteLength;
    view.setUint32(offset, bytes.byteLength, true);
    record.set(bytes, offset + 4);
    offset += 4 + bytes.byteLength;
  }
  return record;
}

export function decodeFilesystem(record: Uint8Array): SavedFilesystem {
  const files = new Map<string, Uint8Array>();
  if (record.byteLength === 0) {
    return { files, metadata: null };
  }
  const version = record[0];
  if (version !== 1 && version !== SAVE_FORMAT_VERSION) {
    throw new Error("unsupported computer filesystem save version");
  }
  const view = new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength,
  );
  let offset = 1;
  let metadata: FilesystemMetadata | null = null;
  const readBytes = (): Uint8Array => {
    if (offset + 4 > record.byteLength) {
      throw new Error("truncated computer filesystem save");
    }
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > record.byteLength - offset) {
      throw new Error("truncated computer filesystem save");
    }
    const bytes = record.subarray(offset, offset + length);
    offset += length;
    return bytes;
  };
  if (version === SAVE_FORMAT_VERSION) {
    const value: unknown = JSON.parse(filesystemDecoder.decode(readBytes()));
    const candidate = object(value);
    if (
      candidate?.version !== 1 ||
      typeof candidate.nextInode !== "string" ||
      typeof candidate.clockNs !== "string" ||
      !Array.isArray(candidate.entries)
    ) {
      throw new Error("invalid computer filesystem metadata");
    }
    // The runtime validates every path, inode, timestamp and file/directory
    // relation atomically before starting the guest.
    metadata = value as FilesystemMetadata;
  }
  while (offset < record.byteLength) {
    const path = filesystemDecoder.decode(readBytes());
    const bytes = readBytes();
    if (files.has(path)) {
      throw new Error("duplicate path in computer filesystem save");
    }
    files.set(path, ownedBytes(bytes));
  }
  return { files, metadata };
}
