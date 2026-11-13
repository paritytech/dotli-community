// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { serializeError } from './serializeError.js';

export type ErrorChainNode = {
  name: string;
  message: string;
  stack?: string | undefined;
  /** Aggregated branches, then the cause. */
  causes: ErrorChainNode[];
  /** Set when the source value was not an `Error` instance. */
  raw?: unknown;
};

/** Walk a thrown value into a structured chain for Sentry, keeping every aggregated branch. */
export function getErrorChain(value: unknown): ErrorChainNode {
  return walk(value, new WeakSet());
}

function walk(value: unknown, onStack: WeakSet<object>): ErrorChainNode {
  // The guard tracks only the active path, so a reference shared by two branches is walked in both
  // and only a true back-edge becomes `Cycle`.
  const isObject = value !== null && typeof value === 'object';
  if (isObject) {
    if (onStack.has(value)) {
      return {
        name: 'Cycle',
        message: '[cycle in cause chain]',
        causes: [],
      };
    }
    onStack.add(value);
  }

  try {
    if (value instanceof Error) {
      const node: ErrorChainNode = {
        name: value.name || 'Error',
        message: value.message,
        stack: value.stack,
        causes: [],
      };
      const errors = 'errors' in value ? value.errors : undefined;
      if (Array.isArray(errors)) {
        for (const branch of errors) {
          node.causes.push(walk(branch, onStack));
        }
      }
      if (value.cause !== undefined) {
        node.causes.push(walk(value.cause, onStack));
      }
      return node;
    }

    return {
      name: typeof value,
      message: serializeError(value),
      causes: [],
      raw: value,
    };
  } finally {
    if (isObject) {
      onStack.delete(value);
    }
  }
}
