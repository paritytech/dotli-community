// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProtocolEnvelope } from '@dotli/protocol';
import { errorName, serializeError } from '@dotli/shared';

// Enough for the frames that locate the throw without bloating every failed response.
const MAX_STACK_CHARS = 2000;

/** A failed response carrying the class name and stack, which the host's rebuilt error cannot have otherwise. */
export function errorResponse(id: string, error: unknown): ProtocolEnvelope {
  const name = errorName(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    namespace: 'dotli:protocol',
    kind: 'response',
    id,
    ok: false,
    error: serializeError(error),
    ...(name !== undefined ? { errorName: name } : {}),
    ...(typeof stack === 'string' && stack !== '' ? { errorStack: stack.slice(0, MAX_STACK_CHARS) } : {}),
  };
}
