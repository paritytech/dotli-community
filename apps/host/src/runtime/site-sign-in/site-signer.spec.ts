// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedHostAccountGetError,
  VersionedHostAccountGetRequest,
  VersionedHostAccountGetResponse,
  VersionedHostSignRawError,
  VersionedHostSignRawRequest,
  VersionedHostSignRawResponse,
  type CallErrorValue,
  type HostAccountGetError,
  type HostAccountGetRequest,
  type HostSignPayloadError,
  type HostSignRawRequest,
  type ProductAccountId,
} from '@parity/truapi';
import { ACCOUNT_GET_ACCOUNT, SIGNING_SIGN_RAW } from '@parity/truapi/wire-table';
import { NETWORK_NAME_TO_SERVICES_CONFIG, NetworkName } from '@dotli/config';
import { fromHex, toHex } from '@dotli/shared';
import { must } from '@dotli/shared/testing';
import { makeProvider } from '../page-core.fake.js';
import { createSiteSigner, SiteSignError, SiteSignRejectedError } from './site-signer.js';

/** The account the site names, of a product other than the core's own. */
const ACCOUNT: ProductAccountId = {
  dotNsIdentifier: `myapp.${NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO].dotns.TLD}`,
  derivationIndex: { tag: 'Index', value: 3 },
};
const PRODUCT_ID = 'dotli-product';
const SITE_KEY = fromHex('0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d');
const SIGNATURE = `0x${'ab'.repeat(64)}` as const;

type AccountAnswer = { ok: Uint8Array } | { error: CallErrorValue<HostAccountGetError> };
type SignAnswer = { ok: `0x${string}` } | { error: CallErrorValue<HostSignPayloadError> };

/** The call error a core answers with, its domain error in the version 1 envelope. */
function versioned<E>(error: CallErrorValue<E>): CallErrorValue<{ tag: 'V1'; value: E }> {
  return error.tag === 'Domain' ? { tag: 'Domain', value: { tag: 'V1', value: error.value } } : error;
}

function responseFrame(requestId: string, ids: { trait: number; method: number }, value: Uint8Array): Uint8Array {
  const frame = encodeWireMessage({
    requestId,
    payload: { traitId: ids.trait, methodId: ids.method, messageType: MESSAGE_TYPE_RESPONSE, value },
  });
  if (frame.isErr()) {
    throw frame.error;
  }
  return frame.value;
}

function accountResponse(answer: AccountAnswer): Uint8Array {
  const codec = scale.Result(VersionedHostAccountGetResponse, scale.CallError(VersionedHostAccountGetError));
  return codec.enc(
    'ok' in answer
      ? { success: true, value: { tag: 'V1', value: { account: { publicKey: toHex(answer.ok) } } } }
      : { success: false, value: versioned(answer.error) },
  );
}

function signResponse(answer: SignAnswer): Uint8Array {
  const codec = scale.Result(VersionedHostSignRawResponse, scale.CallError(VersionedHostSignRawError));
  return codec.enc(
    'ok' in answer
      ? { success: true, value: { tag: 'V1', value: { signature: answer.ok } } }
      : { success: false, value: versioned(answer.error) },
  );
}

