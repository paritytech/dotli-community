// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type ErrorChainNode = {
  name: string;
  message: string;
  stack?: string | undefined;
  /** Aggregated branches, then the cause. */
  causes: ErrorChainNode[];
  /** Set when the source value was not an `Error` instance. */
  raw?: unknown;
};

const UNKNOWN_PREFIX = '[serializeError:';

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
        message: value.message || '',
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
      message: describeNonError(value),
      causes: [],
      raw: value,
    };
  } finally {
    if (isObject) {
      onStack.delete(value);
    }
  }
}

function describeNonError(value: unknown): string {
  if (value === null) {
    return `${UNKNOWN_PREFIX} null]`;
  }
  if (value === undefined) {
    return `${UNKNOWN_PREFIX} undefined]`;
  }
  if (typeof value === 'string') {
    return value.length > 0 ? value : `${UNKNOWN_PREFIX} empty-string]`;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'symbol') {
    return `${UNKNOWN_PREFIX} BUG-thrown-symbol ${value.toString()}]`;
  }
  if (typeof value === 'function') {
    return `${UNKNOWN_PREFIX} BUG-thrown-function name=${value.name || '<anon>'}]`;
  }
  if (typeof value === 'object') {
    if ('message' in value && typeof value.message === 'string' && value.message.length > 0) {
      return value.message;
    }
    try {
      const json = JSON.stringify(value);
      if (json && json !== '{}' && json !== 'null') {
        return json;
      }
      const keys = Object.keys(value).slice(0, 5).join(',');
      return `[object Object keys=${keys || '<none>'}]`;
    } catch {
      const keys = Object.keys(value).slice(0, 5).join(',');
      return `${UNKNOWN_PREFIX} JSON.stringify failed keys=${keys || '<none>'}]`;
    }
  }
  return `${UNKNOWN_PREFIX} unknown-shape]`;
}
