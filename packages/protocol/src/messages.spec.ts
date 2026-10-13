// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  NETWORK_NAME_TO_SERVICES_CONFIG,
  NetworkName,
  configureModeStorage,
  getActiveSupportedGenesisHashes,
  setNetwork,
} from '@dotli/config';
import {
  ENVELOPE_CHAIN_KEYS,
  ENVELOPE_SYNC_KINDS,
  isChainSyncPayloadValid,
  isProgressPayloadValid,
  getRequestSyncTimeoutMs,
  isProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolResponseEnvelope,
  type ProtocolErrorEnvelope,
  type ProtocolProgressEnvelope,
  type ProtocolChainMessageEnvelope,
  type ProtocolChainHaltEnvelope,
  type ProtocolReadyEnvelope,
  type ProtocolChainSyncEnvelope,
  type ProtocolSmoldotDbEnvelope,
} from './messages.js';

describe('isProtocolEnvelope', () => {
  it('As a protocol message listener, I take a request envelope as one of ours', () => {
    // Given
    const envelope: ProtocolRequestEnvelope = {
      namespace: 'dotli:protocol',
      kind: 'request',
      id: 'test-1',
      method: 'warmup',
      payload: {},
    };

    // When / Then
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it('As a protocol message listener, I take a response envelope as one of ours', () => {
    // Given
    const envelope: ProtocolResponseEnvelope = {
      namespace: 'dotli:protocol',
      kind: 'response',
      id: 'test-1',
      ok: true,
      result: 'some-cid',
    };

    // When / Then
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it('As a protocol message listener, I take an error envelope as one of ours', () => {
    // Given
    const envelope: ProtocolErrorEnvelope = {
      namespace: 'dotli:protocol',
      kind: 'response',
      id: 'test-1',
      ok: false,
      error: 'something failed',
    };

    // When / Then
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it('As a protocol message listener, I take a progress envelope as one of ours', () => {
    // Given
    const envelope: ProtocolProgressEnvelope = {
      namespace: 'dotli:protocol',
      kind: 'progress',
      id: 'test-1',
      phase: 'asset-hub-connecting',
    };

    // When / Then
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it('As a protocol message listener, I take a chain-message envelope as one of ours', () => {
    // Given
    const envelope: ProtocolChainMessageEnvelope = {
      namespace: 'dotli:protocol',
      kind: 'chain-message',
      connectionId: 'conn-1',
      message: '{"jsonrpc":"2.0"}',
    };

    // When / Then
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it('As a protocol message listener, I take a chain-halt envelope as one of ours', () => {
    // Given
    const envelope: ProtocolChainHaltEnvelope = {
      namespace: 'dotli:protocol',
      kind: 'chain-halt',
      connectionId: 'conn-1',
    };

    // When / Then
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it('As a protocol message listener, I take a ready envelope as one of ours', () => {
    // Given
    const envelope: ProtocolReadyEnvelope = {
      namespace: 'dotli:protocol',
      kind: 'ready',
    };

    // When / Then
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it('As a protocol message listener, I take a smoldot-db envelope as one of ours', () => {
    // Given
    const envelope: ProtocolSmoldotDbEnvelope = {
      namespace: 'dotli:protocol',
      kind: 'smoldot-db',
      chain: 'hub',
      outcome: 'hit',
    };

    // When / Then
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it('As a protocol message listener, I hear null and ignore it', () => {
    // When / Then
    expect(isProtocolEnvelope(null)).toBe(false);
  });

  it('As a protocol message listener, I hear undefined and ignore it', () => {
    // When / Then
    expect(isProtocolEnvelope(undefined)).toBe(false);
  });

  it('As a protocol message listener, I hear a bare string and ignore it', () => {
    // When / Then
    expect(isProtocolEnvelope('dotli:protocol')).toBe(false);
  });

  it('As a protocol message listener, I hear a number and ignore it', () => {
    // When / Then
    expect(isProtocolEnvelope(42)).toBe(false);
  });

  it('As a protocol message listener, I hear an empty object and ignore it', () => {
    // When / Then
    expect(isProtocolEnvelope({})).toBe(false);
  });

  it("As a protocol message listener, I hear another namespace's message and ignore it", () => {
    // When / Then
    expect(isProtocolEnvelope({ namespace: 'other:protocol', kind: 'request' })).toBe(false);
  });

  it('As a protocol message listener, I hear a message without a kind and ignore it', () => {
    // When / Then
    expect(isProtocolEnvelope({ namespace: 'dotli:protocol' })).toBe(false);
  });

  it('As a protocol message listener, I hear a message of an unknown kind and ignore it', () => {
    // When / Then
    expect(isProtocolEnvelope({ namespace: 'dotli:protocol', kind: 'unknown' })).toBe(false);
  });

  it('As a protocol message listener, I hear a message without a namespace and ignore it', () => {
    // When / Then
    expect(isProtocolEnvelope({ kind: 'request' })).toBe(false);
  });
});

describe('progress envelope validation', () => {
  const progress = (phase: unknown): ProtocolProgressEnvelope =>
    ({ namespace: 'dotli:protocol', kind: 'progress', id: 'r1', phase }) as ProtocolProgressEnvelope;

  it("As the host, I take a resolve phase from the frame's progress", () => {
    // Given
    const envelope = progress('asset-hub-syncing');

    // When
    const valid = isProgressPayloadValid(envelope);

    // Then
    expect(valid).toBe(true);
  });

  it.each([
    ['Syncing with Asset Hub Paseo...'],
    ['__proto__'],
    [undefined],
    [3],
    ['light-client-starting'],
    ['relay-chain-adding'],
  ])('As the host, I drop a progress whose phase %j is not one the resolver reports', phase => {
    // Given
    const envelope = progress(phase);

    // When
    const valid = isProgressPayloadValid(envelope);

    // Then
    expect(valid).toBe(false);
  });
});

describe('getRequestSyncTimeoutMs', () => {
  // Not inside a test body: a failing assertion would leak the mock onward.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const requestWithDeadline = (deadlineMs?: number): ProtocolRequestEnvelope => ({
    namespace: 'dotli:protocol',
    kind: 'request',
    id: 'test-deadline',
    method: 'resolveDotName',
    payload: { label: 'chinpokomon' },
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  });

  it("As a handler of a request with a deadline, I get a sync budget that leaves time to deliver the response inside the caller's deadline", () => {
    // Given
    vi.spyOn(Date, 'now').mockReturnValue(10_000);

    // When
    const budget = getRequestSyncTimeoutMs(requestWithDeadline(100_000));

    // Then
    expect(budget).toBe(89_000);
  });

  it('As a handler reading an already-expired deadline, my budget stays positive', () => {
    // Given
    vi.spyOn(Date, 'now').mockReturnValue(100_000);

    // When
    const budget = getRequestSyncTimeoutMs(requestWithDeadline(10_000));

    // Then
    expect(budget).toBe(1);
  });

  it('As a handler of a request without a finite deadline, I get no sync budget', () => {
    // Given
    const request: ProtocolRequestEnvelope = {
      namespace: 'dotli:protocol',
      kind: 'request',
      id: 'test-no-deadline',
      method: 'warmup',
      payload: {},
    };

    // When / Then
    expect(getRequestSyncTimeoutMs(request)).toBeUndefined();
    request.deadlineMs = Number.POSITIVE_INFINITY;
    expect(getRequestSyncTimeoutMs(request)).toBeUndefined();
  });
});

describe('getActiveSupportedGenesisHashes', () => {
  let restoreStorage: () => void;

  beforeEach(() => {
    const stored = new Map<string, string>();
    restoreStorage = configureModeStorage({
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value);
      },
      removeItem: key => {
        stored.delete(key);
      },
    });
  });

  afterEach(() => {
    restoreStorage();
  });

  it('As a product on Paseo, I target an unknown genesis hash and it is not supported', () => {
    // Given
    setNetwork(NetworkName.PASEO);

    // When / Then
    expect(getActiveSupportedGenesisHashes().has('0xdeadbeef')).toBe(false);
  });
});

describe('genesis hash constants', () => {
  it('As a dotli maintainer, I give every network a relay genesis as a 0x-prefixed hex string', () => {
    // When / Then
    for (const cfg of Object.values(NETWORK_NAME_TO_SERVICES_CONFIG)) {
      expect(cfg.relay.genesis).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

describe('chain-sync envelope validation works', () => {
  function envelope(over: Partial<ProtocolChainSyncEnvelope> = {}): ProtocolChainSyncEnvelope {
    return {
      namespace: 'dotli:protocol',
      kind: 'chain-sync',
      chain: 'relay',
      syncKind: 'firstPeer',
      ...over,
    };
  }

  // Drift guard: the validator keeps its own copy of the resolver's vocabulary, and a gap drops kinds silently.
  it('As a user, every sync milestone the resolver can emit reaches the shell', () => {
    // Given / When / Then
    for (const chain of ENVELOPE_CHAIN_KEYS) {
      for (const syncKind of ENVELOPE_SYNC_KINDS) {
        expect(
          isChainSyncPayloadValid(
            envelope({
              chain,
              syncKind,
              ...(syncKind === 'peers' ? { peers: 1 } : {}),
            }),
          ),
        ).toBe(true);
      }
    }
  });

  it('As a user, a spoofed chain or milestone is refused', () => {
    // Given / When / Then
    expect(
      isChainSyncPayloadValid(
        envelope({
          chain: 'not-a-chain' as (typeof ENVELOPE_CHAIN_KEYS)[number],
        }),
      ),
    ).toBe(false);
    expect(
      isChainSyncPayloadValid(
        envelope({
          syncKind: 'somethingElse' as (typeof ENVELOPE_SYNC_KINDS)[number],
        }),
      ),
    ).toBe(false);
  });

  it('As a user, a nonsense peer count or block height is refused', () => {
    // Given / When / Then
    for (const peers of [-1, 1.5, 10_001, Number.NaN]) {
      expect(isChainSyncPayloadValid(envelope({ syncKind: 'peers', peers }))).toBe(false);
    }
    expect(isChainSyncPayloadValid(envelope({ syncKind: 'warpSyncProgress', at: Number.NaN, target: 10 }))).toBe(false);
    expect(isChainSyncPayloadValid(envelope({ syncKind: 'warpSyncFinished', finalized: -5 }))).toBe(false);
  });
});
