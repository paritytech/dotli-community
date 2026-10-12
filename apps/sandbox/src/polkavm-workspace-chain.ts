// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { WORKSPACE_LIMITS } from "@dotli/shared/workspace-limits";
import type { WorkspaceImportRequest } from "@dotli/ui/workspace-import";
import type { WorkspaceEntry } from "./polkavm-workspace-store";

export interface ChainWorkspace {
  name: string;
  cid: string;
  files: WorkspaceEntry[];
}

export function fetchChainWorkspace(
  address: string,
  parentOrigin: string,
  onStatus: (message: string) => void,
  signal: AbortSignal,
): Promise<ChainWorkspace> {
  signal.throwIfAborted();
  const channel = new MessageChannel();
  const { promise, resolve, reject } = Promise.withResolvers<ChainWorkspace>();
  let finished = false;
  const cleanup = (): void => {
    clearTimeout(availabilityTimer);
    signal.removeEventListener("abort", abort);
    channel.port1.close();
    channel.port2.close();
  };
  const fail = (error: unknown): void => {
    if (finished) return;
    finished = true;
    channel.port1.postMessage({ type: "cancel" });
    cleanup();
    reject(error);
  };
  const abort = (): void => fail(signal.reason);
  // Older standalone hosts have no import bridge. Do not leave a chooser
  // waiting indefinitely for an acknowledgement they will never send.
  const availabilityTimer = setTimeout(() => {
    fail(
      new Error(
        "This host does not provide chain import. Use a current dot.li host or import a local TAR instead.",
      ),
    );
  }, 5000);
  signal.addEventListener("abort", abort, { once: true });
  channel.port1.onmessageerror = () =>
    fail(new Error("The host's chain import response could not be decoded."));
  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    if (finished) return;
    try {
      signal.throwIfAborted();
      const message = event.data;
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message)
      ) {
        throw new Error("Invalid chain import response from the host.");
      }
      if (message?.type === "ready") {
        clearTimeout(availabilityTimer);
      } else if (
        message.type === "progress" &&
        "message" in message &&
        typeof message.message === "string"
      ) {
        onStatus(message.message);
      } else if (
        message.type === "error" &&
        "message" in message &&
        typeof message.message === "string"
      ) {
        fail(new Error(message.message));
      } else if (message.type === "complete" && "archive" in message) {
        const archive = message.archive;
        if (
          typeof archive !== "object" ||
          archive === null ||
          !("name" in archive) ||
          typeof archive.name !== "string" ||
          !("cid" in archive) ||
          typeof archive.cid !== "string" ||
          !("packed" in archive) ||
          !(archive.packed instanceof ArrayBuffer) ||
          !("index" in archive) ||
          !Array.isArray(archive.index) ||
          archive.index.length === 0 ||
          archive.index.length > WORKSPACE_LIMITS.maxFiles ||
          archive.packed.byteLength >
            WORKSPACE_LIMITS.maxFiles * WORKSPACE_LIMITS.maxFileBytes
        )
          throw new Error("Invalid chain archive returned by the host.");
        const packed = archive.packed;
        const files: WorkspaceEntry[] = archive.index.map((entry: unknown) => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            !("p" in entry) ||
            typeof entry.p !== "string" ||
            entry.p.startsWith("/") ||
            !("o" in entry) ||
            typeof entry.o !== "number" ||
            !Number.isSafeInteger(entry.o) ||
            entry.o < 0 ||
            !("l" in entry) ||
            typeof entry.l !== "number" ||
            !Number.isSafeInteger(entry.l) ||
            entry.l < 0 ||
            entry.l > WORKSPACE_LIMITS.maxFileBytes ||
            entry.o + entry.l > packed.byteLength
          )
            throw new Error("Invalid chain archive file returned by the host.");
          return {
            path: `/home/${entry.p}`,
            bytes: new Uint8Array(packed, entry.o, entry.l),
          };
        });
        finished = true;
        cleanup();
        resolve({ name: archive.name, cid: archive.cid, files });
      } else {
        fail(new Error("Invalid chain import response from the host."));
      }
    } catch (error) {
      fail(error);
    }
  };
  try {
    window.parent.postMessage(
      {
        type: "dotli:workspace-import",
        address,
      } satisfies WorkspaceImportRequest,
      parentOrigin,
      [channel.port2],
    );
  } catch (error) {
    fail(error);
  }
  return promise;
}
