// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads the key of the product account a site names, over one connection to the page core.
 */

import { AccountClient, type ProductAccountId } from '@parity/truapi';
import type { Result, ResultAsync } from 'neverthrow';
import { fromHex } from '@dotli/shared';
import { withCoreCalls, type CoreCallsDeps, type SiteCallError } from './core-calls.js';

/** The user rejected the request on the phone, or it was withdrawn. */
export class SiteSignRejectedError extends Error {
  override name = 'SiteSignRejectedError';

  constructor(error: SiteCallError) {
    super("The site's account request was rejected", { cause: error });
  }
}

/** A site sign-in call that failed for any reason but a rejection. Its cause is the TrUAPI error. */
export class SiteSignError extends Error {
  override name = 'SiteSignError';

  constructor(error: unknown) {
    super("The site's account request failed", { cause: error });
  }
}

export interface SiteSigner {
  /**
   * The public key of `account`. Rejects with {@link SiteSignRejectedError} on a rejection, {@link SiteSignError} on a
   * failed call or a key that is not 32 bytes, and with the core's own error when no connection could be made.
   */
  account(account: ProductAccountId): Promise<Uint8Array>;
}

/** Bounds how long the account read may wait on the phone. */
const PHONE_WAIT_MS = 5 * 60 * 1000;

/** An sr25519 public key's length. */
const PUBLIC_KEY_BYTES = 32;

/** The named account's public key the core answered, or the account step's failure for one that is not a key. */
function accountKey(publicKey: string): Uint8Array {
  let key: Uint8Array;
  try {
    key = fromHex(publicKey);
  } catch (error) {
    throw new SiteSignError(error);
  }
  if (key.length !== PUBLIC_KEY_BYTES) {
    throw new SiteSignError(new Error(`The account key has ${String(key.length)} bytes`));
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
async function siteCall<T>(call: () => ResultAsync<T, SiteCallError>): Promise<T> {
  let result: Result<T, SiteCallError>;
  try {
    result = await call();
  } catch (error) {
    throw new SiteSignError(error);
  }
  if (result.isOk()) {
    return result.value;
  }
  throw result.error.tag === 'Cancelled' || domainTag(result.error) === 'Rejected'
    ? new SiteSignRejectedError(result.error)
    : new SiteSignError(result.error);
}

/** What one call of the signer runs over: the account the site names and the core's clients. */
interface SiteCalls {
  account: ProductAccountId;
  accounts: AccountClient;
}

/** Reads the named account's public key. */
async function readAccount(calls: SiteCalls): Promise<Uint8Array> {
  const read = await siteCall(() => calls.accounts.getAccount({ productAccountId: calls.account }));
  return accountKey(read.account.publicKey);
}

export function createSiteSigner(deps: CoreCallsDeps): SiteSigner {
  /** Runs `use` over one connection to the core for `account`, which it closes after. */
  const withCalls = <T>(account: ProductAccountId, use: (calls: SiteCalls) => Promise<T>): Promise<T> =>
    withCoreCalls(deps, PHONE_WAIT_MS, ({ transport }) => use({ account, accounts: new AccountClient(transport) }));

  return {
    account: account => withCalls(account, readAccount),
  };
}