/** One core that answers each call with the next queued answer for its method, and records what it was asked. */
function fakeCore(answers: { account?: AccountAnswer[]; sign?: SignAnswer[] }) {
  const order: string[] = [];
  const accountRequests: HostAccountGetRequest[] = [];
  const signRequests: HostSignRawRequest[] = [];
  const provider = makeProvider({
    onPostMessage: message => {
      const decoded = decodeWireMessage(message);
      if (decoded.isErr()) {
        throw decoded.error;
      }
      const { requestId, payload } = decoded.value;
      if (payload.traitId === ACCOUNT_GET_ACCOUNT.trait && payload.methodId === ACCOUNT_GET_ACCOUNT.method) {
        accountRequests.push(VersionedHostAccountGetRequest.dec(payload.value).value);
        order.push('getAccount');
        const answer = must(answers.account?.shift(), 'a getAccount answer');
        queueMicrotask(() => {
          provider.listener?.(responseFrame(requestId, ACCOUNT_GET_ACCOUNT, accountResponse(answer)));
        });
      } else if (payload.traitId === SIGNING_SIGN_RAW.trait && payload.methodId === SIGNING_SIGN_RAW.method) {
        signRequests.push(VersionedHostSignRawRequest.dec(payload.value).value);
        order.push('signRaw');
        const answer = must(answers.sign?.shift(), 'a signRaw answer');
        queueMicrotask(() => {
          provider.listener?.(responseFrame(requestId, SIGNING_SIGN_RAW, signResponse(answer)));
        });
      }
    },
  });
  const connection = {
    provider: provider as unknown as TrUApiProductProvider,
    productId: PRODUCT_ID,
    close: vi.fn(),
  };
  const lease = { connect: vi.fn(() => Promise.resolve(connection)), release: vi.fn() };
  const acquire = vi.fn(() => Promise.resolve(lease));
  const text = vi.fn((publicKey: Uint8Array) => {
    order.push('text');
    return `sign in as ${toHex(publicKey)}`;
  });
  return { acquire, lease, connection, order, accountRequests, signRequests, text };
}

const REJECTED_SIGN: SignAnswer = { error: { tag: 'Domain', value: { tag: 'Rejected' } } };

describe('site signer', () => {
  it('As a site, I name my account and the window signs with exactly that account', async () => {
    // Given a core that knows the named account and signs
    const core = fakeCore({ account: [{ ok: SITE_KEY }], sign: [{ ok: SIGNATURE }] });
    const signer = createSiteSigner({ acquire: core.acquire });

    // When the site's assertion is signed with the account the site named
    const signed = await signer.sign(ACCOUNT, core.text);

    // Then the account was read and signed with as named, the text built from its key and signed as a message
    expect(signed).toEqual({ publicKey: SITE_KEY, signature: SIGNATURE });
    expect(core.order).toEqual(['getAccount', 'text', 'signRaw']);
    expect(core.accountRequests).toEqual([{ productAccountId: ACCOUNT }]);
    expect(core.text).toHaveBeenCalledWith(SITE_KEY);
    expect(core.signRequests).toEqual([
      { account: ACCOUNT, payload: { tag: 'Payload', value: { payload: `sign in as ${toHex(SITE_KEY)}` } } },
    ]);
  });

  it('As a user who rejects the account on my phone, I see the sign-in rejected', async () => {
    // Given a core whose user rejects the account request
    const core = fakeCore({ account: [{ error: { tag: 'Domain', value: { tag: 'Rejected' } } }] });
    const signer = createSiteSigner({ acquire: core.acquire });

    // When the site's assertion is signed
    const signing = signer.sign(ACCOUNT, core.text);

    // Then it rejects as rejected and nothing was signed
    await expect(signing).rejects.toBeInstanceOf(SiteSignRejectedError);
    expect(core.order).toEqual(['getAccount']);
  });

  it('As a user, I reject the signature on the phone and the window reports a rejection', async () => {
    // Given a core whose user rejects the signing request
    const core = fakeCore({ account: [{ ok: SITE_KEY }], sign: [REJECTED_SIGN] });
    const signer = createSiteSigner({ acquire: core.acquire });

    // When the site's assertion is signed
    const error: unknown = await signer.sign(ACCOUNT, core.text).catch((caught: unknown) => caught);

    // Then it rejects as rejected at the signing step, with the core's error as its cause
    expect(error).toBeInstanceOf(SiteSignRejectedError);
    expect(error).toMatchObject({ step: 'sign', cause: { tag: 'Domain' } });
  });

  it('As a user who withdraws the signing request, I see the sign-in rejected', async () => {
    // Given a core whose signing request is cancelled
    const core = fakeCore({ account: [{ ok: SITE_KEY }], sign: [{ error: { tag: 'Cancelled' } }] });
    const signer = createSiteSigner({ acquire: core.acquire });

    // When the site's assertion is signed
    const signing = signer.sign(ACCOUNT, core.text);

    // Then it rejects as rejected
    await expect(signing).rejects.toBeInstanceOf(SiteSignRejectedError);
  });

  it('As a user whose core denies the signing call, I see the sign-in fail at signing', async () => {
    // Given a core that denies the signing call
    const core = fakeCore({ account: [{ ok: SITE_KEY }], sign: [{ error: { tag: 'Denied' } }] });
    const signer = createSiteSigner({ acquire: core.acquire });

    // When the site's assertion is signed
    const error: unknown = await signer.sign(ACCOUNT, core.text).catch((caught: unknown) => caught);

    // Then it fails at the signing step, with the core's error as its cause
    expect(error).toBeInstanceOf(SiteSignError);
    expect(error).not.toBeInstanceOf(SiteSignRejectedError);
    expect(error).toMatchObject({ step: 'sign', cause: { tag: 'Denied' } });
  });

  it('As a site, I name an account the core refuses and the window reports a failure', async () => {
    // Given a core that refuses to sign with the named account
    const denied: SignAnswer = { error: { tag: 'Domain', value: { tag: 'PermissionDenied' } } };
    const core = fakeCore({ account: [{ ok: SITE_KEY }], sign: [denied, { ok: SIGNATURE }] });
    const signer = createSiteSigner({ acquire: core.acquire });

    // When the site's assertion is signed
    const error: unknown = await signer.sign(ACCOUNT, core.text).catch((caught: unknown) => caught);

    // Then it fails at the signing step with the core's refusal as its cause, after one signing request
    expect(error).toBeInstanceOf(SiteSignError);
    expect(error).not.toBeInstanceOf(SiteSignRejectedError);
    expect(error).toMatchObject({ step: 'sign', cause: { tag: 'Domain' } });
    expect(core.signRequests).toHaveLength(1);
  });

  it('As a user whose core answers an account key of the wrong length, I see the sign-in fail at the account read', async () => {
    // Given a core that answers the account with a 31-byte key
    const core = fakeCore({ account: [{ ok: new Uint8Array(31) }] });
    const signer = createSiteSigner({ acquire: core.acquire });

    // When the site's assertion is signed
    const error: unknown = await signer.sign(ACCOUNT, core.text).catch((caught: unknown) => caught);

    // Then it fails at the account step, and no text was built or signed
    expect(error).toBeInstanceOf(SiteSignError);
    expect(error).toMatchObject({ step: 'account' });
    expect(core.order).toEqual(['getAccount']);
  });
});

