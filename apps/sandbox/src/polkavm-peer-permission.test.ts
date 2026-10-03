// @vitest-environment node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  TRUAPI_CODEC_VERSION,
  VersionedHostHandshakeRequest,
  VersionedHostJamPeerTransportDialError,
  VersionedHostJamPeerTransportDialRequest,
  VersionedHostJamPeerTransportDialResponse,
  VersionedHostJamPeerTransportEventsRequest,
  VersionedRemotePermissionError,
  VersionedRemotePermissionRequest,
  VersionedRemotePermissionResponse,
} from '@parity/truapi';
import {
  createJamPeerTransportSession,
  type JamPeerTransportSession,
  type WebTransportLike,
} from '@parity/truapi/jam-peer-transport';
import * as S from '@parity/truapi/scale';
import {
  ACCOUNT_GET_ACCOUNT,
  JAM_PEER_TRANSPORT_DIAL,
  JAM_PEER_TRANSPORT_EVENTS,
  PERMISSIONS_REQUEST_REMOTE_PERMISSION,
  SYSTEM_HANDSHAKE,
} from '@parity/truapi/wire-table';
import { JamPeersPermissionRequester } from './polkavm-peer-permission.js';
import { dispatchHostFrame } from './polkavm-runtime.js';

const GENESIS = `0x3539${'35'.repeat(30)}` as const;
const OTHER_GENESIS = `0x${'ab'.repeat(32)}` as const;
/** A compressed P-256 point: the session derives WebTransport certificate hashes from it. */
const P256 = '0x028874174c8f469438a1b1bab2fde75f9c4999461382ec6d47e9b3b4511294c607';
const dialResult = S.Result(
  VersionedHostJamPeerTransportDialResponse,
  S.CallError(VersionedHostJamPeerTransportDialError),
);
const permissionResult = S.Result(VersionedRemotePermissionResponse, S.CallError(VersionedRemotePermissionError));

let requestCounter = 0;
function frame(
  ids: { trait: number; method: number },
  value: Uint8Array,
  messageType = MESSAGE_TYPE_REQUEST,
  requestId = `guest-${String(requestCounter++)}`,
): Uint8Array<ArrayBuffer> {
  const encoded = encodeWireMessage({
    requestId,
    payload: { traitId: ids.trait, methodId: ids.method, messageType, value },
  });
  if (encoded.isErr()) {
    throw encoded.error;
  }
  return new Uint8Array(encoded.value);
}

const handshake = (): Uint8Array<ArrayBuffer> =>
  frame(
    SYSTEM_HANDSHAKE,
    VersionedHostHandshakeRequest.enc({
      tag: 'V1',
      value: { codecVersion: TRUAPI_CODEC_VERSION },
    }),
  );

const dial = (genesis: `0x${string}`): Uint8Array<ArrayBuffer> =>
  frame(
    JAM_PEER_TRANSPORT_DIAL,
    VersionedHostJamPeerTransportDialRequest.enc({
      tag: 'V1',
      value: {
        genesis,
        ip: `0x${'00'.repeat(10)}ffff7f000001`,
        port: 43000,
        ed25519: `0x${'11'.repeat(32)}`,
        p256: P256,
      },
    }),
  );

function fakeTransport(): WebTransportLike {
  return {
    ready: Promise.resolve(),
    closed: new Promise(() => undefined),
    incomingBidirectionalStreams: new ReadableStream(),
    createBidirectionalStream: () => Promise.reject(new Error('unused')),
    close: () => undefined,
  };
}

/**
 * One execution: the sandbox's requester and session on a fake authenticated
 * host port. The fake host answers `permissions.request_remote_permission`
 * like the core does after its prompt, and records what the guest sent.
 */
