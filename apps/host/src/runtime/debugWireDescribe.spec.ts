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
import { describeWireFrame, getWireFrameId, getWireFrameKey, type WireFrameId } from './debugWireDescribe.js';
import { blockHash, genesisHash } from '../testing/fixtures.js';

type Leg = 'start' | 'receive' | 'interrupt' | 'stop' | 'request' | 'response';

/** SCALE decodes zeros as every field's zero value (variant 0, empty, false) and ignores the bytes it does not need. */
const ZERO_PAYLOAD = new Uint8Array(512);

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

const WALLET_FRAME_IDS = [
  SIGNING_SIGN_PAYLOAD,
  SIGNING_SIGN_PAYLOAD_WITH_LEGACY_ACCOUNT,
  SIGNING_SIGN_RAW,
  SIGNING_SIGN_RAW_WITH_LEGACY_ACCOUNT,
  SIGNING_CREATE_TRANSACTION,
  SIGNING_CREATE_TRANSACTION_WITH_LEGACY_ACCOUNT,
  RESOURCE_ALLOCATION_REQUEST,
];

// A response leg carries Result(<versioned response>, CallError(<versioned error>)) on the wire. A bare response codec
// would decode it into garbage.
const HEADER_RESPONSE_CODEC = Result(
  VersionedRemoteChainHeadHeaderResponse,
  CallError(VersionedRemoteChainHeadHeaderError),
);
const UNPIN_RESPONSE_CODEC = Result(
  VersionedRemoteChainHeadUnpinResponse,
  CallError(VersionedRemoteChainHeadUnpinError),
);

const SIGN_RAW = {
  tag: 'V1',
  value: {
    account: { dotNsIdentifier: 'myapp.dot', derivationIndex: { tag: 'Index', value: 0 } },
    payload: { tag: 'Payload', value: { payload: 'hello' } },
  },
};

function encodePayload(codec: { enc: (value: never) => Uint8Array }, value: unknown): Uint8Array {
  // Each codec takes its own generated value type, which a test spells as plain data.
  return codec.enc(value as never);
}

/** Every leg of every chain method the installed wire table defines. */
function listChainFrames(): { leg: Leg; frame: WireFrameId }[] {
  return Object.entries(WIRE_TABLE)
    .filter(([key]) => key.startsWith('CHAIN_'))
    .flatMap(([, ids]) =>
      LEGS[ids.kind].map(([messageType, leg]) => ({
        leg,
        frame: getWireFrameId(ids, messageType),
      })),
    );
}

/** Whether `leg` is a subscription's control leg, which carries no payload worth decoding. */
function isControlLeg(leg: Leg): leg is 'interrupt' | 'stop' {
  return leg === 'interrupt' || leg === 'stop';
}

