// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Reads the user's account for a site and signs a site's assertion with it, each over one connection to the page core. */

import { AccountClient, SigningClient, type ProductAccountId } from '@parity/truapi';
import type { ResultAsync } from 'neverthrow';
import { blake2b, fromHex, toHex, type AsyncTaskPool } from '@dotli/shared';
import { SITE_ASSERTION_LIFETIME_MS } from './site-assertion.js';
import { CoreRestoringError, withCoreCalls, type CoreCallsDeps, type SiteCallError } from './core-calls.js';

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
   * Signs `text` of the public key of the site account at derivation `index`, built anew for each signing attempt.
   * Without a known key the account is read first. Rejects with {@link SiteSignRejectedError} on a rejection,
   * {@link SiteSignError} on a failed call, and with the core's own error when no connection could be made.
   */
  sign(
    index: `0x${string}`,
    text: (publicKey: Uint8Array) => string,
    knownPublicKey: Uint8Array | null,
  ): Promise<{ publicKey: Uint8Array; signature: string }>;
  /**
   * The public key of the user's site account at derivation `index`. Rejects with {@link SiteSignRejectedError} on a
   * rejection, {@link SiteSignError} on a failed call or a key that is not 32 bytes, and with the core's own error when
   * no connection could be made.
   */
  account(index: `0x${string}`): Promise<Uint8Array>;
}

/** An sr25519 public key's length. */
const PUBLIC_KEY_BYTES = 32;

/** The site's account index, the same for one origin each time and distinct across origins. */
export function siteDerivationIndex(origin: string): `0x${string}` {
  return toHex(blake2b(new TextEncoder().encode(`dotli:s:site:${origin}`), 32));
}

/**
 * The account index of a site group, named by its registrable domain and its token. The same for one group each time,
 * and distinct across groups and from any site's own index.
 */
export function groupDerivationIndex(registrable: string, token: string): `0x${string}` {
  // A registrable domain holds no space, so the key splits one way.
  return toHex(blake2b(new TextEncoder().encode(`dotli:s:group:${registrable} ${token}`), 32));
}

/** The site account's public key the core answered, or the account step's failure for one that is not a key. */
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
 * Runs one call, again while it answers `restoring`. A rejection and any other answer or failure end it with the
 * matching error.
 */
async function siteCall<T>(
  step: SiteSignStep,
  restores: AsyncTaskPool,
  restoring: string,
  call: () => ResultAsync<T, SiteCallError>,
): Promise<T> {
  let value: T;
  try {
    value = await restores.call(async () => {
      const result = await call();
      if (result.isOk()) {
        return result.value;
      }
      if (domainTag(result.error) === restoring) {
        throw new CoreRestoringError(result.error);
      }
      throw result.error.tag === 'Cancelled' || domainTag(result.error) === 'Rejected'
        ? new SiteSignRejectedError(step, result.error)
        : new SiteSignError(step, result.error);
    });
  } catch (error) {
    if (error instanceof SiteSignRejectedError || error instanceof SiteSignError) {
      throw error;
    }
    throw new SiteSignError(step, error instanceof CoreRestoringError ? error.error : error);
  }
  return value;
}

/** What one call of the signer runs over: the core's clients for the site account, and its retry pool. */
interface SiteCalls {
  account: ProductAccountId;
  accounts: AccountClient;
  signing: SigningClient;
  restores: AsyncTaskPool;
}

/** Reads the site account's public key. */
async function readAccount(calls: SiteCalls): Promise<Uint8Array> {
  const read = await siteCall('account', calls.restores, 'NotConnected', () =>
    calls.accounts.getAccount({ productAccountId: calls.account }),
  );
  return accountKey(read.account.publicKey);
}

export function createSiteSigner(deps: CoreCallsDeps): SiteSigner {
  /** Runs `use` over one connection to the core for the site account at `index`, which it closes after. */
  const withCalls = <T>(index: `0x${string}`, use: (calls: SiteCalls) => Promise<T>): Promise<T> =>
    // Each request, an account read or a signature, may wait on the phone as long as a site assertion stays valid.
    withCoreCalls(deps, SITE_ASSERTION_LIFETIME_MS, ({ transport, productId, restores }) =>
      use({
        account: { dotNsIdentifier: productId, derivationIndex: { tag: 'Raw', value: index } },
        accounts: new AccountClient(transport),
        signing: new SigningClient(transport),
        restores,
      }),
    );

  return {
    sign: (index, text, knownPublicKey) =>
      withCalls(index, async calls => {
        const publicKey = knownPublicKey ?? (await readAccount(calls));
        // Built for each attempt, so an approval after retries signs a text issued with that attempt and still valid.
        const { signature } = await siteCall('sign', calls.restores, 'PermissionDenied', () =>
          calls.signing.signRaw({
            account: calls.account,
            payload: { tag: 'Payload', value: { payload: text(publicKey) } },
          }),
        );
        return { publicKey, signature };
      }),
    account: index => withCalls(index, readAccount),
  };
}