function execution(answer: (genesis: string) => boolean): {
  send: (request: Uint8Array<ArrayBuffer>) => void;
  responses: () => Promise<Uint8Array[]>;
  prompts: string[];
  hostFrames: Uint8Array[];
  connects: string[];
  requester: JamPeersPermissionRequester;
  session: JamPeerTransportSession;
} {
  const prompts: string[] = [];
  const hostFrames: Uint8Array[] = [];
  const connects: string[] = [];
  const guestResponses: Uint8Array[] = [];
  const errors: Error[] = [];
  let requester: JamPeersPermissionRequester | null = null;
  const port = {
    postMessage(message: unknown): void {
      if (!(message instanceof Uint8Array)) {
        throw new Error('Expected a binary host frame');
      }
      const bytes = message;
      const decoded = decodeWireMessage(bytes);
      if (decoded.isErr()) {
        throw decoded.error;
      }
      const { requestId, payload } = decoded.value;
      if (
        payload.traitId !== PERMISSIONS_REQUEST_REMOTE_PERMISSION.trait ||
        payload.methodId !== PERMISSIONS_REQUEST_REMOTE_PERMISSION.method
      ) {
        hostFrames.push(bytes);
        return;
      }
      const request = VersionedRemotePermissionRequest.dec(payload.value);
      const { permission } = request.value;
      if (permission.tag !== 'JamPeers') {
        throw new Error(`unexpected permission ${permission.tag}`);
      }
      prompts.push(permission.value.genesis);
      const reply = frame(
        PERMISSIONS_REQUEST_REMOTE_PERMISSION,
        permissionResult.enc({
          success: true,
          value: {
            tag: 'V1',
            value: { granted: answer(permission.value.genesis) },
          },
        }),
        MESSAGE_TYPE_RESPONSE,
        requestId,
      );
      queueMicrotask(() => {
        // The sandbox consumes its own reply; the guest never sees it.
        expect(requester?.claim(reply)).toBe(true);
      });
    },
  };
  requester = new JamPeersPermissionRequester(port, { webTransportAvailable: true });
  const session = createJamPeerTransportSession({
    authorize: requester.authorize,
    connect: url => {
      connects.push(url);
      return fakeTransport();
    },
    now: () => 1_790_380_800,
  });
  const pending: Promise<void>[] = [];
  return {
    send: request => {
      // Requests of the JamPeerTransport trait resolve on the session's reply;
      // everything else is posted to the host synchronously.
      const { promise, resolve } = Promise.withResolvers<undefined>();
      pending.push(promise);
      const routed = dispatchHostFrame(
        request,
        port,
        session,
        response => {
          guestResponses.push(response);
          resolve(undefined);
        },
        error => {
          errors.push(error);
          resolve(undefined);
        },
      );
      expect(routed).toBe(true);
      if (wireTrait(request) !== JAM_PEER_TRANSPORT_DIAL.trait) {
        resolve(undefined);
      }
    },
    responses: async () => {
      await Promise.all(pending);
      expect(errors).toEqual([]);
      return guestResponses;
    },
    prompts,
    hostFrames,
    connects,
    requester,
    session,
  };
}

function wireTrait(bytes: Uint8Array): number | undefined {
  const decoded = decodeWireMessage(bytes);
  return decoded.isOk() ? decoded.value.payload.traitId : undefined;
}

function dialOutcome(response: Uint8Array): string {
  const decoded = decodeWireMessage(response);
  if (decoded.isErr()) {
    throw decoded.error;
  }
  const result = dialResult.dec(decoded.value.payload.value);
  if (result.success) {
    return `conn ${String(result.value.value.conn)}`;
  }
  return result.value.tag === 'Domain' ? result.value.value.value : result.value.tag;
}

