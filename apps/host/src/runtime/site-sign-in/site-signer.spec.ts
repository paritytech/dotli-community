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
} from '@parity/truapi';
import { ACCOUNT_GET_ACCOUNT, SIGNING_SIGN_RAW } from '@parity/truapi/wire-table';
import { blake2b, fromHex, toHex } from '@dotli/shared';
import { manualTimers, must } from '@dotli/shared/testing';
import { makeProvider } from '../page-core.fake.js';
import { createChanges } from '../../testing/changes.js';
import {
  createSiteSigner,
  groupDerivationIndex,
  siteDerivationIndex,
  SiteSignError,
  SiteSignRejectedError,
} from './site-signer.js';

const ORIGIN = 'https://my-site.com';
const INDEX = siteDerivationIndex(ORIGIN);
const PRODUCT_ID = 'dotli-product';
const SITE_KEY = fromHex('0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d');
const KNOWN_KEY = fromHex('0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48');
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
  const changes = createChanges();
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
          changes.notify();
        });
      } else if (payload.traitId === SIGNING_SIGN_RAW.trait && payload.methodId === SIGNING_SIGN_RAW.method) {
        signRequests.push(VersionedHostSignRawRequest.dec(payload.value).value);
        order.push('signRaw');
        const answer = must(answers.sign?.shift(), 'a signRaw answer');
        queueMicrotask(() => {
          provider.listener?.(responseFrame(requestId, SIGNING_SIGN_RAW, signResponse(answer)));
          changes.notify();
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
  return { acquire, lease, connection, order, accountRequests, signRequests, text, changes };
}

const SITE_ACCOUNT = {
  dotNsIdentifier: PRODUCT_ID,
  derivationIndex: { tag: 'Raw', value: INDEX },
};

describe('site derivation index', () => {
  it('As a user, I get the same site account each time I sign in to one site', () => {
    // Given one site's origin
    const origin = ORIGIN;

    // When its derivation index is derived twice
    const first = siteDerivationIndex(origin);
    const second = siteDerivationIndex(origin);

    // Then both are the hash of the site's domain-separated origin
    expect(first).toBe(second);
    expect(first).toBe(toHex(blake2b(new TextEncoder().encode(`dotli:s:site:${origin}`), 32)));
  });

  it('As a user, I get a different account on each site', () => {
    // Given two sites that differ only in their port
    const origins = ['https://my-site.com', 'https://my-site.com:8443'];

    // When their derivation indexes are derived
    const [first, second] = origins.map(siteDerivationIndex);

    // Then they differ
    expect(first).not.toBe(second);
  });
});

describe('group derivation index', () => {
  it('As a user, I get the same group account each time I sign in to one group', () => {
    // Given one group's registrable domain and token
    const registrable = 'github.io';
    const token = 'my-group';

    // When its derivation index is derived twice
    const first = groupDerivationIndex(registrable, token);
    const second = groupDerivationIndex(registrable, token);

    // Then both are the hash of the domain-separated group key
    expect(first).toBe(second);
    expect(first).toBe(toHex(blake2b(new TextEncoder().encode('dotli:s:group:github.io my-group'), 32)));
  });

  it("As a user, I get a group account that is no site's own account", () => {
    // Given a group and the origins whose text it could be mistaken for
    const origins = ['https://github.io', 'github.io my-group', 'group:github.io my-group'];

    // When the group's derivation index and the sites' are derived
    const group = groupDerivationIndex('github.io', 'my-group');
    const sites = origins.map(siteDerivationIndex);

    // Then the group's differs from each site's
    for (const site of sites) {
      expect(group).not.toBe(site);
    }
  });

  it('As a user, I get a different account for each group key', () => {
    // Given groups that differ in their registrable domain or their token
    const groups: [string, string][] = [
      ['github.io', 'my-group'],
      ['gitlab.io', 'my-group'],
      ['github.io', 'other-group'],
    ];

    // When their derivation indexes are derived
    const indexes = groups.map(([registrable, token]) => groupDerivationIndex(registrable, token));

    // Then they all differ
    expect(new Set(indexes).size).toBe(groups.length);
  });
});

describe('site signer', () => {
  it('As a user signing in to a site for the first time, I sign the text built for my site account', async () => {
    // Given a core that knows the site account and signs
    const core = fakeCore({ account: [{ ok: SITE_KEY }], sign: [{ ok: SIGNATURE }] });
    const signer = createSiteSigner({ acquire: core.acquire, timers: manualTimers() });

    // When the site's assertion is signed without a known key
    const signed = await signer.sign(INDEX, core.text, null);

    // Then the account was read for the site, the text built from its key and the text signed as a message
    expect(signed).toEqual({ publicKey: SITE_KEY, signature: SIGNATURE });
    expect(core.order).toEqual(['getAccount', 'text', 'signRaw']);
    expect(core.accountRequests).toEqual([{ productAccountId: SITE_ACCOUNT }]);
    expect(core.text).toHaveBeenCalledWith(SITE_KEY);
    expect(core.signRequests).toEqual([
      { account: SITE_ACCOUNT, payload: { tag: 'Payload', value: { payload: `sign in as ${toHex(SITE_KEY)}` } } },
    ]);
  });

  it('As a user signing in to a site again, I sign without the account being read', async () => {
    // Given a core that signs and a site key known from before
    const core = fakeCore({ sign: [{ ok: SIGNATURE }] });
    const signer = createSiteSigner({ acquire: core.acquire, timers: manualTimers() });

    // When the site's assertion is signed with the known key
    const signed = await signer.sign(INDEX, core.text, KNOWN_KEY);

    // Then only the signature was asked for, over the text of the known key
    expect(signed).toEqual({ publicKey: KNOWN_KEY, signature: SIGNATURE });
    expect(core.order).toEqual(['text', 'signRaw']);
    expect(core.text).toHaveBeenCalledWith(KNOWN_KEY);
  });

  it('As a user who rejects the account on my phone, I see the sign-in rejected', async () => {
    // Given a core whose user rejects the account request
    const core = fakeCore({ account: [{ error: { tag: 'Domain', value: { tag: 'Rejected' } } }] });
    const signer = createSiteSigner({ acquire: core.acquire, timers: manualTimers() });

    // When the site's assertion is signed
    const signing = signer.sign(INDEX, core.text, null);

    // Then it rejects as rejected and nothing was signed
    await expect(signing).rejects.toBeInstanceOf(SiteSignRejectedError);
    expect(core.order).toEqual(['getAccount']);
  });

  it('As a user who withdraws the signing request, I see the sign-in rejected', async () => {
    // Given a core whose signing request is cancelled
    const core = fakeCore({ sign: [{ error: { tag: 'Cancelled' } }] });
    const signer = createSiteSigner({ acquire: core.acquire, timers: manualTimers() });

    // When the site's assertion is signed
    const signing = signer.sign(INDEX, core.text, KNOWN_KEY);

    // Then it rejects as rejected
    await expect(signing).rejects.toBeInstanceOf(SiteSignRejectedError);
  });

  it('As a user whose core denies the signing call, I see the sign-in fail at signing', async () => {
    // Given a core that denies the signing call
    const core = fakeCore({ sign: [{ error: { tag: 'Denied' } }] });
    const signer = createSiteSigner({ acquire: core.acquire, timers: manualTimers() });

    // When the site's assertion is signed
    const error: unknown = await signer.sign(INDEX, core.text, KNOWN_KEY).catch((caught: unknown) => caught);

    // Then it fails at the signing step, with the core's error as its cause
    expect(error).toBeInstanceOf(SiteSignError);
    expect(error).not.toBeInstanceOf(SiteSignRejectedError);
    expect(error).toMatchObject({ step: 'sign', cause: { tag: 'Denied' } });
  });

  it('As a user whose core still restores its session, I sign once it answers the account request', async () => {
    // Given a core that is not connected yet on the first account request
    const core = fakeCore({
      account: [{ error: { tag: 'Domain', value: { tag: 'NotConnected' } } }, { ok: SITE_KEY }],
      sign: [{ ok: SIGNATURE }],
    });
    const timers = manualTimers();
    const signer = createSiteSigner({ acquire: core.acquire, timers });
    const signing = signer.sign(INDEX, core.text, null);
    await core.changes.until(() => core.order.length === 1);

    // When the pool's first retry delay passes
    await timers.advance(500);

    // Then the account was asked again and the text signed
    await expect(signing).resolves.toEqual({ publicKey: SITE_KEY, signature: SIGNATURE });
    expect(core.order).toEqual(['getAccount', 'getAccount', 'text', 'signRaw']);
  });

  it('As a user whose core still restores its session, I sign a text issued with the signing request it accepts', async () => {
    // Given a core that denies permission on the first three signing requests, and a text that carries its issue time
    const denied: SignAnswer = { error: { tag: 'Domain', value: { tag: 'PermissionDenied' } } };
    const core = fakeCore({ sign: [denied, denied, denied, { ok: SIGNATURE }] });
    const timers = manualTimers();
    const text = (publicKey: Uint8Array): string => `sign in as ${toHex(publicKey)} at ${String(timers.now())}`;
    const signer = createSiteSigner({ acquire: core.acquire, timers });
    const signing = signer.sign(INDEX, text, KNOWN_KEY);
    await core.changes.until(() => core.order.includes('signRaw'));

    // When the retry delays pass, 500 ms doubling, and the fourth request is approved
    await timers.advance(3500);

    // Then each request signed a text built for it, and the approved one is issued with it, so its lifetime starts then
    await expect(signing).resolves.toEqual({ publicKey: KNOWN_KEY, signature: SIGNATURE });
    expect(core.signRequests.map(request => request.payload)).toEqual(
      [0, 500, 1500, 3500].map(at => ({
        tag: 'Payload',
        value: { payload: `sign in as ${toHex(KNOWN_KEY)} at ${String(at)}` },
      })),
    );
  });

  it('As a user whose core answers an account key of the wrong length, I see the sign-in fail at the account read', async () => {
    // Given a core that answers the account with a 31-byte key
    const core = fakeCore({ account: [{ ok: new Uint8Array(31) }] });
    const signer = createSiteSigner({ acquire: core.acquire, timers: manualTimers() });

    // When the site's assertion is signed without a known key
    const error: unknown = await signer.sign(INDEX, core.text, null).catch((caught: unknown) => caught);

    // Then it fails at the account step, and no text was built or signed
    expect(error).toBeInstanceOf(SiteSignError);
    expect(error).toMatchObject({ step: 'account' });
    expect(core.order).toEqual(['getAccount']);
  });

  it('As a user whose core never restores its session, I see the sign-in fail at the account read', async () => {
    // Given a core that is never connected
    const notConnected: AccountAnswer = { error: { tag: 'Domain', value: { tag: 'NotConnected' } } };
    const core = fakeCore({ account: Array.from({ length: 7 }, () => notConnected) });
    const timers = manualTimers();
    const signer = createSiteSigner({ acquire: core.acquire, timers });
    const signing = signer.sign(INDEX, core.text, null).catch((caught: unknown) => caught);
    await core.changes.until(() => core.order.length === 1);

    // When every retry delay passes, 500 ms doubling six times
    await timers.advance(31_500);

    // Then the first try and six retries were made and the sign-in failed at the account step
    const error = await signing;
    expect(error).toBeInstanceOf(SiteSignError);
    expect(error).toMatchObject({ step: 'account', cause: { tag: 'Domain' } });
    expect(core.order).toEqual(Array.from({ length: 7 }, () => 'getAccount'));
  });
});

describe('site account', () => {
  it("As a user, I hand a site's round the key of my account for that site, with nothing signed", async () => {
    // Given a core that knows the site account
    const core = fakeCore({ account: [{ ok: SITE_KEY }] });
    const signer = createSiteSigner({ acquire: core.acquire, timers: manualTimers() });

    // When the site account is read
    const key = await signer.account(INDEX);

    // Then the account was read for the site alone
    expect(key).toEqual(SITE_KEY);
    expect(core.order).toEqual(['getAccount']);
    expect(core.accountRequests).toEqual([{ productAccountId: SITE_ACCOUNT }]);
  });

  it('As a user whose core still restores its session, I get the site account once it answers', async () => {
    // Given a core that is not connected yet on the first account request
    const core = fakeCore({
      account: [{ error: { tag: 'Domain', value: { tag: 'NotConnected' } } }, { ok: SITE_KEY }],
    });
    const timers = manualTimers();
    const signer = createSiteSigner({ acquire: core.acquire, timers });
    const reading = signer.account(INDEX);
    await core.changes.until(() => core.order.length === 1);

    // When the pool's first retry delay passes
    await timers.advance(500);

    // Then the account was asked again and its key answered
    await expect(reading).resolves.toEqual(SITE_KEY);
    expect(core.order).toEqual(['getAccount', 'getAccount']);
  });

  it('As a user who rejects the account on my phone, I see the account read rejected', async () => {
    // Given a core whose user rejects the account request
    const core = fakeCore({ account: [{ error: { tag: 'Domain', value: { tag: 'Rejected' } } }] });
    const signer = createSiteSigner({ acquire: core.acquire, timers: manualTimers() });

    // When the site account is read
    const reading = signer.account(INDEX);

    // Then it rejects as rejected
    await expect(reading).rejects.toBeInstanceOf(SiteSignRejectedError);
  });

  it('As a user whose core answers an account key of the wrong length, I see the account read fail', async () => {
    // Given a core that answers the account with a 31-byte key
    const core = fakeCore({ account: [{ ok: new Uint8Array(31) }] });
    const signer = createSiteSigner({ acquire: core.acquire, timers: manualTimers() });

    // When the site account is read
    const error: unknown = await signer.account(INDEX).catch((caught: unknown) => caught);

    // Then it fails at the account step
    expect(error).toBeInstanceOf(SiteSignError);
    expect(error).toMatchObject({ step: 'account' });
  });
});
