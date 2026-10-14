// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  MESSAGE_TYPE_INTERRUPT,
  MESSAGE_TYPE_RECEIVE,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  MESSAGE_TYPE_START,
  MESSAGE_TYPE_STOP,
  type MethodIds,
  VersionedRemoteChainHeadFollowRequest,
  VersionedRemoteChainHeadHeaderError,
  VersionedRemoteChainHeadHeaderRequest,
  VersionedRemoteChainHeadHeaderResponse,
  VersionedRemoteChainHeadUnpinError,
  VersionedHostSignRawRequest,
  VersionedRemoteChainHeadUnpinResponse,
} from '@parity/truapi';
import { CallError, Result } from '@parity/truapi/scale';
import * as WIRE_TABLE from '@parity/truapi/wire-table';
import {
  CHAIN_FOLLOW_HEAD_SUBSCRIBE,
  CHAIN_GET_HEAD_HEADER,
  CHAIN_UNPIN_HEAD,
  ENTROPY_DERIVE,
  LOCAL_STORAGE_READ,
  RESOURCE_ALLOCATION_REQUEST,
  SIGNING_CREATE_TRANSACTION,
  SIGNING_CREATE_TRANSACTION_WITH_LEGACY_ACCOUNT,
  SIGNING_SIGN_PAYLOAD,
  SIGNING_SIGN_PAYLOAD_WITH_LEGACY_ACCOUNT,
  SIGNING_SIGN_RAW,
  SIGNING_SIGN_RAW_WITH_LEGACY_ACCOUNT,
  SYSTEM_HANDSHAKE,
} from '@parity/truapi/wire-table';
import { describeWireFrame, wireFrameId, wireFrameKey, type WireFrameId } from './debug-wire-describe.js';
import { blockHash, genesisHash } from '../testing/fixtures.js';

function payloadBytes(codec: { enc: (v: never) => Uint8Array }, value: unknown): Uint8Array {
  return codec.enc(value as never);
}

/** SCALE decodes zeros as every field's zero value (variant 0, empty, false) and ignores the bytes it does not need. */
const ZERO_PAYLOAD = new Uint8Array(512);

type Leg = 'start' | 'receive' | 'interrupt' | 'stop' | 'request' | 'response';

/** What a decoded zero payload looks like per leg: version 1, and for a response the Ok side of the result. */
const DECODED = {
  start: { tag: 'V1' },
  receive: { tag: 'V1' },
  request: { tag: 'V1' },
  response: { success: true, value: { tag: 'V1' } },
};

const LEGS: Record<MethodIds['kind'], readonly (readonly [number, Leg])[]> = {
  subscription: [
    [MESSAGE_TYPE_START, 'start'],
    [MESSAGE_TYPE_RECEIVE, 'receive'],
    [MESSAGE_TYPE_INTERRUPT, 'interrupt'],
    [MESSAGE_TYPE_STOP, 'stop'],
  ],
  request: [
    [MESSAGE_TYPE_REQUEST, 'request'],
    [MESSAGE_TYPE_RESPONSE, 'response'],
  ],
};

function chainFrames(): { leg: Leg; frame: WireFrameId }[] {
  return Object.entries(WIRE_TABLE)
    .filter(([key]) => key.startsWith('CHAIN_'))
    .flatMap(([, ids]) =>
      LEGS[(ids as MethodIds).kind].map(([messageType, leg]) => ({
        leg,
        frame: wireFrameId(ids as MethodIds, messageType),
      })),
    );
}

const WALLET_FRAME_IDS = [
  SIGNING_SIGN_PAYLOAD,
  SIGNING_SIGN_PAYLOAD_WITH_LEGACY_ACCOUNT,
  SIGNING_SIGN_RAW,
  SIGNING_SIGN_RAW_WITH_LEGACY_ACCOUNT,
  SIGNING_CREATE_TRANSACTION,
  SIGNING_CREATE_TRANSACTION_WITH_LEGACY_ACCOUNT,
  RESOURCE_ALLOCATION_REQUEST,
];

