// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatReadable, readableError } from "./polkavm-readable-format";
import type {
  ReadableFormatRequest,
  ReadableFormatResult,
} from "./polkavm-readable";

// Keep the worker entrypoint compatible with the sandbox's DOM TypeScript lib.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ReadableFormatRequest>) => void) | null;
  postMessage(message: ReadableFormatResult, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data }): Promise<void> => {
  try {
    const bytes = await formatReadable(data.path, data.bytes);
    scope.postMessage({ id: data.id, ok: true, bytes }, [bytes.buffer]);
  } catch (error) {
    scope.postMessage({ id: data.id, ok: false, error: readableError(error) });
  }
};