describe('site account', () => {
  it('As a user, I hand a round the key of the account the site named, with nothing signed', async () => {
    // Given a core that knows the named account
    const core = fakeCore({ account: [{ ok: SITE_KEY }] });
    const signer = createSiteSigner({ acquire: core.acquire });

    // When the account is read
    const key = await signer.account(ACCOUNT);

    // Then that account alone was read
    expect(key).toEqual(SITE_KEY);
    expect(core.order).toEqual(['getAccount']);
    expect(core.accountRequests).toEqual([{ productAccountId: ACCOUNT }]);
  });

  it('As a user who rejects the account on my phone, I see the account read rejected', async () => {
    // Given a core whose user rejects the account request
    const core = fakeCore({ account: [{ error: { tag: 'Domain', value: { tag: 'Rejected' } } }] });
    const signer = createSiteSigner({ acquire: core.acquire });

    // When the account is read
    const reading = signer.account(ACCOUNT);

    // Then it rejects as rejected
    await expect(reading).rejects.toBeInstanceOf(SiteSignRejectedError);
  });

  it('As a user whose core answers an account key of the wrong length, I see the account read fail', async () => {
    // Given a core that answers the account with a 31-byte key
    const core = fakeCore({ account: [{ ok: new Uint8Array(31) }] });
    const signer = createSiteSigner({ acquire: core.acquire });

    // When the account is read
    const error: unknown = await signer.account(ACCOUNT).catch((caught: unknown) => caught);

    // Then it fails at the account step
    expect(error).toBeInstanceOf(SiteSignError);
    expect(error).toMatchObject({ step: 'account' });
  });
});