describe('describeWireFrame', () => {
  it("As a dotli integrator, the host tags chain frames with the panel's legacy names and decodes their payloads", () => {
    // Given
    const bytes = payloadBytes(VersionedRemoteChainHeadFollowRequest, {
      tag: 'V1',
      value: { genesisHash, withRuntime: true },
    });

    // When
    const described = describeWireFrame(wireFrameId(CHAIN_FOLLOW_HEAD_SUBSCRIBE, MESSAGE_TYPE_START), bytes);

    // Then
    expect(described.tag).toBe('remote_chain_head_follow_start');
    expect(described.value).toEqual({
      tag: 'V1',
      value: { genesisHash, withRuntime: true },
    });
  });

  it('As a dotli integrator, the host decodes chain request payloads with correlation fields intact', () => {
    // Given
    const bytes = payloadBytes(VersionedRemoteChainHeadHeaderRequest, {
      tag: 'V1',
      value: { genesisHash, followSubscriptionId: 'follow_0', hash: blockHash },
    });

    // When
    const described = describeWireFrame(wireFrameId(CHAIN_GET_HEAD_HEADER, MESSAGE_TYPE_REQUEST), bytes);

    // Then
    expect(described.tag).toBe('remote_chain_head_header_request');
    expect((described.value as { value: { followSubscriptionId: string } }).value.followSubscriptionId).toBe(
      'follow_0',
    );
  });

  it('As a dotli integrator, the host names non-chain frames from the wire table without decoding them', () => {
    // Given: a system handshake frame (not in the codec registry).
    const bytes = new Uint8Array([1, 2, 3]);

    // When
    const frame = wireFrameId(SYSTEM_HANDSHAKE, MESSAGE_TYPE_REQUEST);
    const described = describeWireFrame(frame, bytes);

    // Then: mechanical name, raw payload preserved for the detail pane.
    expect(described.tag).toBe('system_handshake_request');
    expect(described.value).toEqual({
      wireId: wireFrameKey(frame),
      bytes,
    });
  });

  it('As a dotli integrator, the host redacts sensitive families to metadata only', () => {
    // Given
    const bytes = new Uint8Array(48);

    // When
    const described = describeWireFrame(wireFrameId(LOCAL_STORAGE_READ, MESSAGE_TYPE_REQUEST), bytes);

    // Then: named, but neither decoded value nor raw bytes escape the tap.
    expect(described.tag).toBe('local_storage_read_request');
    expect(described.value).toEqual({ redacted: true, byteLength: 48 });
  });

  it('As a dotli integrator, the host falls back to wire_<trait>_<method>_<type> for unknown discriminants', () => {
    // Given
    const bytes = new Uint8Array([9]);
    const frame = { traitId: 250, methodId: 7, messageType: 0 };

    // When
    const described = describeWireFrame(frame, bytes);

    // Then
    expect(described.tag).toBe('wire_250_7_0');
    expect(described.value).toEqual({ wireId: wireFrameKey(frame), bytes });
  });

  it('As a dotli integrator, the host degrades to raw bytes when a registered codec fails to decode', () => {
    // Given: garbage bytes on a chain discriminant.
    const bytes = new Uint8Array([0xff, 0xff, 0xff]);

    // When
    const described = describeWireFrame(wireFrameId(CHAIN_GET_HEAD_HEADER, MESSAGE_TYPE_REQUEST), bytes);

    // Then: the tag still resolves and the payload keeps the raw form instead of throwing.
    expect(described.tag).toBe('remote_chain_head_header_request');
    expect(described.value).toEqual({
      wireId: wireFrameKey(wireFrameId(CHAIN_GET_HEAD_HEADER, MESSAGE_TYPE_REQUEST)),
      bytes,
    });
  });

  it("As a dotli integrator, the host decodes a real chainHead.header Ok response using the generated client's wire composition", () => {
    // Given: the exact composition `ChainClient#getHeadHeader` decodes with,
    // Result(<versioned response>, CallError(<versioned error>)). A bare
    // response codec would silently decode this into garbage.
    const codec = Result(VersionedRemoteChainHeadHeaderResponse, CallError(VersionedRemoteChainHeadHeaderError));
    const bytes = payloadBytes(codec, {
      success: true,
      value: { tag: 'V1', value: { header: blockHash } },
    });

    // When
    const described = describeWireFrame(wireFrameId(CHAIN_GET_HEAD_HEADER, MESSAGE_TYPE_RESPONSE), bytes);

    // Then
    expect(described.tag).toBe('remote_chain_head_header_response');
    expect(described.value).toEqual({
      success: true,
      value: { tag: 'V1', value: { header: blockHash } },
    });
  });

  it("As a dotli integrator, the host decodes a real chainHead.header Err response using the generated client's wire composition", () => {
    // Given: a Domain error carrying the method's own versioned GenericError.
    const codec = Result(VersionedRemoteChainHeadHeaderResponse, CallError(VersionedRemoteChainHeadHeaderError));
    const bytes = payloadBytes(codec, {
      success: false,
      value: {
        tag: 'Domain',
        value: { tag: 'V1', value: { reason: 'unknown block' } },
      },
    });

    // When
    const described = describeWireFrame(wireFrameId(CHAIN_GET_HEAD_HEADER, MESSAGE_TYPE_RESPONSE), bytes);

    // Then
    expect(described.tag).toBe('remote_chain_head_header_response');
    expect(described.value).toEqual({
      success: false,
      value: {
        tag: 'Domain',
        value: { tag: 'V1', value: { reason: 'unknown block' } },
      },
    });
  });

  it("As a dotli integrator, the host decodes a real chainHead.unpin (void) Ok response using the generated client's wire composition", () => {
    // Given: `ChainClient#unpinHead` decodes with
    // Result(VersionedRemoteChainHeadUnpinResponse, CallError(...)).
    const codec = Result(VersionedRemoteChainHeadUnpinResponse, CallError(VersionedRemoteChainHeadUnpinError));
    const bytes = payloadBytes(codec, {
      success: true,
      value: { tag: 'V1', value: undefined },
    });

    // When
    const described = describeWireFrame(wireFrameId(CHAIN_UNPIN_HEAD, MESSAGE_TYPE_RESPONSE), bytes);

    // Then
    expect(described.tag).toBe('remote_chain_head_unpin_response');
    expect(described.value).toEqual({
      success: true,
      value: { tag: 'V1', value: undefined },
    });
  });

  it('As a dotli integrator, the host tags chainHead.follow stop/interrupt frames into the chain swimlane without decoding them', () => {
    // Given: control frames with no payload worth decoding.
    const stopBytes = new Uint8Array([1, 2, 3]);
    const interruptBytes = new Uint8Array([4, 5, 6]);

    // When
    const stopFrame = wireFrameId(CHAIN_FOLLOW_HEAD_SUBSCRIBE, MESSAGE_TYPE_STOP);
    const interruptFrame = wireFrameId(CHAIN_FOLLOW_HEAD_SUBSCRIBE, MESSAGE_TYPE_INTERRUPT);
    const stop = describeWireFrame(stopFrame, stopBytes);
    const interrupt = describeWireFrame(interruptFrame, interruptBytes);

    // Then: legacy `remote_chain_*` tags so the swimlane layout keys on them,
    // raw bytes preserved since there's no codec for these.
    expect(stop.tag).toBe('remote_chain_head_follow_stop');
    expect(stop.value).toEqual({
      wireId: wireFrameKey(stopFrame),
      bytes: stopBytes,
    });
    expect(interrupt.tag).toBe('remote_chain_head_follow_interrupt');
    expect(interrupt.value).toEqual({
      wireId: wireFrameKey(interruptFrame),
      bytes: interruptBytes,
    });
  });

  const signRaw = {
    tag: 'V1',
    value: {
      account: { dotNsIdentifier: 'myapp.dot', derivationIndex: { tag: 'Index', value: 0 } },
      payload: { tag: 'Payload', value: { payload: 'hello' } },
    },
  };

  it('As a local wallet user, I see the signing requests my wallet received, decoded', () => {
    // Given
    const bytes = payloadBytes(VersionedHostSignRawRequest, signRaw);

    // When
    const described = describeWireFrame(wireFrameId(SIGNING_SIGN_RAW, MESSAGE_TYPE_REQUEST), bytes, {
      decodeWalletFrames: true,
    });

    // Then
    expect(described.tag).toBe('signing_sign_raw_request');
    expect(described.value).toEqual(signRaw);
  });

  it('As a Polkadot App user, I keep signing requests redacted', () => {
    // Given
    const bytes = payloadBytes(VersionedHostSignRawRequest, signRaw);

    // When
    const described = describeWireFrame(wireFrameId(SIGNING_SIGN_RAW, MESSAGE_TYPE_REQUEST), bytes);

    // Then
    expect(described.value).toEqual({ redacted: true, byteLength: bytes.length });
  });

  it('As a local wallet user, I still never see entropy frames', () => {
    // Given
    const bytes = new Uint8Array(40);

    // When
    const described = describeWireFrame(wireFrameId(ENTROPY_DERIVE, MESSAGE_TYPE_RESPONSE), bytes, {
      decodeWalletFrames: true,
    });

    // Then
    expect(described.value).toEqual({ redacted: true, byteLength: 40 });
  });

  it('As a local wallet user, I get a malformed signing frame redacted rather than garbage', () => {
    // Given
    const bytes = new Uint8Array([0xff, 0xff, 0xff]);

    // When
    const described = describeWireFrame(wireFrameId(SIGNING_SIGN_RAW, MESSAGE_TYPE_REQUEST), bytes, {
      decodeWalletFrames: true,
    });

    // Then
    expect(described.value).toEqual({ redacted: true, byteLength: 3 });
  });

  it('As a dotli integrator, I find a codec for every wallet frame the tap decodes', () => {
    // Given: the frames a local signing host serves itself, each leg carrying its codec's zero value.
    const frames = WALLET_FRAME_IDS.flatMap(ids => [
      { leg: 'request' as const, frame: wireFrameId(ids, MESSAGE_TYPE_REQUEST) },
      { leg: 'response' as const, frame: wireFrameId(ids, MESSAGE_TYPE_RESPONSE) },
    ]);

    // When
    const described = frames.map(({ leg, frame }) => ({
      leg,
      ...describeWireFrame(frame, ZERO_PAYLOAD, { decodeWalletFrames: true }),
    }));

    // Then: every leg decodes, neither redacted nor left as raw bytes.
    for (const { leg, tag, value } of described) {
      expect(value, tag).toMatchObject(DECODED[leg]);
    }
  });
});

