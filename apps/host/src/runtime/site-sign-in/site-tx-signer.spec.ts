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
  VersionedHostCreateTransactionError,
  VersionedHostCreateTransactionRequest,
  VersionedHostCreateTransactionResponse,
  type CallErrorValue,
  type HostCreateTransactionError,
  type ProductAccountId,
  type ProductAccountTxPayload,
} from '@parity/truapi';
import { SIGNING_CREATE_TRANSACTION as CREATE } from '@parity/truapi/wire-table';
import { must } from '@dotli/shared/testing';
import { makeProvider } from '../page-core.fake.js';
import { createSiteTxSigner, SiteTxError } from './site-tx-signer.js';

const ACCOUNT: ProductAccountId = { dotNsIdentifier: 'myapp.dot', derivationIndex: { tag: 'Index', value: 0 } };
const RAW_ACCOUNT: ProductAccountId = {
  dotNsIdentifier: 'myapp.dot',
  derivationIndex: { tag: 'Raw', value: `0x${'7'.repeat(64)}` },
};
const GENESIS = `0x${'11'.repeat(32)}`;
const CALL = '0x0a0300d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d0f0000c16ff28623';
/** Every extension filled, as papi's fillers hand them to the creator. */
const EXTENSIONS = [
  { id: 'CheckNonce', extra: '0x04', additionalSigned: '0x' },
  { id: 'CheckMortality', extra: '0x00', additionalSigned: `0x${'22'.repeat(32)}` },
  { id: 'CheckGenesis', extra: '0x', additionalSigned: GENESIS },
  { id: 'ChargeTransactionPayment', extra: '0x00', additionalSigned: '0x' },
];
const TRANSACTION = `0x${'cd'.repeat(120)}` as const;

type CreateRefusal = {
  error: CallErrorValue<HostCreateTransactionError>;
};
type CreateAnswer = { ok: `0x${string}` } | CreateRefusal;

