// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { TxCreator } from 'polkadot-api';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedHostCreateTransactionWithLegacyAccountError,
  VersionedHostCreateTransactionWithLegacyAccountRequest,
  VersionedHostCreateTransactionWithLegacyAccountResponse,
  type CallErrorValue,
  type HostCreateTransactionError,
  type LegacyAccountTxPayload,
} from '@parity/truapi';
import { SIGNING_CREATE_TRANSACTION_WITH_LEGACY_ACCOUNT as CREATE } from '@parity/truapi/wire-table';
import { fromHex, toHex } from '@dotli/shared';
import { manualTimers, must } from '@dotli/shared/testing';
import { makeProvider } from '../page-core.fake.js';
import { createChanges } from '../../testing/changes.js';
import { createSiteTxSigner, SiteTxError } from './site-tx-signer.js';

const MAIN_KEY = fromHex('0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48');
const GENESIS = `0x${'11'.repeat(32)}`;
const CALL = '0x0a0300d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d0f0000c16ff28623';
const EXTENSIONS = [{ id: 'CheckMortality', extra: '0x00', additionalSigned: `0x${'22'.repeat(32)}` }];
const TRANSACTION = `0x${'cd'.repeat(120)}` as const;

interface CreateRefusal {
  error: CallErrorValue<HostCreateTransactionError>;
}
type CreateAnswer = { ok: `0x${string}` } | CreateRefusal;

const REJECTED: CreateRefusal = { error: { tag: 'Domain', value: { tag: 'Rejected' } } };
const DENIED_PERMISSION: CreateRefusal = { error: { tag: 'Domain', value: { tag: 'PermissionDenied' } } };

/** The payload papi hands a creator, with the extensions it leaves to the signer omitted. */
function txPayload(txExtVersion: number | null): Parameters<TxCreator>[0] {
  return {
    version: 1,
    signer: null,
    callData: CALL,
    extensions: EXTENSIONS,
    txExtVersion,
    context: {
      metadata: '0x6d657461',
      token: null,
      bestBlockHeight: 1,
      bestBlockHash: `0x${'33'.repeat(32)}`,
      genesisHash: GENESIS,
    },
  };
}

// The creator never reads the chain bindings papi passes.
const BINDINGS = {} as Parameters<TxCreator>[2];

/** The call error a core answers with, its domain error in the version 1 envelope. */
function versioned<E>(error: CallErrorValue<E>): CallErrorValue<{ tag: 'V1'; value: E }> {
  return error.tag === 'Domain' ? { tag: 'Domain', value: { tag: 'V1', value: error.value } } : error;
}

function responseFrame(requestId: string, answer: CreateAnswer): Uint8Array {
  const codec = scale.Result(
    VersionedHostCreateTransactionWithLegacyAccountResponse,
    scale.CallError(VersionedHostCreateTransactionWithLegacyAccountError),
  );
  const value = codec.enc(
    'ok' in answer
      ? { success: true, value: { tag: 'V1', value: { transaction: answer.ok } } }
      : { success: false, value: versioned(answer.error) },
  );
  const frame = encodeWireMessage({
    requestId,
    payload: { traitId: CREATE.trait, methodId: CREATE.method, messageType: MESSAGE_TYPE_RESPONSE, value },
  });
  if (frame.isErr()) {
    throw frame.error;
  }
  return frame.value;
}

/** One core that answers each transaction request with the next queued answer, and records what it was asked. */
function fakeCore(answers: CreateAnswer[]) {
  const changes = createChanges();
  const requests: LegacyAccountTxPayload[] = [];
  const provider = makeProvider({
    onPostMessage: message => {
      const decoded = decodeWireMessage(message);
      if (decoded.isErr()) {
        throw decoded.error;
      }
      const { requestId, payload } = decoded.value;
      if (payload.traitId === CREATE.trait && payload.methodId === CREATE.method) {
        requests.push(VersionedHostCreateTransactionWithLegacyAccountRequest.dec(payload.value).value);
        const answer = must(answers.shift(), 'a transaction answer');
        queueMicrotask(() => {
          provider.listener?.(responseFrame(requestId, answer));
          changes.notify();
        });
      }
    },
  });
  const connection = {
    provider: provider as unknown as TrUApiProductProvider,
    productId: 'dotli-product',
    close: vi.fn(),
  };
  const lease = { connect: vi.fn(() => Promise.resolve(connection)), release: vi.fn() };
  const acquire = vi.fn(() => Promise.resolve(lease));
  return { acquire, lease, connection, requests, changes };
}