describe('describeWireFrame', () => {
  it("As a dotli integrator, I describe a chain frame and it carries the panel's legacy name and its decoded payload", () => {
    // Given a chain follow start frame
    const bytes = encodePayload(VersionedRemoteChainHeadFollowRequest, {
      tag: 'V1',
      value: { genesisHash, withRuntime: true },
    });

    // When it is described
    const described = describeWireFrame(getWireFrameId(CHAIN_FOLLOW_HEAD_SUBSCRIBE, MESSAGE_TYPE_START), bytes);

    // Then it carries the legacy tag and the decoded payload
    expect(described).toEqual({
      tag: 'remote_chain_head_follow_start',
      value: {
        tag: 'V1',
        value: { genesisHash, withRuntime: true },
      },
    });
  });

  it('As a dotli integrator, I describe a non-chain frame and it is named from the wire table without decoding', () => {
    // Given: a system handshake frame (not in the codec registry).
    const bytes = new Uint8Array([1, 2, 3]);
    const frame = getWireFrameId(SYSTEM_HANDSHAKE, MESSAGE_TYPE_REQUEST);

    // When it is described
    const described = describeWireFrame(frame, bytes);

    // Then: mechanical name, raw payload preserved for the detail pane.
    expect(described).toEqual({
      tag: 'system_handshake_request',
      value: { wireId: getWireFrameKey(frame), bytes },
    });
  });

  it('As a dotli integrator, I describe a frame of a sensitive family and see its metadata only', () => {
    // Given a local storage read frame
    const bytes = new Uint8Array(48);

    // When it is described
    const described = describeWireFrame(getWireFrameId(LOCAL_STORAGE_READ, MESSAGE_TYPE_REQUEST), bytes);

    // Then: named, but neither decoded value nor raw bytes escape the tap.
    expect(described).toEqual({ tag: 'local_storage_read_request', value: { redacted: true, byteLength: 48 } });
  });

  it('As a dotli integrator, I describe a frame with an unknown discriminant and it falls back to wire_<trait>_<method>_<type>', () => {
    // Given a frame no wire table names
    const bytes = new Uint8Array([9]);
    const frame = { traitId: 250, methodId: 7, messageType: 0 };

    // When it is described
    const described = describeWireFrame(frame, bytes);

    // Then it carries the mechanical tag and its raw bytes
    expect(described).toEqual({ tag: 'wire_250_7_0', value: { wireId: getWireFrameKey(frame), bytes } });
  });

  it('As a dotli integrator, I describe a chain frame whose codec fails to decode and get its raw bytes', () => {
    // Given: garbage bytes on a chain discriminant.
    const bytes = new Uint8Array([0xff, 0xff, 0xff]);
    const frame = getWireFrameId(CHAIN_GET_HEAD_HEADER, MESSAGE_TYPE_REQUEST);

    // When it is described
    const described = describeWireFrame(frame, bytes);

    // Then: the tag still resolves and the payload keeps the raw form instead of throwing.
    expect(described).toEqual({
      tag: 'remote_chain_head_header_request',
      value: { wireId: getWireFrameKey(frame), bytes },
    });
  });

  it.each([
    {
      response: 'chainHead.header Ok',
      ids: CHAIN_GET_HEAD_HEADER,
      codec: HEADER_RESPONSE_CODEC,
      value: { success: true, value: { tag: 'V1', value: { header: blockHash } } },
      tag: 'remote_chain_head_header_response',
    },
    {
      response: 'chainHead.header Err, a Domain error carrying the method',
      ids: CHAIN_GET_HEAD_HEADER,
      codec: HEADER_RESPONSE_CODEC,
      value: { success: false, value: { tag: 'Domain', value: { tag: 'V1', value: { reason: 'unknown block' } } } },
      tag: 'remote_chain_head_header_response',
    },
    {
      response: 'chainHead.unpin (void) Ok',
      ids: CHAIN_UNPIN_HEAD,
      codec: UNPIN_RESPONSE_CODEC,
      value: { success: true, value: { tag: 'V1', value: undefined } },
      tag: 'remote_chain_head_unpin_response',
    },
  ])(
    'As a dotli integrator, I describe a real $response response and it decodes through the result framing the wire carries',
    ({ ids, codec, value, tag }) => {
      // Given the response framed as the wire carries it
      const bytes = encodePayload(codec, value);

      // When it is described
      const described = describeWireFrame(getWireFrameId(ids, MESSAGE_TYPE_RESPONSE), bytes);

      // Then it carries the legacy tag and the decoded result
      expect(described).toEqual({ tag, value });
    },
  );

  it('As a local wallet user, I watch my wallet receive a signing request and see it decoded', () => {
    // Given a sign raw request frame
    const bytes = encodePayload(VersionedHostSignRawRequest, SIGN_RAW);

    // When it is described with wallet frames decoded
    const described = describeWireFrame(getWireFrameId(SIGNING_SIGN_RAW, MESSAGE_TYPE_REQUEST), bytes, {
      decodeWalletFrames: true,
    });

    // Then it carries its tag and the decoded request
    expect(described).toEqual({ tag: 'signing_sign_raw_request', value: SIGN_RAW });
  });

  it.each([
    {
      user: 'a Polkadot App user',
      frame: 'a signing request',
      ids: SIGNING_SIGN_RAW,
      messageType: MESSAGE_TYPE_REQUEST,
      bytes: encodePayload(VersionedHostSignRawRequest, SIGN_RAW),
      decodeWalletFrames: false,
    },
    {
      user: 'a local wallet user',
      frame: 'an entropy frame',
      ids: ENTROPY_DERIVE,
      messageType: MESSAGE_TYPE_RESPONSE,
      bytes: new Uint8Array(40),
      decodeWalletFrames: true,
    },
    {
      user: 'a local wallet user',
      frame: 'a malformed signing frame',
      ids: SIGNING_SIGN_RAW,
      messageType: MESSAGE_TYPE_REQUEST,
      bytes: new Uint8Array([0xff, 0xff, 0xff]),
      decodeWalletFrames: true,
    },
  ])('As $user, I watch $frame cross and see it redacted', ({ ids, messageType, bytes, decodeWalletFrames }) => {
    // Given the frame's id on the wire
    const frame = getWireFrameId(ids, messageType);

    // When the frame is described
    const described = describeWireFrame(frame, bytes, { decodeWalletFrames });

    // Then only its length leaves the tap
    expect(described.value).toEqual({ redacted: true, byteLength: bytes.length });
  });

  it('As a dotli integrator, I describe every wallet frame the tap decodes and each finds its codec', () => {
    // Given the frames a local signing host serves itself, each leg carrying its codec's zero value
    const frames = WALLET_FRAME_IDS.flatMap(ids => [
      { leg: 'request' as const, frame: getWireFrameId(ids, MESSAGE_TYPE_REQUEST) },
      { leg: 'response' as const, frame: getWireFrameId(ids, MESSAGE_TYPE_RESPONSE) },
    ]);

    // When each is described with wallet frames decoded
    const described = frames.map(({ leg, frame }) => ({
      leg,
      ...describeWireFrame(frame, ZERO_PAYLOAD, { decodeWalletFrames: true }),
    }));

    // Then: every leg decodes, neither redacted nor left as raw bytes.
    expect(described.map(({ tag, value }) => ({ tag, value }))).toMatchObject(
      described.map(({ tag, leg }) => ({ tag, value: DECODED[leg] })),
    );
  });
});

