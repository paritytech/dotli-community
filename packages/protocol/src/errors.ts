// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

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

/** Which wait consumed a protocol request's call-time budget. */
export type ProtocolRequestTimeoutPhase = "load" | "ready" | "reply";

const PHASE_DESCRIPTIONS: Record<ProtocolRequestTimeoutPhase, string> = {
  load: "while waiting for the host frame to load",
  ready: "while waiting for the protocol frame to become ready",
  reply: "while waiting for a reply",
};

/**
 * A protocol request that ran out its per-method budget.
 *
 * The budget is measured from the moment the request was made, so it covers
 * the frame wait as well as the reply wait. `phase` records which of those
 * waits was in progress when the budget expired.
 */
export class ProtocolRequestTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  readonly phase: ProtocolRequestTimeoutPhase;

  constructor(
    method: string,
    timeoutMs: number,
    phase: ProtocolRequestTimeoutPhase,
  ) {
    super(
      `Protocol request "${method}" timed out after ${String(timeoutMs)}ms ${PHASE_DESCRIPTIONS[phase]}`,
    );
    this.name = "ProtocolRequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.phase = phase;
  }
}
