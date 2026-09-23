// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_START,
  MESSAGE_TYPE_STOP,
  MESSAGE_TYPE_INTERRUPT,
  PROTOCOL_ERROR_TRAIT_ID,
  PROTOCOL_ERROR_METHOD_ID,
  type ProtocolMessage,
} from "@parity/truapi";
import { CallError, Result, _void, compact } from "@parity/truapi/scale";
import { CHAIN_FOLLOW_HEAD_SUBSCRIBE } from "@parity/truapi/wire-table";

const MAX_TRACKED_FOLLOWS = 64;
const MAX_TRACKED_ID_CODE_UNITS = 64 * 1024;

const interrupted = Result(_void, CallError(_void)).enc({
  success: false,
  value: {
    tag: "HostFailure",
    value: { reason: "Chain follow interrupted while the app was paused" },
  },
});

function isFollow(message: ProtocolMessage): boolean {
  return (
    message.payload.traitId === CHAIN_FOLLOW_HEAD_SUBSCRIBE.trait &&
    message.payload.methodId === CHAIN_FOLLOW_HEAD_SUBSCRIBE.method
  );
}

// Decode only relevant envelopes, never their potentially 1 MiB payloads.
// Use the SDK's SCALE compact codec and envelope decoder rather than a second
// wire codec; like that decoder, reject big-integer string-length prefixes.
function trackedFrame(bytes: Uint8Array): ProtocolMessage | undefined {
  if (bytes.length === 0) {
    return undefined;
  }
  const mode = bytes[0] & 3;
  const prefixLength = 1 << mode;
  if (mode === 3 || bytes.length < prefixLength) {
    return undefined;
  }
  const end = prefixLength + Number(compact.dec(bytes));
  if (end + 3 > bytes.length) {
    return undefined;
  }
  if (
    !(
      bytes[end] === CHAIN_FOLLOW_HEAD_SUBSCRIBE.trait &&
      bytes[end + 1] === CHAIN_FOLLOW_HEAD_SUBSCRIBE.method
    ) &&
    !(
      bytes[end] === PROTOCOL_ERROR_TRAIT_ID &&
      bytes[end + 1] === PROTOCOL_ERROR_METHOD_ID
    )
  ) {
    return undefined;
  }
  const decoded = decodeWireMessage(bytes.subarray(0, end + 3));
  return decoded.isOk() ? decoded.value : undefined;
}

function followFrame(requestId: string, messageType: number): Uint8Array {
  return encodeWireMessage({
    requestId,
    payload: {
      traitId: CHAIN_FOLLOW_HEAD_SUBSCRIBE.trait,
      methodId: CHAIN_FOLLOW_HEAD_SUBSCRIBE.method,
      messageType,
      value:
        messageType === MESSAGE_TYPE_INTERRUPT ? interrupted : new Uint8Array(),
    },
  })._unsafeUnwrap();
}

// A paused guest cannot poll. Stop upstream follows rather than buffering an
// unbounded stream or silently losing chain state. Terminal notifications are
// pulled one at a time by the response queue after resume, behind prior replies.
export class PolkaVmChainFollowPause {
  private readonly follows = new Map<string, "active" | "interrupted">();
  private idCodeUnits = 0;
  private paused = false;
  private closed = false;
  private readonly sendHost: (bytes: Uint8Array) => void;
  private readonly fail: (error: Error) => void;

  constructor(
    sendHost: (bytes: Uint8Array) => void,
    fail: (error: Error) => void,
  ) {
    this.sendHost = sendHost;
    this.fail = fail;
  }

  request(bytes: Uint8Array): void {
    if (this.closed) {
      return;
    }
    const message = trackedFrame(bytes);
    if (message !== undefined && isFollow(message)) {
      const { requestId, payload } = message;
      if (payload.messageType === MESSAGE_TYPE_START) {
        if (!this.follows.has(requestId)) {
          if (
            this.follows.size >= MAX_TRACKED_FOLLOWS ||
            this.idCodeUnits + requestId.length > MAX_TRACKED_ID_CODE_UNITS
          ) {
            this.close();
            this.fail(new Error("Chain follow tracking limit exceeded"));
            return;
          }
          this.idCodeUnits += requestId.length;
        }
        this.follows.set(requestId, this.paused ? "interrupted" : "active");
        if (this.paused) {
          // An update already in flight may emit a start after the pause.
          return;
        }
      } else if (payload.messageType === MESSAGE_TYPE_STOP) {
        const wasActive = this.follows.get(requestId) === "active";
        this.forget(requestId);
        if (!wasActive) {
          return;
        }
      }
    }
    this.sendHost(bytes);
  }

  receive(bytes: Uint8Array): boolean {
    if (this.closed) {
      return false;
    }
    const message = trackedFrame(bytes);
    if (message === undefined) {
      // Leave unrelated and malformed-frame handling to the peer.
      return true;
    }
    const { requestId, payload } = message;
    if (isFollow(message)) {
      // Includes events already in flight at pause and late terminal frames.
      if (this.follows.get(requestId) !== "active") {
        return false;
      }
      if (payload.messageType === MESSAGE_TYPE_INTERRUPT) {
        this.forget(requestId);
      }
    } else {
      // Method-independent protocol errors also terminate follows.
      if (this.follows.get(requestId) === "interrupted") {
        return false;
      }
      this.forget(requestId);
    }
    return true;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused || this.closed) {
      return;
    }
    for (const [requestId, state] of this.follows) {
      if (state === "active") {
        this.follows.set(requestId, "interrupted");
        this.sendHost(followFrame(requestId, MESSAGE_TYPE_STOP));
      }
    }
  }

  nextInterrupted(): Uint8Array | undefined {
    if (this.paused || this.closed) {
      return undefined;
    }
    for (const [requestId, state] of this.follows) {
      if (state === "interrupted") {
        this.forget(requestId);
        return followFrame(requestId, MESSAGE_TYPE_INTERRUPT);
      }
    }
    return undefined;
  }

  close(): void {
    this.closed = true;
    for (const [requestId, state] of this.follows) {
      if (state === "active") {
        this.sendHost(followFrame(requestId, MESSAGE_TYPE_STOP));
      }
    }
    this.follows.clear();
    this.idCodeUnits = 0;
  }

  private forget(requestId: string): void {
    if (this.follows.delete(requestId)) {
      this.idCodeUnits -= requestId.length;
    }
  }
}
