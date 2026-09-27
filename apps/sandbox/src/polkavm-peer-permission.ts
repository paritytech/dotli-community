// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// JAM peer access is a runtime permission, never a manifest capability. When
// the guest dials a JAM network, the sandbox asks the host over the same
// authenticated TrUAPI port the guest uses, with a request id of its own, and
// consumes the reply itself. The host core checks the product's stored
// decision, prompts when it is undetermined and persists the answer per
// product and genesis.

import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  VersionedRemotePermissionError,
  VersionedRemotePermissionRequest,
  VersionedRemotePermissionResponse,
} from "@parity/truapi";
import * as S from "@parity/truapi/scale";
import { PERMISSIONS_REQUEST_REMOTE_PERMISSION } from "@parity/truapi/wire-table";

const remotePermissionResult = S.Result(
  VersionedRemotePermissionResponse,
  S.CallError(VersionedRemotePermissionError),
);
const REQUEST_ID_PREFIX = "dotli-jam-peers:";
/** Prefix plus 16 random bytes in hex: unguessable by the guest sharing the port. */
const REQUEST_ID_BYTES = REQUEST_ID_PREFIX.length + 32;
const textDecoder = new TextDecoder();

export interface HostPermissionPort {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/**
 * Byte range of the SCALE `str` request id heading a wire frame, or `null`
 * when the frame is truncated. Reads the header only, so routing a large
 * frame never copies its payload.
 */
function requestIdRange(frame: Uint8Array): [number, number] | null {
  if (frame.length < 4) {
    return null;
  }
  const first = frame[0];
  let length: number;
  let start: number;
  switch (first & 3) {
    case 0:
      length = first >>> 2;
      start = 1;
      break;
    case 1:
      length = (first | (frame[1] << 8)) >>> 2;
      start = 2;
      break;
    case 2:
      length =
        (first | (frame[1] << 8) | (frame[2] << 16) | (frame[3] << 24)) >>> 2;
      start = 4;
      break;
    default:
      return null;
  }
  const end = start + length;
  return frame.length < end + 3 ? null : [start, end];
}

/** Trait id of a wire frame without copying its payload; `undefined` when truncated. */
export function wireFrameTraitId(frame: Uint8Array): number | undefined {
  const range = requestIdRange(frame);
  return range === null ? undefined : frame[range[1]];
}

/** Menu lines for the JAM networks this execution may reach; empty when none. */
export function jamPeersGrantText(granted: readonly string[]): string[] {
  if (granted.length === 0) {
    return [];
  }
  return [
    ...granted.map(
      (genesis) =>
        `JAM network ${genesis}: read-only peer access (WebTransport) to its validators, granted for this app and closed when it stops.`,
    ),
    "Limits: 8 connections, 16 streams per connection, 1 MiB messages. Received bytes are unverified until the app checks them.",
    "This access carries no account, signing, storage or web access.",
  ];
}

/**
 * Asks the host for `RemotePermission::JamPeers { genesis }` on behalf of the
 * execution-local JamPeerTransport session. Replies to its own requests never
 * reach the guest.
 */
export class JamPeersPermissionRequester {
  private readonly port: HostPermissionPort;
  private readonly pending = new Map<string, (granted: boolean) => void>();
  private readonly grantedGenesis = new Set<string>();
  private closed = false;

  constructor(port: HostPermissionPort) {
    this.port = port;
  }

  /** JamPeerTransport `authorize` callback: resolves whether the host granted `genesis`. */
  readonly authorize = (genesis: string): Promise<boolean> => {
    if (this.closed) {
      return Promise.resolve(false);
    }
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const requestId =
      REQUEST_ID_PREFIX +
      Array.from(nonce, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const encoded = encodeWireMessage({
      requestId,
      payload: {
        traitId: PERMISSIONS_REQUEST_REMOTE_PERMISSION.trait,
        methodId: PERMISSIONS_REQUEST_REMOTE_PERMISSION.method,
        messageType: MESSAGE_TYPE_REQUEST,
        value: VersionedRemotePermissionRequest.enc({
          tag: "V1",
          value: {
            permission: {
              tag: "JamPeers",
              value: { genesis: genesis as S.HexString },
            },
          },
        }),
      },
    });
    if (encoded.isErr()) {
      return Promise.reject(encoded.error);
    }
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.pending.set(requestId, (granted) => {
      if (granted) {
        this.grantedGenesis.add(genesis);
      }
      resolve(granted);
    });
    this.port.postMessage(encoded.value, []);
    return promise;
  };

  /**
   * Consume `frame` when it answers one of this requester's requests. Every
   * other frame belongs to the guest and is left untouched. Throws, after
   * refusing the request, when the host's reply to it does not decode.
   */
  claim(frame: Uint8Array): boolean {
    if (this.pending.size === 0) {
      return false;
    }
    const range = requestIdRange(frame);
    if (range === null || range[1] - range[0] !== REQUEST_ID_BYTES) {
      return false;
    }
    const requestId = textDecoder.decode(frame.subarray(range[0], range[1]));
    const settle = this.pending.get(requestId);
    if (settle === undefined) {
      return false;
    }
    this.pending.delete(requestId);
    let granted = false;
    try {
      const decoded = decodeWireMessage(frame);
      if (decoded.isErr()) {
        throw decoded.error;
      }
      const { payload } = decoded.value;
      // A protocol error or any other reply to this id grants nothing.
      if (
        payload.traitId === PERMISSIONS_REQUEST_REMOTE_PERMISSION.trait &&
        payload.methodId === PERMISSIONS_REQUEST_REMOTE_PERMISSION.method &&
        payload.messageType === MESSAGE_TYPE_RESPONSE
      ) {
        const result = remotePermissionResult.dec(payload.value);
        granted = result.success && result.value.value.granted;
      }
    } catch (error) {
      settle(false);
      throw new Error("Host returned a malformed JAM peers permission reply", {
        cause: error,
      });
    }
    settle(granted);
    return true;
  }

  /** Genesis hashes the host granted to this execution, in grant order. */
  granted(): string[] {
    return [...this.grantedGenesis];
  }

  /** Refuse outstanding and future requests when the execution stops. */
  close(): void {
    this.closed = true;
    for (const settle of this.pending.values()) {
      settle(false);
    }
    this.pending.clear();
  }
}
