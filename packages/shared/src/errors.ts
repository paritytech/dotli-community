// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Turns any thrown value into a non-empty string or chain for wire formats, logs and Sentry.

const UNKNOWN_PREFIX = '[serializeError:';

export interface ErrorChainNode {
  name: string;
  message: string;
  stack?: string | undefined;
  /** Aggregated branches, then the cause. */
  causes: ErrorChainNode[];
  /** Set when the source value was not an `Error` instance. */
  raw?: unknown;
}

/** Walk a thrown value into a structured chain for Sentry, keeping every aggregated branch. */
export function fullErrorChain(value: unknown): ErrorChainNode {
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
      const errors = (value as Error & { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const branch of errors) {
          node.causes.push(walk(branch, onStack));
        }
      }
      const cause = (value as Error & { cause?: unknown }).cause;
      if (cause !== undefined) {
        node.causes.push(walk(cause, onStack));
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
    const obj = value as { message?: unknown };
    if (typeof obj.message === 'string' && obj.message.length > 0) {
      return obj.message;
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

/** Serialize any thrown value into a one-line string. Never returns an empty string. */
export function serializeError(value: unknown): string {
  return serialize(value, new WeakSet());
}

/** Pair with `serializeError` on a wire format, so the receiver branches on the class, not the message. */
export function errorName(value: unknown): string | undefined {
  return value instanceof Error ? value.name : undefined;
}

const CYCLE_MARKER = '[cycle]';
const UNKNOWN_OBJECT = '[object Object]';
const AGG_CAP = 3;

function serialize(value: unknown, onStack: WeakSet<object>): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return value.length > 0 ? value : 'Unknown error';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return `[function ${value.name || 'anonymous'}]`;
  }
  if (typeof value !== 'object') {
    return UNKNOWN_OBJECT;
  }

  if (onStack.has(value)) {
    return CYCLE_MARKER;
  }
  onStack.add(value);

  try {
    if (value instanceof Error) {
      const headline = value.message.length > 0 ? value.message : value.name || 'Error';
      const errors = (value as Error & { errors?: unknown }).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const shown = errors
          .slice(0, AGG_CAP)
          .map(e => serialize(e, onStack))
          .join('; ');
        const suffix = errors.length > AGG_CAP ? ', ...' : '';
        return `${headline} [${shown}${suffix}]`;
      }
      const cause = (value as Error & { cause?: unknown }).cause;
      if (cause !== undefined) {
        return `${headline} (cause: ${serialize(cause, onStack)})`;
      }
      return headline;
    }

    const obj = value as { message?: unknown };
    if (typeof obj.message === 'string' && obj.message.length > 0) {
      return obj.message;
    }
    try {
      const json = JSON.stringify(value);
      if (typeof json === 'string' && json.length > 0 && json !== '{}' && json !== 'null') {
        return json;
      }
      // eslint-disable-next-line no-restricted-syntax -- JSON.stringify throws on cycles, which folds into the `[object Object]` fallback.
    } catch {
      /* fall through to the fallback marker */
    }
    return UNKNOWN_OBJECT;
  } finally {
    onStack.delete(value);
  }
}
