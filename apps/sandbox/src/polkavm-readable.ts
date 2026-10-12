// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { WORKSPACE_LIMITS } from "@dotli/shared/workspace-limits";

export interface ReadableFormatter {
  /** Consumes the supplied owned byte buffer; do not reuse it after this call. */
  format(path: string, bytes: Uint8Array): Promise<Uint8Array>;
  close(): void;
}

export type ReadableFormatRequest = {
  id: number;
  path: string;
  bytes: Uint8Array;
};

export type ReadableFormatResult =
  | { id: number; ok: true; bytes: Uint8Array }
  | { id: number; ok: false; error: string };

type PendingFormat = {
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: number;
};

const COMPUTE_TIMEOUT_MS = 15_000;

export function createReadableFormatter(): ReadableFormatter {
  let worker: Worker | undefined;
  let closed = false;
  let nextId = 0;
  const pending = new Map<number, PendingFormat>();

  const stop = (error: Error): void => {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const start = (): Worker => {
    if (worker) return worker;
    worker = new Worker(
      new URL("./polkavm-readable-worker.ts", import.meta.url),
      {
        type: "module",
        name: "polkavm-readable",
      },
    );
    worker.onmessage = (event: MessageEvent<ReadableFormatResult>): void => {
      const result = event.data;
      if (!result || !Number.isSafeInteger(result.id)) {
        stop(new Error("Formatter worker returned an invalid response."));
        return;
      }
      const request = pending.get(result.id);
      if (!request) return;
      if (
        (result.ok !== true && result.ok !== false) ||
        (result.ok &&
          (!(result.bytes instanceof Uint8Array) ||
            result.bytes.byteLength > WORKSPACE_LIMITS.maxFileBytes)) ||
        (!result.ok && typeof result.error !== "string")
      ) {
        stop(
          new Error("Formatter worker returned invalid or oversized output."),
        );
        return;
      }
      clearTimeout(request.timer);
      pending.delete(result.id);
      if (result.ok) request.resolve(result.bytes);
      else request.reject(new Error(result.error.slice(0, 512)));
    };
    worker.onerror = (event): void => {
      stop(
        new Error(`Formatter worker failed: ${event.message}`.slice(0, 512)),
      );
    };
    worker.onmessageerror = (): void => {
      stop(new Error("Formatter worker response could not be decoded."));
    };
    return worker;
  };

  return {
    async format(path, bytes) {
      if (closed) throw new Error("Readable formatter is closed.");
      if (
        typeof path !== "string" ||
        path.length > WORKSPACE_LIMITS.maxPathBytes
      ) {
        throw new Error("Invalid formatter path.");
      }
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength > WORKSPACE_LIMITS.maxFileBytes
      ) {
        throw new Error(
          "Formatter input must be bytes within the 1 MiB file limit.",
        );
      }
      // Transfer the normal owned input directly. A view or shared buffer needs
      // its own allocation so transferring it cannot detach unrelated bytes.
      const owned =
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
          ? bytes
          : bytes.slice();
      let active: Worker;
      try {
        active = start();
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown error";
        throw new Error(
          `Could not start formatter worker: ${detail}`.slice(0, 512),
        );
      }
      const id = ++nextId;
      return new Promise<Uint8Array>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          // This only bounds formatter computation, never durable persistence.
          // Terminate stuck parser code and allow a fresh worker on the next call.
          stop(new Error("Formatting timed out after 15 seconds."));
        }, COMPUTE_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try {
          active.postMessage(
            { id, path, bytes: owned } satisfies ReadableFormatRequest,
            [owned.buffer as ArrayBuffer],
          );
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : "Unknown error";
          stop(
            new Error(
              `Could not send formatter input: ${detail}`.slice(0, 512),
            ),
          );
        }
      });
    },
    close() {
      closed = true;
      stop(new Error("Readable formatter is closed."));
    },
  };
}
