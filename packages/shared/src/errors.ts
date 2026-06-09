// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li error serialization helper.
//
// Turn an unknown thrown/rejected value into a non-empty string suitable
// for transmission over wire formats (protocol envelopes, JSON-RPC errors)
// and display in logs and Sentry.
//
// Contract:
// - Walk the entire `.cause` chain with an active-path `WeakSet` cycle
//   guard so deeply nested rewrap (fetch into helia into resolve) is
//   preserved end-to-end. The guard is pushed on descent and popped on
//   return, so a repeated reference across separate branches (e.g. an
//   AggregateError whose `errors[]` share a common cause) is walked
//   normally. Only a true back-edge into the current recursion stack
//   yields the `Cycle` marker. A single session-wide set would collapse
//   shared nodes and real cycles into the same synthetic node, losing
//   real context.
// - Do not truncate AggregateError branches. Racing across providers is
//   forbidden in this codebase, so `errors[]` should be rare. When one
//   fires we want every branch.
// - Read `Error.stack` when explicitly requested via `serializeErrorDetail`.
// - Never collapse to a generic `"Unknown error"` without tagging which
//   branch produced it (so operators can spot the exact code path).
//
// Three public surfaces:
//   `serializeError(value)`        terse one-line string for log/UI
//   `serializeErrorDetail(value)`  multi-line string with stack frames
//   `fullErrorChain(value)`        structured object for Sentry and tests

const UNKNOWN_PREFIX = "[serializeError:";

export interface ErrorChainNode {
  name: string;
  message: string;
  stack?: string | undefined;
  /** Underlying cause / aggregated branches, in order. */
  causes: ErrorChainNode[];
  /** Set when the source value was not an `Error` instance. */
  raw?: unknown;
}

/**
 * Walk an unknown thrown/rejected value into a structured chain. Cycle-safe.
 *
 * Use this when forwarding errors to Sentry or structured logs. The string
 * helpers below derive their output from this representation.
 */
export function fullErrorChain(value: unknown): ErrorChainNode {
  return walk(value, new WeakSet());
}

