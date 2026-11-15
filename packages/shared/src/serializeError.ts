// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const AGGREGATE_CAP = 3;

/** Serialize any thrown value into a one-line string. Never returns an empty string. */
export function serializeError(value: unknown): string {
  return serialize(value, new WeakSet());
}

function serialize(value: unknown, onStack: WeakSet<object>): string {
  switch (typeof value) {
    case 'string':
      return value.length > 0 ? value : 'Unknown error';
    case 'undefined':
      return 'undefined';
    case 'number':
    case 'bigint':
    case 'boolean':
    case 'symbol':
      return value.toString();
    case 'function':
      return `[function ${value.name || 'anonymous'}]`;
    case 'object':
      return value === null ? 'null' : serializeObject(value, onStack);
  }
}

function serializeObject(value: object, onStack: WeakSet<object>): string {
  if (onStack.has(value)) {
    return '[cycle]';
  }
  onStack.add(value);

  try {
    if (value instanceof Error) {
      return serializeErrorChain(value, onStack);
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
    return '[object Object]';
  } finally {
    onStack.delete(value);
  }
}

/** The error's headline, then its aggregated branches or else its cause. */
function serializeErrorChain(error: Error, onStack: WeakSet<object>): string {
  const headline = error.message.length > 0 ? error.message : error.name || 'Error';
  const errors = 'errors' in error ? error.errors : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    const shown = errors
      .slice(0, AGGREGATE_CAP)
      .map(branch => serialize(branch, onStack))
      .join('; ');
    const suffix = errors.length > AGGREGATE_CAP ? ', ...' : '';
    return `${headline} [${shown}${suffix}]`;
  }
  if (error.cause !== undefined) {
    return `${headline} (cause: ${serialize(error.cause, onStack)})`;
  }
  return headline;
}