// Chain frames keep the legacy `remote_chain_*` tags the panel's swimlane keys on. These tests fail when the installed
// `@parity/truapi` adds, renames or reshapes a chain method the host does not yet describe.
describe('chain-family drift guard', () => {
  it('As a dotli integrator, I describe every CHAIN_* wire-table frame and each is tagged and decoded', () => {
    // Given: every leg of every chain method the installed `@parity/truapi` defines, carrying its codec's zero value.
    const frames = listChainFrames();

    // When each is described
    const described = frames.map(({ leg, frame }) => ({ leg, frame, ...describeWireFrame(frame, ZERO_PAYLOAD) }));
    const controlLegs = described.filter(({ leg }) => isControlLeg(leg));
    const dataLegs = described.flatMap(({ leg, tag, value }) => (isControlLeg(leg) ? [] : [{ leg, tag, value }]));

    // Then: a frame without a linkage row would carry its generic wire-table name, and a row whose codec is missing
    // would leave its payload as raw bytes. Control legs are never decoded.
    expect(described.map(({ tag }) => tag).filter(tag => !tag.startsWith('remote_chain_'))).toEqual([]);
    expect(controlLegs.map(({ tag, value }) => ({ tag, value }))).toEqual(
      controlLegs.map(({ tag, frame }) => ({ tag, value: { wireId: getWireFrameKey(frame), bytes: ZERO_PAYLOAD } })),
    );
    expect(dataLegs.map(({ tag, value }) => ({ tag, value }))).toMatchObject(
      dataLegs.map(({ tag, leg }) => ({ tag, value: DECODED[leg] })),
    );
  });

  it("As a dotli integrator, I describe every chain frame and the tags reduce to the exact legacy vocabulary the panel's swimlane keys on", () => {
    // Given every leg of every chain method
    const frames = listChainFrames();

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
