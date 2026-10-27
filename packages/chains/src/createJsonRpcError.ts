// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports nothing, so a caller on an eager path can take this module without the rest of the package.

/** A JSON-RPC error answer to `id`. A string becomes an internal error, and an error object goes as it is. */
export function createJsonRpcError(
  id: string | number | null,
  error: string | { code: number; message: string; data?: string },
): { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: string } } {
  return { jsonrpc: '2.0', id, error: typeof error === 'string' ? { code: -32603, message: error } : error };
}