describe('PolkaVM JAM peer access as a runtime permission', () => {
  it('answers a denied dial NotGranted without opening a WebTransport', async () => {
    const app = execution(() => false);
    app.send(handshake());
    app.send(dial(GENESIS));

    const responses = await app.responses();
    expect(responses.map(dialOutcome)).toEqual(['NotGranted']);
    expect(app.prompts).toEqual([GENESIS]);
    expect(app.connects).toEqual([]);
    expect(app.requester.granted()).toEqual([]);
    app.requester.close();
    app.session.close();
  });

  it('dials the peer once the host grants the network, and lists the grant', async () => {
    const app = execution(() => true);
    app.send(handshake());
    app.send(dial(GENESIS));

    const responses = await app.responses();
    expect(responses.map(dialOutcome)).toEqual(['conn 1']);
    expect(app.connects).toHaveLength(1);
    expect(app.requester.granted()).toEqual([GENESIS]);
    // Only the guest handshake reached the host as a guest frame.
    expect(app.hostFrames.map(wireTrait)).toEqual([SYSTEM_HANDSHAKE.trait]);
    app.session.close();
  });

  it('prompts once for six dials of one network and separately for another', async () => {
    const app = execution(genesis => genesis === GENESIS);
    app.send(handshake());
    for (let index = 0; index < 6; index++) {
      app.send(dial(GENESIS));
    }
    app.send(dial(OTHER_GENESIS));

    const outcomes = (await app.responses()).map(dialOutcome);
    expect(outcomes.filter(outcome => outcome.startsWith('conn'))).toHaveLength(6);
    expect(outcomes.filter(outcome => outcome === 'NotGranted')).toHaveLength(1);
    expect(app.prompts).toEqual([GENESIS, OTHER_GENESIS]);
    expect(app.connects).toHaveLength(6);
    expect(app.requester.granted()).toEqual([GENESIS]);
    app.session.close();
  });

  it('never asks the host on behalf of an app that never dials', async () => {
    const app = execution(() => true);
    app.send(handshake());
    app.send(frame(ACCOUNT_GET_ACCOUNT, new Uint8Array()));
    app.send(frame(JAM_PEER_TRANSPORT_EVENTS, VersionedHostJamPeerTransportEventsRequest.enc({ tag: 'V1' })));

    await app.responses();
    expect(app.prompts).toEqual([]);
    expect(app.hostFrames.map(wireTrait)).toEqual([SYSTEM_HANDSHAKE.trait, ACCOUNT_GET_ACCOUNT.trait]);
    app.session.close();
  });

  it('leaves guest replies to the guest and refuses outstanding requests on stop', async () => {
    const port = { postMessage: vi.fn() };
    const requester = new JamPeersPermissionRequester(port, { webTransportAvailable: true });
    const guestReply = frame(
      PERMISSIONS_REQUEST_REMOTE_PERMISSION,
      permissionResult.enc({
        success: true,
        value: { tag: 'V1', value: { granted: true } },
      }),
      MESSAGE_TYPE_RESPONSE,
    );
    expect(requester.claim(guestReply)).toBe(false);

    const answer = requester.authorize(GENESIS);
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(requester.claim(guestReply)).toBe(false);
    requester.close();
    await expect(answer).resolves.toBe(false);
    await expect(requester.authorize(GENESIS)).resolves.toBe(false);
    expect(port.postMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses locally and reports once when WebTransport is unavailable', async () => {
    const port = { postMessage: vi.fn() };
    const onWebTransportUnavailable = vi.fn();
    const requester = new JamPeersPermissionRequester(port, {
      webTransportAvailable: false,
      onWebTransportUnavailable,
    });

    await expect(Promise.all([requester.authorize(GENESIS), requester.authorize(OTHER_GENESIS)])).resolves.toEqual([
      false,
      false,
    ]);
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(onWebTransportUnavailable).toHaveBeenCalledTimes(1);
  });

  it('keeps the 1 MiB host bound for non-peer frames', () => {
    const port = { postMessage: vi.fn() };
    const session = createJamPeerTransportSession({
      authorize: () => Promise.resolve(true),
    });
    expect(
      dispatchHostFrame(
        new Uint8Array(1024 * 1024 + 1),
        port,
        session,
        () => undefined,
        () => undefined,
      ),
    ).toBe(false);
    expect(port.postMessage).not.toHaveBeenCalled();
    session.close();
  });
});