function walk(value: unknown, onStack: WeakSet<object>): ErrorChainNode {
  // Push on descent and pop on return so the guard tracks only the active
  // DFS path, not every object ever visited. A repeated reference in a
  // separate branch is walked normally. A true back-edge (A references B
  // references A) returns the `Cycle` node.
  const isObject = value !== null && typeof value === "object";
  if (isObject) {
    if (onStack.has(value)) {
      return {
        name: "Cycle",
        message: "[cycle in cause chain]",
        causes: [],
      };
    }
    onStack.add(value);
  }

  try {
    if (value instanceof Error) {
      const node: ErrorChainNode = {
        name: value.name || "Error",
        message: value.message || "",
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

    // Non-Error throws. Preserve the raw value for downstream consumers
    // (Sentry `extra`, structured logs).
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
  if (typeof value === "string") {
    return value.length > 0 ? value : `${UNKNOWN_PREFIX} empty-string]`;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "symbol") {
    return `${UNKNOWN_PREFIX} BUG-thrown-symbol ${value.toString()}]`;
  }
  if (typeof value === "function") {
    return `${UNKNOWN_PREFIX} BUG-thrown-function name=${value.name || "<anon>"}]`;
  }
  if (typeof value === "object") {
    const obj = value as { message?: unknown };
    if (typeof obj.message === "string" && obj.message.length > 0) {
      return obj.message;
    }
    try {
      const json = JSON.stringify(value);
      if (json && json !== "{}" && json !== "null") {
        return json;
      }
      const keys = Object.keys(value).slice(0, 5).join(",");
      return `[object Object keys=${keys || "<none>"}]`;
    } catch {
      const keys = Object.keys(value).slice(0, 5).join(",");
      return `${UNKNOWN_PREFIX} JSON.stringify failed keys=${keys || "<none>"}]`;
    }
  }
  return `${UNKNOWN_PREFIX} unknown-shape]`;
}

/**
 * Serialize an unknown value into a non-empty, human-readable one-line
 * string suitable for log lines, UI error surfaces, and wire-format error
 * fields.
 *
 * Format:
 *   - primitive becomes its canonical string (`"null"`, `"42"`, `"false"`, ...)
 *   - `""` becomes `"Unknown error"` (empty strings would violate the
 *     non-empty invariant below)
 *   - `Error` uses `message` when present, otherwise `name`
 *     - with `cause`: `<headline> (cause: <serialize(cause)>)`
 *     - with `errors` (Agg...): `<headline> [<e1>; <e2>; <e3>, ...]`,
 *       capped at 3 with `, ...` when truncated
 *   - plain object with a non-empty `.message` string uses the message
 *   - plain object otherwise uses `JSON.stringify(value)`, falling back to
 *     `"[object Object]"` for `{}`, cyclic structures, or anything JSON
 *     refuses to encode
 *
 * The cycle guard is path-local (push on descent, pop on return) so a
 * cycle in the `.cause` chain becomes `[cycle]` in-place rather than
 * infinite recursion. Sharing a reference across separate branches is NOT
 * a cycle and walks normally.
 *
 * Invariant: this function NEVER returns an empty string.
 */
export function serializeError(value: unknown): string {
  return serialize(value, new WeakSet());
}

const CYCLE_MARKER = "[cycle]";
const UNKNOWN_OBJECT = "[object Object]";
const AGG_CAP = 3;

function serialize(value: unknown, onStack: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value.length > 0 ? value : "Unknown error";
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }
  if (typeof value !== "object") {
    return UNKNOWN_OBJECT;
  }

  if (onStack.has(value)) {
    return CYCLE_MARKER;
  }
  onStack.add(value);

  try {
    if (value instanceof Error) {
      const headline =
        value.message.length > 0 ? value.message : value.name || "Error";
      const errors = (value as Error & { errors?: unknown }).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const shown = errors
          .slice(0, AGG_CAP)
          .map((e) => serialize(e, onStack))
          .join("; ");
        const suffix = errors.length > AGG_CAP ? ", ..." : "";
        return `${headline} [${shown}${suffix}]`;
      }
      const cause = (value as Error & { cause?: unknown }).cause;
      if (cause !== undefined) {
        return `${headline} (cause: ${serialize(cause, onStack)})`;
      }
      return headline;
    }

    // Plain object: prefer a non-empty `.message` string, then JSON,
    // then the `[object Object]` fallback. Anything JSON refuses to
    // encode (cycles, typed arrays with circular hosts) also lands here.
    const obj = value as { message?: unknown };
    if (typeof obj.message === "string" && obj.message.length > 0) {
      return obj.message;
    }
    try {
      const json = JSON.stringify(value);
      if (
        typeof json === "string" &&
        json.length > 0 &&
        json !== "{}" &&
        json !== "null"
      ) {
        return json;
      }
      // eslint-disable-next-line no-restricted-syntax -- JSON.stringify throws on cycles; that's exactly what we want to fold into the `[object Object]` fallback. No metric, the caller already saw a serialization fallback.
    } catch {
      /* cycle or unserializable, fall through to the fallback marker */
    }
    return UNKNOWN_OBJECT;
  } finally {
    onStack.delete(value);
  }
}

/**
 * Like `serializeError` but appends each Error frame's stack when
 * present, across the full `.cause` and `errors[]` chain. Use for dev
 * tooling and console logs. Sentry should receive `fullErrorChain`
 * instead so the structured chain is preserved.
 */
export function serializeErrorDetail(value: unknown): string {
  const root = fullErrorChain(value);
  return renderChainDetail(root);
}

function renderChainDetail(node: ErrorChainNode): string {
  const headline =
    node.message.length > 0
      ? node.name === "Error"
        ? node.message
        : `${node.name}: ${node.message}`
      : node.name;
  let out = headline;
  if (node.stack !== undefined && node.stack !== "") {
    out += `\n${node.stack}`;
  }
  for (const cause of node.causes) {
    out += `\n  caused by: ${renderChainDetail(cause).replace(/\n/g, "\n  ")}`;
  }
  return out;
}
