// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const CYCLE_MARKER = '[cycle]';
const UNKNOWN_OBJECT = '[object Object]';
const AGGREGATE_CAP = 3;

/** Serialize any thrown value into a one-line string. Never returns an empty string. */
export function serializeError(value: unknown): string {
  return serialize(value, new WeakSet());
}

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
      const errors = 'errors' in value ? value.errors : undefined;
      if (Array.isArray(errors) && errors.length > 0) {
        const shown = errors
          .slice(0, AGGREGATE_CAP)
          .map(branch => serialize(branch, onStack))
          .join('; ');
        const suffix = errors.length > AGGREGATE_CAP ? ', ...' : '';
        return `${headline} [${shown}${suffix}]`;
      }
      if (value.cause !== undefined) {
        return `${headline} (cause: ${serialize(value.cause, onStack)})`;
      }
      return headline;
    }

    if ('message' in value && typeof value.message === 'string' && value.message.length > 0) {
      return value.message;
    }
    try {
      const json = JSON.stringify(value);
      if (typeof json === 'string' && json !== '{}' && json !== 'null') {
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
