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
  type CallErrorValue,
  type HostAccountGetError,
  type HostAccountGetRequest,
  type ProductAccountId,
} from '@parity/truapi';
import { ACCOUNT_GET_ACCOUNT } from '@parity/truapi/wire-table';
import { NETWORK_NAME_TO_SERVICES_CONFIG, NetworkName } from '@dotli/config';
import { fromHex, toHex } from '@dotli/shared';
import { must } from '@dotli/shared/testing';
import { makeProvider } from '../page-core.fake.js';
import { createSiteAccountReader, SiteAccountReadError, SiteAccountRejectedError } from './site-account-reader.js';

/** The account the site names, of a product other than the core's own. */
const ACCOUNT: ProductAccountId = {
  dotNsIdentifier: `myapp.${NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO].dotns.TLD}`,
  derivationIndex: { tag: 'Index', value: 3 },
};
const PRODUCT_ID = 'dotli-product';
const SITE_KEY = fromHex('0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d');

type AccountAnswer = { ok: Uint8Array } | { error: CallErrorValue<HostAccountGetError> };

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

/** One core that answers each call with the next queued answer for its method, and records what it was asked. */
function fakeCore(answers: { account?: AccountAnswer[] }) {
  const order: string[] = [];
  const accountRequests: HostAccountGetRequest[] = [];
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
  return { acquire, lease, connection, order, accountRequests };
}

describe('site account', () => {
  it('As a user, I hand a round the key of the account the site named, with nothing signed', async () => {
    // Given a core that knows the named account
    const core = fakeCore({ account: [{ ok: SITE_KEY }] });
    const reader = createSiteAccountReader({ acquire: core.acquire });

    // When the account is read
    const key = await reader.account(ACCOUNT);

    // Then that account alone was read
    expect(key).toEqual(SITE_KEY);
    expect(core.order).toEqual(['getAccount']);
    expect(core.accountRequests).toEqual([{ productAccountId: ACCOUNT }]);
  });

  it('As a user who rejects the account on my phone, I see the account read rejected', async () => {
    // Given a core whose user rejects the account request
    const core = fakeCore({ account: [{ error: { tag: 'Domain', value: { tag: 'Rejected' } } }] });
    const reader = createSiteAccountReader({ acquire: core.acquire });

    // When the account is read
    const reading = reader.account(ACCOUNT);

    // Then it rejects as rejected
    await expect(reading).rejects.toBeInstanceOf(SiteAccountRejectedError);
  });

  it('As a user whose core answers an account key of the wrong length, I see the account read fail', async () => {
    // Given a core that answers the account with a 31-byte key
    const core = fakeCore({ account: [{ ok: new Uint8Array(31) }] });
    const reader = createSiteAccountReader({ acquire: core.acquire });

    // When the account is read
    const error: unknown = await reader.account(ACCOUNT).catch((caught: unknown) => caught);

    // Then it fails as an account read
    expect(error).toBeInstanceOf(SiteAccountReadError);
  });
});