// Chain frames keep the legacy `remote_chain_*` tags the panel's swimlane keys on. These tests fail when the installed
// `@parity/truapi` adds, renames or reshapes a chain method the host does not yet describe.
describe('chain-family drift guard', () => {
  it('As a dotli integrator, the host tags and decodes every CHAIN_* wire-table frame', () => {
    // Given: every leg of every chain method the installed `@parity/truapi` defines, carrying its codec's zero value.
    const frames = chainFrames();

    // When
    const described = frames.map(({ leg, frame }) => ({ leg, frame, ...describeWireFrame(frame, ZERO_PAYLOAD) }));

    // Then: a frame without a linkage row would carry its generic wire-table name, and a row whose codec is missing
    // would leave its payload as raw bytes. Control legs are never decoded.
    for (const { leg, frame, tag, value } of described) {
      expect(tag).toMatch(/^remote_chain_/);
      if (leg === 'interrupt' || leg === 'stop') {
        expect(value, tag).toEqual({ wireId: wireFrameKey(frame), bytes: ZERO_PAYLOAD });
      } else {
        expect(value, tag).toMatchObject(DECODED[leg]);
      }
    }
  });

  it("As a dotli integrator, the host derives the exact legacy tag vocabulary the panel's swimlane keys on", () => {
    // Given
    const frames = chainFrames();

    // When: data legs reduce to their method's tag root, and the follow control legs stay full tags.
    const vocabulary = new Set(
      frames.map(({ frame }) =>
        describeWireFrame(frame, ZERO_PAYLOAD).tag.replace(/_(request|response|start|receive)$/, ''),
      ),
    );

    // Then: pins the exact current 16-entry legacy vocabulary as a literal snapshot, so it can't drift silently.
    expect(vocabulary).toEqual(
      new Set([
        'remote_chain_head_follow',
        'remote_chain_head_header',
        'remote_chain_head_body',
        'remote_chain_head_storage',
        'remote_chain_head_call',
        'remote_chain_head_unpin',
        'remote_chain_head_continue',
        'remote_chain_head_stop_operation',
        'remote_chain_spec_genesis_hash',
        'remote_chain_spec_chain_name',
        'remote_chain_spec_properties',
        'remote_chain_info',
        'remote_chain_transaction_broadcast',
        'remote_chain_transaction_stop',
        'remote_chain_head_follow_stop',
        'remote_chain_head_follow_interrupt',
      ]),
    );
  });
});