/** The payload papi hands a creator once its fillers filled every extension. */
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
    VersionedHostCreateTransactionResponse,
    scale.CallError(VersionedHostCreateTransactionError),
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
  const requests: ProductAccountTxPayload[] = [];
  const provider = makeProvider({
    onPostMessage: message => {
      const decoded = decodeWireMessage(message);
      if (decoded.isErr()) {
        throw decoded.error;
      }
      const { requestId, payload } = decoded.value;
      if (payload.traitId === CREATE.trait && payload.methodId === CREATE.method) {
        requests.push(VersionedHostCreateTransactionRequest.dec(payload.value).value);
        const answer = must(answers.shift(), 'a transaction answer');
        queueMicrotask(() => {
          provider.listener?.(responseFrame(requestId, answer));
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
  return { acquire, lease, connection, requests };
}

describe('site transaction signer', () => {
  const named = [
    { kind: 'an account index', account: ACCOUNT, txExtVersion: null, asked: 0 },
    { kind: 'a raw derivation', account: RAW_ACCOUNT, txExtVersion: 1, asked: 1 },
  ];

  it.each(named)(
    'As a site, I name my account and my transaction is signed by exactly that account ($kind)',
    async ({ account, txExtVersion, asked }) => {
      // Given a core that signs the transaction
      const core = fakeCore([{ ok: TRANSACTION }]);
      const creator = createSiteTxSigner({ acquire: core.acquire }).creator(account);

      // When papi asks the creator for a transaction with every extension filled
      const transaction = await creator(txPayload(txExtVersion), {}, BINDINGS, false);

      // Then the core was asked once for the call on the genesis, signed by the named account, with the extensions as
      // given, and the creator resolved with the signed transaction
      expect(transaction).toBe(TRANSACTION);
      expect(core.requests).toEqual([
        {
          signer: account,
          genesisHash: GENESIS,
          callData: CALL,
          extensions: EXTENSIONS,
          txExtVersion: asked,
          contacts: [],
        },
      ]);
    },
  );

  const rejections: { path: string; answer: CreateRefusal }[] = [
    { path: 'Rejected', answer: { error: { tag: 'Domain', value: { tag: 'Rejected' } } } },
    { path: 'Cancelled', answer: { error: { tag: 'Cancelled' } } },
  ];

  it.each(rejections)(
    'As a user, I reject the transaction on the phone and the window reports a rejection ($path)',
    async ({ answer }) => {
      // Given a core whose transaction request ends this way
      const core = fakeCore([answer]);
      const creator = createSiteTxSigner({ acquire: core.acquire }).creator(ACCOUNT);

      // When papi asks the creator for a transaction
      const error: unknown = await creator(txPayload(null), {}, BINDINGS, false).catch((caught: unknown) => caught);

      // Then it rejects as rejected, with the core's error as its cause
      expect(error).toBeInstanceOf(SiteTxError);
      expect(error).toMatchObject({ kind: 'rejected', cause: versioned(answer.error) });
    },
  );

  const refusals: { path: string; answer: CreateRefusal }[] = [
    {
      path: 'NotSupported',
      answer: { error: { tag: 'Domain', value: { tag: 'NotSupported', value: { reason: 'extension' } } } },
    },
    { path: 'PermissionDenied', answer: { error: { tag: 'Domain', value: { tag: 'PermissionDenied' } } } },
    { path: 'Unsupported', answer: { error: { tag: 'Unsupported' } } },
  ];

  it.each(refusals)(
    'As a site, I ask for a transaction the wallet cannot sign and the window calls it invalid ($path)',
    async ({ answer }) => {
      // Given a core that does not support or allow the transaction
      const core = fakeCore([answer]);
      const creator = createSiteTxSigner({ acquire: core.acquire }).creator(ACCOUNT);

      // When papi asks the creator for a transaction
      const error: unknown = await creator(txPayload(null), {}, BINDINGS, false).catch((caught: unknown) => caught);

      // Then it rejects as unsupported, with the core's error as its cause, after the one request
      expect(error).toBeInstanceOf(SiteTxError);
      expect(error).toMatchObject({ kind: 'unsupported', cause: versioned(answer.error) });
      expect(core.requests).toHaveLength(1);
    },
  );

  it('As the window, I am told right before the core is asked to sign, so the user is asked to approve only then', async () => {
    // Given a core that signs the transaction, and a creator that notes how many requests the core had when it tells
    const core = fakeCore([{ ok: TRANSACTION }]);
    const askedAt: number[] = [];
    const creator = createSiteTxSigner({ acquire: core.acquire }).creator(ACCOUNT, () => {
      askedAt.push(core.requests.length);
    });

    // When papi asks the creator for a transaction
    const transaction = await creator(txPayload(null), {}, BINDINGS, false);

    // Then the window was told once, after the core connected and before its one request
    expect(transaction).toBe(TRANSACTION);
    expect(askedAt).toEqual([0]);
    expect(core.lease.connect).toHaveBeenCalledTimes(1);
    expect(core.requests).toHaveLength(1);
  });

  it('As the window, I ask for a fee estimate and no transaction is built', async () => {
    // Given a core that would sign the transaction
    const core = fakeCore([{ ok: TRANSACTION }]);
    const asks: string[] = [];
    const creator = createSiteTxSigner({ acquire: core.acquire }).creator(ACCOUNT, () => {
      asks.push('ask');
    });

    // When papi asks the creator for a transaction with a mocked signature
    const error: unknown = await creator(txPayload(null), {}, BINDINGS, true).catch((caught: unknown) => caught);

    // Then it rejects as failed before any core lease or request, and the window was never told the core is asked
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'failed' });
    expect(core.acquire).not.toHaveBeenCalled();
    expect(core.requests).toEqual([]);
    expect(asks).toEqual([]);
  });

  it('As a site, I have my transaction signed from the hex papi passes, in lowercase', async () => {
    // Given a core that signs the transaction
    const core = fakeCore([{ ok: TRANSACTION }]);
    const creator = createSiteTxSigner({ acquire: core.acquire }).creator(ACCOUNT);
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

  it('As a site, I see the transaction fail before the core is asked when papi passes hex that is not hex', async () => {
    // Given a core that would sign the transaction
    const core = fakeCore([{ ok: TRANSACTION }]);
    const creator = createSiteTxSigner({ acquire: core.acquire }).creator(ACCOUNT);

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

  it('As a site, I see the transaction fail when the core cannot sign it', async () => {
    // Given a core that answers with an unknown error
    const core = fakeCore([{ error: { tag: 'Domain', value: { tag: 'Unknown', value: { reason: 'no metadata' } } } }]);
    const creator = createSiteTxSigner({ acquire: core.acquire }).creator(ACCOUNT);

    // When papi asks the creator for a transaction
    const error: unknown = await creator(txPayload(null), {}, BINDINGS, false).catch((caught: unknown) => caught);

    // Then it rejects as failed, with the core's error as its cause
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'failed', cause: { tag: 'Domain' } });
  });

  it('As a site, I see the transaction fail when the core refuses a connection', async () => {
    // Given a core that refuses the connection
    const core = fakeCore([]);
    const refused = new Error('refused');
    core.lease.connect.mockRejectedValueOnce(refused);
    const creator = createSiteTxSigner({ acquire: core.acquire }).creator(ACCOUNT);

    // When papi asks the creator for a transaction
    const error: unknown = await creator(txPayload(null), {}, BINDINGS, false).catch((caught: unknown) => caught);

    // Then it rejects as failed with the refusal as its cause
    expect(error).toBeInstanceOf(SiteTxError);
    expect(error).toMatchObject({ kind: 'failed', cause: refused });
  });
});
