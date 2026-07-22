// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { serializeError } from "@dotli/shared/errors";

export class ProtocolFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolFatalError";
  }
}

export class ProtocolInitFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolInitFailedError";
  }
}

export type ChainConnectionErrorCode =
  | "UNSUPPORTED_CHAIN"
  | "PROTOCOL_UNAVAILABLE"
  | "UPSTREAM_CONNECTION_FAILED"
  | "CHAIN_HALTED";

const CHAIN_CONNECTION_ERROR_CODES = new Set<ChainConnectionErrorCode>([
  "UNSUPPORTED_CHAIN",
  "PROTOCOL_UNAVAILABLE",
  "UPSTREAM_CONNECTION_FAILED",
  "CHAIN_HALTED",
]);

export class ChainConnectionError extends Error {
  readonly code: ChainConnectionErrorCode;

  constructor(code: ChainConnectionErrorCode, message: string) {
    super(message);
    this.name = "ChainConnectionError";
    this.code = code;
  }
}

export function isChainConnectionErrorCode(
  value: unknown,
): value is ChainConnectionErrorCode {
  return (
    typeof value === "string" &&
    CHAIN_CONNECTION_ERROR_CODES.has(value as ChainConnectionErrorCode)
  );
}

export function asChainConnectionError(
  error: unknown,
  fallbackCode: ChainConnectionErrorCode,
): ChainConnectionError {
  if (error instanceof ChainConnectionError) {
    return error;
  }
  return new ChainConnectionError(fallbackCode, serializeError(error));
}

export function toProtocolErrorPayload(error: unknown): {
  error: string;
  code?: ChainConnectionErrorCode;
} {
  if (error instanceof ChainConnectionError) {
    return { error: error.message, code: error.code };
  }
  return { error: serializeError(error) };
}
