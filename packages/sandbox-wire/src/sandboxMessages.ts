// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Every postMessage between the host and the sandbox. The two are separate origins that can run different releases
// for a while after a deploy, so these shapes are the wire format: a change may add an optional field or a new type,
// never rename or retype one. Any frame or extension can post to a window, so each side parses what it receives.

/** Progress text for the host's loading screen, or the end of the sandbox's use of it. */
export type LoadingStatusMessage = {
  type: 'dotli:loading-status';
  message?: string;
  /** Without an `outcome` it only clears the screen for a prompt the sandbox shows before its content loads. */
  done?: true;
  outcome?: 'loaded' | 'failed';
  failedStep?: string;
};

/** The debug panel's own event union lives in `@dotli/truapi-debug`, which this package does not import. */
export type SandboxDebugEvent = {
  layer: 'sandbox';
  event: string;
  flowId: string;
  timestamp: number;
  payload: Record<string, unknown>;
};

export type SandboxDebugEventMessage = {
  type: 'dotli:debug-event';
  event: SandboxDebugEvent;
};

/** A reloaded sandbox lost its contract params, so it asks the host to render it again. */
export type SandboxRecoverMessage = {
  type: 'dotli:sandbox-recover';
};

export type BitswapGetMessage = {
  type: 'dotli:bitswap-get';
  id: string;
  cid: string;
  /** The sandbox document's own id, which its abort repeats. Missing from a sandbox released before it. */
  frame?: string;
};

/** The sandbox frame is going away, so the host stops these fetches. */
export type BitswapAbortMessage = {
  type: 'dotli:bitswap-abort';
  ids: string[];
  /** As on the gets. The host reads an abort sent on `pagehide` once its frame is gone, so it has no source. */
  frame?: string;
};

export type BitswapResultMessage =
  | {
      type: 'dotli:bitswap-result';
      id: string;
      ok: true;
      bytes: Uint8Array;
    }
  | {
      type: 'dotli:bitswap-result';
      id: string;
      ok: false;
      /** Missing only from a malformed reply. */
      error?: string;
      /** So the sandbox rebuilds the same exception type. */
      errorName?: string;
      code?: number;
    };

export type SandboxToHostMessage =
  LoadingStatusMessage | SandboxDebugEventMessage | SandboxRecoverMessage | BitswapGetMessage | BitswapAbortMessage;

export type HostToSandboxMessage = BitswapResultMessage;

/**
 * A checker build's report that the product reached a browser API it should reach through the host. The product's page
 * posts it from the sandbox origin, never through `postToHost`, so the host reads it with its own parser.
 */
export type ApiViolationMessage = {
  type: 'DOTLI_API_VIOLATION';
  api: string;
  details?: Record<string, unknown>;
  timestamp?: number;
};

function asRecord(data: unknown): Record<string, unknown> | null {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseLoadingStatus(data: Record<string, unknown>): LoadingStatusMessage {
  const { message, done, outcome, failedStep } = data;
  return {
    type: 'dotli:loading-status',
    ...(typeof message === 'string' ? { message } : {}),
    ...(done === true ? { done } : {}),
    ...(outcome === 'loaded' || outcome === 'failed' ? { outcome } : {}),
    ...(typeof failedStep === 'string' ? { failedStep } : {}),
  };
}

function parseDebugEvent(data: Record<string, unknown>): SandboxDebugEventMessage | null {
  const event = asRecord(data['event']);
  if (
    event?.['layer'] !== 'sandbox' ||
    typeof event['event'] !== 'string' ||
    typeof event['flowId'] !== 'string' ||
    typeof event['timestamp'] !== 'number' ||
    asRecord(event['payload']) === null
  ) {
    return null;
  }
  return { type: 'dotli:debug-event', event: event as unknown as SandboxDebugEvent };
}

/** What the host accepts from a sandbox frame, or null for anything else. The origin check is the caller's. */
export function parseSandboxToHostMessage(data: unknown): SandboxToHostMessage | null {
  const record = asRecord(data);
  switch (record?.['type']) {
    case 'dotli:loading-status':
      return parseLoadingStatus(record);
    case 'dotli:debug-event':
      return parseDebugEvent(record);
    case 'dotli:sandbox-recover':
      return { type: 'dotli:sandbox-recover' };
    case 'dotli:bitswap-get': {
      const { id, cid, frame } = record;
      return isNonEmptyString(id) && isNonEmptyString(cid)
        ? { type: 'dotli:bitswap-get', id, cid, ...(isNonEmptyString(frame) ? { frame } : {}) }
        : null;
    }
    case 'dotli:bitswap-abort': {
      const { ids, frame } = record;
      return Array.isArray(ids) && ids.every(id => typeof id === 'string')
        ? { type: 'dotli:bitswap-abort', ids, ...(isNonEmptyString(frame) ? { frame } : {}) }
        : null;
    }
    default:
      return null;
  }
}

/** A checker build's violation report, or null for anything else. The source check is the caller's. */
export function parseApiViolationMessage(data: unknown): ApiViolationMessage | null {
  const record = asRecord(data);
  if (record?.['type'] !== 'DOTLI_API_VIOLATION') {
    return null;
  }
  const details = asRecord(record['details']);
  const timestamp = record['timestamp'];
  return {
    type: 'DOTLI_API_VIOLATION',
    api: String(record['api']),
    ...(details !== null ? { details } : {}),
    ...(typeof timestamp === 'number' ? { timestamp } : {}),
  };
}

/** What the sandbox accepts from its host, or null. A success without bytes is malformed, so it reads as a failure. */
export function parseHostToSandboxMessage(data: unknown): HostToSandboxMessage | null {
  const record = asRecord(data);
  if (record?.['type'] !== 'dotli:bitswap-result') {
    return null;
  }
  const { id, ok, bytes, error, errorName, code } = record;
  if (typeof id !== 'string' || typeof ok !== 'boolean') {
    return null;
  }
  if (ok && bytes instanceof Uint8Array) {
    return { type: 'dotli:bitswap-result', id, ok, bytes };
  }
  return {
    type: 'dotli:bitswap-result',
    id,
    ok: false,
    ...(typeof error === 'string' ? { error } : {}),
    ...(typeof errorName === 'string' ? { errorName } : {}),
    ...(typeof code === 'number' ? { code } : {}),
  };
}

/** To any origin, since the sandbox cannot tell which host origin framed it and nothing it sends is secret. */
export function postToHost(host: Pick<Window, 'postMessage'>, message: SandboxToHostMessage): void {
  host.postMessage(message, '*');
}
