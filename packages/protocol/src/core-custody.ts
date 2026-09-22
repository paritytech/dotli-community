// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Host-shell transport only. Never exposed through the product RPC bridge. */
export type CoreCustodyOperation =
  | { action: "acquire"; walletRevision: string | null }
  | { action: "release"; lease: string }
  | { action: "read"; lease: string; key: string }
  | { action: "clear"; lease: string; key: string }
  | { action: "write"; lease: string; key: string; value: Uint8Array }
  | { action: "readSource"; lease: string; sourceId: string }
  | { action: "releaseSource"; lease: string; sourceId: string }
  | {
      action: "putSources";
      lease: string;
      sources: { sourceId: string; blob: Blob }[];
    };

export function isCoreCustodyOperation(
  value: unknown,
): value is CoreCustodyOperation {
  if (typeof value !== "object" || value === null || !("action" in value)) {
    return false;
  }
  if (value.action === "acquire") {
    return (
      "walletRevision" in value &&
      (value.walletRevision === null ||
        typeof value.walletRevision === "string")
    );
  }
  if (!("lease" in value) || typeof value.lease !== "string") {
    return false;
  }
  if (value.action === "release") {
    return true;
  }
  if (value.action === "readSource" || value.action === "releaseSource") {
    return (
      "sourceId" in value &&
      typeof value.sourceId === "string" &&
      /^[a-zA-Z0-9-]{1,128}$/.test(value.sourceId)
    );
  }
  if (value.action === "putSources") {
    return (
      "sources" in value &&
      Array.isArray(value.sources) &&
      value.sources.length > 0 &&
      value.sources.length <= 32 &&
      value.sources.every(
        (source: unknown) =>
          typeof source === "object" &&
          source !== null &&
          "sourceId" in source &&
          typeof source.sourceId === "string" &&
          /^[a-zA-Z0-9-]{1,128}$/.test(source.sourceId) &&
          "blob" in source &&
          source.blob instanceof Blob &&
          source.blob.size <= 0xffff_ffff,
      )
    );
  }
  if (
    !("key" in value) ||
    typeof value.key !== "string" ||
    !/^[0-9a-f]{2,8192}$/.test(value.key) ||
    value.key.length % 2 !== 0
  ) {
    return false;
  }
  return (
    value.action === "read" ||
    value.action === "clear" ||
    (value.action === "write" &&
      "value" in value &&
      value.value instanceof Uint8Array &&
      value.value.byteLength <= 32 * 1024 * 1024)
  );
}
