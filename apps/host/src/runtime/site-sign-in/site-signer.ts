// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads the key of the product account a site names and signs a site's assertion with that account, each over one
 * connection to the page core.
 */

import { AccountClient, SigningClient, type ProductAccountId } from '@parity/truapi';
import type { Result, ResultAsync } from 'neverthrow';
import { fromHex } from '@dotli/shared';
import { SITE_ASSERTION_LIFETIME_MS } from './site-assertion.js';
import { withCoreCalls, type CoreCallsDeps, type SiteCallError } from './core-calls.js';

type SiteSignStep = 'account' | 'sign';

/** The user rejected the request on the phone, or it was withdrawn. */
export class SiteSignRejectedError extends Error {
  override name = 'SiteSignRejectedError';
  readonly step: SiteSignStep;

  constructor(step: SiteSignStep, error: SiteCallError) {
    super(`The site's ${step} request was rejected`, { cause: error });
    this.step = step;
  }
}

/** A site sign-in call that failed for any reason but a rejection. Its cause is the TrUAPI error. */
export class SiteSignError extends Error {
  override name = 'SiteSignError';
  readonly step: SiteSignStep;

  constructor(step: SiteSignStep, error: unknown) {
    super(`The site's ${step} request failed`, { cause: error });
    this.step = step;
  }
}

export interface SiteSigner {
  /**
   * Reads the public key of `account`, then signs `text` of that key with it. Rejects with
   * {@link SiteSignRejectedError} on a rejection, {@link SiteSignError} on a failed call or a key that is not 32 bytes,
   * and with the core's own error when no connection could be made.
   */
  sign(
    account: ProductAccountId,
    text: (publicKey: Uint8Array) => string,
  ): Promise<{ publicKey: Uint8Array; signature: string }>;
  /**
   * The public key of `account`. Rejects with {@link SiteSignRejectedError} on a rejection, {@link SiteSignError} on a
   * failed call or a key that is not 32 bytes, and with the core's own error when no connection could be made.
   */
  account(account: ProductAccountId): Promise<Uint8Array>;
}

/** An sr25519 public key's length. */
const PUBLIC_KEY_BYTES = 32;

/** The named account's public key the core answered, or the account step's failure for one that is not a key. */
function accountKey(publicKey: string): Uint8Array {
  let key: Uint8Array;
  try {
    key = fromHex(publicKey);
  } catch (error) {
    throw new SiteSignError('account', error);
  }
  if (key.length !== PUBLIC_KEY_BYTES) {
    throw new SiteSignError('account', new Error(`The account key has ${String(key.length)} bytes`));
  }
  return key;
}

function domainTag(error: SiteCallError): string | null {
  return error.tag === 'Domain' ? error.value.value.tag : null;
}

/**
 * Runs one call once. A rejection ends it with {@link SiteSignRejectedError}, and any other failure with
 * {@link SiteSignError}.
 */
async function siteCall<T>(step: SiteSignStep, call: () => ResultAsync<T, SiteCallError>): Promise<T> {
  let result: Result<T, SiteCallError>;
  try {
    result = await call();
  } catch (error) {
    throw new SiteSignError(step, error);
  }
  if (result.isOk()) {
    return result.value;
  }
  throw result.error.tag === 'Cancelled' || domainTag(result.error) === 'Rejected'
    ? new SiteSignRejectedError(step, result.error)
    : new SiteSignError(step, result.error);
}

/** What one call of the signer runs over: the account the site names and the core's clients. */
interface SiteCalls {
  account: ProductAccountId;
  accounts: AccountClient;
  signing: SigningClient;
}

/** Reads the named account's public key. */
async function readAccount(calls: SiteCalls): Promise<Uint8Array> {
  const read = await siteCall('account', () => calls.accounts.getAccount({ productAccountId: calls.account }));
  return accountKey(read.account.publicKey);
}

export function createSiteSigner(deps: CoreCallsDeps): SiteSigner {
  /** Runs `use` over one connection to the core for `account`, which it closes after. */
  const withCalls = <T>(account: ProductAccountId, use: (calls: SiteCalls) => Promise<T>): Promise<T> =>
    // Each request, an account read or a signature, may wait on the phone as long as a site assertion stays valid.
    withCoreCalls(deps, SITE_ASSERTION_LIFETIME_MS, ({ transport }) =>
      use({ account, accounts: new AccountClient(transport), signing: new SigningClient(transport) }),
    );

  return {
    sign: (account, text) =>
      withCalls(account, async calls => {
        const publicKey = await readAccount(calls);
        const { signature } = await siteCall('sign', () =>
          calls.signing.signRaw({
            account: calls.account,
            payload: { tag: 'Payload', value: { payload: text(publicKey) } },
          }),
        );
        return { publicKey, signature };
      }),
    account: account => withCalls(account, readAccount),
  };
}
