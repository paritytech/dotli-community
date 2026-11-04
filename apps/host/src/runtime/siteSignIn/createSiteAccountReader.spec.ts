// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  decodeWireMessage,
  scale,
  VersionedHostAccountGetError,
  VersionedHostAccountGetRequest,
  VersionedHostAccountGetResponse,
  type CallErrorValue,
  type HostAccountGetError,
  type HostAccountGetRequest,
  type ProductAccountId,
  asProductId,
} from '@parity/truapi';
import { ACCOUNT_GET_ACCOUNT } from '@parity/truapi/wire-table';
import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import { fromHex, toHex } from '@dotli/shared';
import { must } from '@dotli/shared/testing';
import { createFakeProvider } from '../createPageCore.fake.js';
import { createSiteAccountReader, SiteAccountReadError, SiteAccountRejectedError } from './createSiteAccountReader.js';
import { encodeResponseFrame } from '../../testing/encodeResponseFrame.js';
import { toVersionedError } from '../../testing/toVersionedError.js';
import { createFakeCoreLease } from './withCoreCalls.fake.js';

type AccountAnswer = { ok: Uint8Array } | { error: CallErrorValue<HostAccountGetError> };

/** The account the site names, of a product other than the core's own. */
const ACCOUNT: ProductAccountId = {
  dotNsIdentifier: asProductId(`myapp.${NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].dotns.TLD}`),
  derivationIndex: { tag: 'Index', value: 3 },
};
const SITE_KEY = fromHex('0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d');

function encodeAccountResponse(answer: AccountAnswer): Uint8Array {
  const codec = scale.Result(VersionedHostAccountGetResponse, scale.CallError(VersionedHostAccountGetError));
  return codec.enc(
    'ok' in answer
      ? { success: true, value: { tag: 'V1', value: { account: { publicKey: toHex(answer.ok) } } } }
      : { success: false, value: toVersionedError(answer.error) },
  );
}

/** One core that answers each call with the next queued answer for its method, and records what it was asked. */
function createFakeCore(answers: { account?: AccountAnswer[] }) {
  const order: string[] = [];
  const accountRequests: HostAccountGetRequest[] = [];
  const provider = createFakeProvider({
    onPostMessage(message) {
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
          provider.listener?.(
            encodeResponseFrame({ requestId, method: ACCOUNT_GET_ACCOUNT, value: encodeAccountResponse(answer) }),
          );
        });
      }
    },
  });
  return { ...createFakeCoreLease({ provider }), order, accountRequests };
}

describe('site account', () => {
  it('As a user, I hand a round the key of the account the site named and nothing is signed', async () => {
    // Given a core that knows the named account
    const core = createFakeCore({ account: [{ ok: SITE_KEY }] });
    const reader = createSiteAccountReader({ acquire: core.acquire });

    // When the account is read
    const key = await reader.account(ACCOUNT);

    // Then that account alone was read
    expect(key).toEqual(SITE_KEY);
    expect(core.order).toEqual(['getAccount']);
    expect(core.accountRequests).toEqual([{ productAccountId: ACCOUNT }]);
  });

  it('As a user, I reject the account on my phone and see the account read rejected', async () => {
    // Given a core whose user rejects the account request
    const core = createFakeCore({ account: [{ error: { tag: 'Domain', value: { tag: 'Rejected' } } }] });
    const reader = createSiteAccountReader({ acquire: core.acquire });

    // When the account is read
    const reading = reader.account(ACCOUNT);

    // Then it rejects as rejected
    await expect(reading).rejects.toBeInstanceOf(SiteAccountRejectedError);
  });

  it('As a user whose core answers an account key of the wrong length, I hand a round the account and see the read fail', async () => {
    // Given a core that answers the account with a 31-byte key
    const core = createFakeCore({ account: [{ ok: new Uint8Array(31) }] });
    const reader = createSiteAccountReader({ acquire: core.acquire });

    // When the account is read
    const error: unknown = await reader.account(ACCOUNT).catch((caught: unknown) => caught);

    // Then it fails as an account read
    expect(error).toBeInstanceOf(SiteAccountReadError);
  });
});
