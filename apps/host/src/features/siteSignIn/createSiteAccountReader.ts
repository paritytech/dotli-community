// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads the key of the product account a site names, over one connection to the page core.
 */

import { AccountClient, type ProductAccountId } from '@parity/truapi';
import { fromHex } from '@dotli/shared';
import { getSiteCallErrorKind, withCoreCalls, type CoreCallsParams, type SiteCallError } from './withCoreCalls.js';

/** Reads the key of the product account a site names. It signs nothing. */
export type SiteAccountReader = ReturnType<typeof createSiteAccountReader>;

/** Bounds how long the account read may wait on the phone. */
const PHONE_WAIT_MS = 5 * 60 * 1000;

/** An sr25519 public key's length. */
const PUBLIC_KEY_BYTES = 32;

/** Makes a reader that opens one connection to the page core for each read and closes it after. */
export function createSiteAccountReader({ acquire }: CoreCallsParams) {
  return {
    /**
     * The public key of `account`. Rejects with {@link SiteAccountRejectedError} on a rejection,
     * {@link SiteAccountReadError} on a failed call or a key that is not 32 bytes, and with the core's own error when no
     * connection could be made.
     */
    account(account: ProductAccountId): Promise<Uint8Array> {
      return withCoreCalls({ acquire, requestTimeoutMs: PHONE_WAIT_MS }, ({ transport }) =>
        readAccount(account, new AccountClient(transport)),
      );
    },
  };
}

/** The user rejected the request on the phone, or it was withdrawn. */
export class SiteAccountRejectedError extends Error {
  override name = 'SiteAccountRejectedError';

  constructor(error: SiteCallError) {
    super("The site's account request was rejected", { cause: error });
  }
}

/** An account key read that failed for any reason but a rejection. Its cause is the TrUAPI error. */
export class SiteAccountReadError extends Error {
  override name = 'SiteAccountReadError';

  constructor(error: unknown) {
    super("The site's account request failed", { cause: error });
  }
}

/**
 * Reads the named account's public key. A rejection ends it with {@link SiteAccountRejectedError}, and any other failure
 * with {@link SiteAccountReadError}.
 */
async function readAccount(account: ProductAccountId, accounts: AccountClient): Promise<Uint8Array> {
  let result: Awaited<ReturnType<AccountClient['getAccount']>>;
  try {
    result = await accounts.getAccount({ productAccountId: account });
  } catch (error) {
    throw new SiteAccountReadError(error);
  }
  if (result.isErr()) {
    throw getSiteCallErrorKind(result.error) === 'rejected'
      ? new SiteAccountRejectedError(result.error)
      : new SiteAccountReadError(result.error);
  }
  return parseAccountKey(result.value.account.publicKey);
}

/** The named account's public key the core answered, or the account step's failure for one that is not a key. */
function parseAccountKey(publicKey: string): Uint8Array {
  let key: Uint8Array;
  try {
    key = fromHex(publicKey);
  } catch (error) {
    throw new SiteAccountReadError(error);
  }
  if (key.length !== PUBLIC_KEY_BYTES) {
    throw new SiteAccountReadError(new Error(`The account key has ${String(key.length)} bytes`));
  }
  return key;
}