describe('site transaction signer', () => {
  it("As a user, I have the site's transaction built for my main account on the request's chain", async () => {
    // Given a core that builds the transaction
    const core = fakeCore([{ ok: TRANSACTION }]);
    const creator = createSiteTxSigner({ acquire: core.acquire, timers: manualTimers() }).creator(MAIN_KEY);

    // When papi asks the creator for a transaction with no extension version preference
    const transaction = await creator(txPayload(null), {}, BINDINGS, false);

    // Then the core was asked for the call on the genesis, signed by the main account, at extension version 0
    expect(transaction).toBe(TRANSACTION);
    expect(core.requests).toEqual([
      {
        signer: toHex(MAIN_KEY),
        genesisHash: GENESIS,
        callData: CALL,
        extensions: EXTENSIONS,
        txExtVersion: 0,
      },
    ]);
  });

  it('As a user, I have the transaction built at the extension version papi asks for', async () => {
    // Given a core that builds the transaction
    const core = fakeCore([{ ok: TRANSACTION }]);
    const creator = createSiteTxSigner({ acquire: core.acquire, timers: manualTimers() }).creator(MAIN_KEY);

    // When papi asks the creator for a transaction at extension version 1
    await creator(txPayload(1), {}, BINDINGS, false);

    // Then the core was asked at that version
    expect(core.requests.map(request => request.txExtVersion)).toEqual([1]);
  });

  const rejections: { path: string; answer: CreateRefusal }[] = [
    { path: 'rejects the transaction on my phone', answer: REJECTED },
    { path: 'withdraws the transaction request', answer: { error: { tag: 'Cancelled' } } },
  ];

  it.each(rejections)('As a user who $path, I see the transaction rejected', async ({ answer }) => {
    // Given a core whose transaction request ends this way
    const core = fakeCore([answer]);
    const creator = createSiteTxSigner({ acquire: core.acquire, timers: manualTimers() }).creator(MAIN_KEY);

    // When papi asks the creator for a transaction
    const error: unknown = await creator(txPayload(null), {}, BINDINGS, false).catch((caught: unknown) => caught);

    // Then it rejects as rejected, with the core's error as its cause
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'rejected', cause: versioned(answer.error) });
  });

  it('As a user whose phone cannot sign for my main account, I see the transaction unsupported', async () => {
    // Given a core that does not support the request
    const core = fakeCore([{ error: { tag: 'Domain', value: { tag: 'NotSupported', value: { reason: 'legacy' } } } }]);
    const creator = createSiteTxSigner({ acquire: core.acquire, timers: manualTimers() }).creator(MAIN_KEY);

    // When papi asks the creator for a transaction
    const error: unknown = await creator(txPayload(null), {}, BINDINGS, false).catch((caught: unknown) => caught);

    // Then it rejects as unsupported
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'unsupported', cause: { tag: 'Domain' } });
  });

  it('As a user whose core does not serve the request at all, I see the transaction unsupported', async () => {
    // Given a core that answers the call itself as unsupported
    const core = fakeCore([{ error: { tag: 'Unsupported' } }]);
    const creator = createSiteTxSigner({ acquire: core.acquire, timers: manualTimers() }).creator(MAIN_KEY);

    // When papi asks the creator for a transaction
    const error: unknown = await creator(txPayload(null), {}, BINDINGS, false).catch((caught: unknown) => caught);

    // Then it rejects as unsupported, with the core's error as its cause
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'unsupported', cause: { tag: 'Unsupported' } });
  });

  it('As a user whose main key is not 32 bytes, I see the transaction fail before the core is asked', async () => {
    // Given a core that would build the transaction, and a creator for a main key one byte short
    const core = fakeCore([{ ok: TRANSACTION }]);
    const creator = createSiteTxSigner({ acquire: core.acquire, timers: manualTimers() }).creator(MAIN_KEY.slice(1));

    // When papi asks the creator for a transaction
    const error: unknown = await creator(txPayload(null), {}, BINDINGS, false).catch((caught: unknown) => caught);

    // Then it rejects as failed before any core lease or request
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'failed' });
    expect(core.acquire).not.toHaveBeenCalled();
    expect(core.requests).toEqual([]);
  });

  it('As a user, I have the transaction built from the hex papi passes, in lowercase', async () => {
    // Given a core that builds the transaction
    const core = fakeCore([{ ok: TRANSACTION }]);
    const creator = createSiteTxSigner({ acquire: core.acquire, timers: manualTimers() }).creator(MAIN_KEY);
    const payload = txPayload(null);
    const upper = {
      ...payload,
      callData: `0x${CALL.slice(2).toUpperCase()}`,
      context: { ...payload.context, genesisHash: `0x${'AB'.repeat(32)}` },
    };

    // When papi asks the creator for a transaction with uppercase hex
    await creator(upper, {}, BINDINGS, false);

    // Then the core was asked with the same bytes in lowercase hex
    expect(core.requests.map(request => [request.callData, request.genesisHash])).toEqual([
      [CALL, `0x${'ab'.repeat(32)}`],
    ]);
  });

  it('As a user, I see the transaction fail before the core is asked when papi passes hex that is not hex', async () => {
    // Given a core that would build the transaction
    const core = fakeCore([{ ok: TRANSACTION }]);
    const creator = createSiteTxSigner({ acquire: core.acquire, timers: manualTimers() }).creator(MAIN_KEY);

    // When papi asks the creator for a transaction whose call data is not hex
    const error: unknown = await creator({ ...txPayload(null), callData: '0xzz' }, {}, BINDINGS, false).catch(
      (caught: unknown) => caught,
    );

    // Then it rejects as failed before any core lease or request
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'failed' });
    expect(core.acquire).not.toHaveBeenCalled();
    expect(core.requests).toEqual([]);
  });

  it('As a user whose core still restores its session, I get the transaction once the core accepts the request', async () => {
    // Given a core that denies permission on the first request
    const core = fakeCore([DENIED_PERMISSION, { ok: TRANSACTION }]);
    const timers = manualTimers();
    const creator = createSiteTxSigner({ acquire: core.acquire, timers }).creator(MAIN_KEY);
    const building = creator(txPayload(null), {}, BINDINGS, false);
    await core.changes.until(() => core.requests.length === 1);

    // When the pool's first retry delay passes
    await timers.advance(500);

    // Then the request was made again and the transaction built, over the one connection
    await expect(building).resolves.toBe(TRANSACTION);
    expect(core.requests).toHaveLength(2);
    expect(core.lease.connect).toHaveBeenCalledTimes(1);
  });

  it('As a user whose core never restores its session, I see the transaction fail', async () => {
    // Given a core that always denies permission
    const core = fakeCore(Array.from({ length: 7 }, () => DENIED_PERMISSION));
    const timers = manualTimers();
    const creator = createSiteTxSigner({ acquire: core.acquire, timers }).creator(MAIN_KEY);
    const building = creator(txPayload(null), {}, BINDINGS, false).catch((caught: unknown) => caught);
    await core.changes.until(() => core.requests.length === 1);

    // When every retry delay passes, 500 ms doubling six times
    await timers.advance(31_500);

    // Then the first try and six retries were made over the one connection, and the transaction failed with the core's
    // answer
    const error = await building;
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'failed', cause: versioned(DENIED_PERMISSION.error) });
    expect(core.requests).toHaveLength(7);
    expect(core.lease.connect).toHaveBeenCalledTimes(1);
  });

  it('As a user whose core cannot build the transaction, I see it fail', async () => {
    // Given a core that answers with an unknown error
    const core = fakeCore([{ error: { tag: 'Domain', value: { tag: 'Unknown', value: { reason: 'no metadata' } } } }]);
    const creator = createSiteTxSigner({ acquire: core.acquire, timers: manualTimers() }).creator(MAIN_KEY);

    // When papi asks the creator for a transaction
    const error: unknown = await creator(txPayload(null), {}, BINDINGS, false).catch((caught: unknown) => caught);

    // Then it rejects as failed, with the core's error as its cause
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'failed', cause: { tag: 'Domain' } });
  });

  it('As a user, I am never asked to sign for a fee estimate', async () => {
    // Given a core that would build the transaction
    const core = fakeCore([{ ok: TRANSACTION }]);
    const creator = createSiteTxSigner({ acquire: core.acquire, timers: manualTimers() }).creator(MAIN_KEY);

    // When papi asks the creator for a transaction with a mocked signature
    const error: unknown = await creator(txPayload(null), {}, BINDINGS, true).catch((caught: unknown) => caught);

    // Then it rejects as failed before any core lease or request
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'failed' });
    expect(core.acquire).not.toHaveBeenCalled();
    expect(core.requests).toEqual([]);
  });

  it('As a user, I see the transaction fail when the core refuses a connection', async () => {
    // Given a core that refuses the connection
    const core = fakeCore([]);
    const refused = new Error('refused');
    core.lease.connect.mockRejectedValueOnce(refused);
    const creator = createSiteTxSigner({ acquire: core.acquire, timers: manualTimers() }).creator(MAIN_KEY);

    // When papi asks the creator for a transaction
    const error: unknown = await creator(txPayload(null), {}, BINDINGS, false).catch((caught: unknown) => caught);

    // Then it rejects as failed with the refusal as its cause
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'failed', cause: refused });
  });
});
