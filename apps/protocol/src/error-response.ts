// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProtocolEnvelope } from '@dotli/protocol';
import { errorName, serializeError } from '@dotli/shared';

// Enough for the frames that locate the throw. A full light-client stack would
// only bloat every failed response.
const MAX_STACK_CHARS = 2000;

/**
 * The response telling the host a request failed.
 *
 * The host rebuilds the error from this and reports it, so everything it needs
 * to say where the failure happened has to travel here: the class name to
 * branch on, and the stack, which the rebuilt error cannot have.
 */
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
