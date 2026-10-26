// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Signs a site's transaction on the page core as the product account the site names, which the phone approves.
 * papi's fillers fill every extension first, so the core only signs. Each signing runs over one connection to the core.
 */

import { SigningClient, type ProductAccountId, type ProductAccountTxPayload } from '@parity/truapi';
import type { TxCreator } from 'polkadot-api';
import { fromHex, toHex } from '@dotli/shared';
import { withCoreCalls, type CoreCallsDeps } from './core-calls.js';

/** How long a signing may wait on the phone. */
const BUILD_TIMEOUT_MS = 300_000;

type SiteTxErrorKind = 'rejected' | 'unsupported' | 'failed';

/**
 * A transaction that was not signed: the user rejected it, the wallet does not support or allow it, or the signing
 * failed.
 */
export class SiteTxError extends Error {
  override name = 'SiteTxError';
  readonly kind: SiteTxErrorKind;

  /** `error` is the TrUAPI error, or what else ended the signing. */
  constructor(kind: SiteTxErrorKind, error: unknown) {
    super(`The site's transaction was not signed: ${kind}`, { cause: error });
    this.kind = kind;
  }
}

/** Signs a site's transaction as the account the site names, over extensions already filled. */
export interface SiteTxSigner {
  /**
   * A creator that signs as `account` the payload papi hands it with every extension filled. It calls `onAsk` right
   * before it asks the core to sign. It resolves with the signed transaction's hex and rejects with
   * {@link SiteTxError}, at once for a fee estimate.
   */
  creator(account: ProductAccountId, onAsk?: () => void): TxCreator;
}

/** papi's hex as TrUAPI types it, checked to be hex. */
function hex(value: string): `0x${string}` {
  return toHex(fromHex(value));
}

/** The TrUAPI request for papi's payload, signed by `account`. A site's call names no contact. */
function txRequest(account: ProductAccountId, input: Parameters<TxCreator>[0]): ProductAccountTxPayload {
  return {
    signer: account,
    genesisHash: hex(input.context.genesisHash),
    callData: hex(input.callData),
    extensions: input.extensions.map(extension => ({
      id: extension.id,
      extra: hex(extension.extra),
      additionalSigned: hex(extension.additionalSigned),
    })),
    txExtVersion: input.txExtVersion ?? 0,
    contacts: [],
  };
}

export function createSiteTxSigner(deps: CoreCallsDeps): SiteTxSigner {
  const build = async (
    account: ProductAccountId,
    input: Parameters<TxCreator>[0],
    onAsk: (() => void) | undefined,
  ): Promise<string> => {
    try {
      const request = txRequest(account, input);
      return await withCoreCalls(deps, BUILD_TIMEOUT_MS, async ({ transport }) => {
        onAsk?.();
        const result = await new SigningClient(transport).createTransaction(request);
        if (result.isOk()) {
          return result.value.transaction;
        }
        const error = result.error;
        const tag = error.tag === 'Domain' ? error.value.value.tag : null;
        if (error.tag === 'Cancelled' || tag === 'Rejected') {
          throw new SiteTxError('rejected', error);
        }
        // A call the core does not serve at all, or one it does not allow, cannot be signed either.
        const unsupported = tag === 'NotSupported' || tag === 'PermissionDenied' || error.tag === 'Unsupported';
        throw new SiteTxError(unsupported ? 'unsupported' : 'failed', error);
      });
    } catch (error) {
      if (error instanceof SiteTxError) {
        throw error;
      }
      throw new SiteTxError('failed', error);
    }
  };

  return {
    creator: (account, onAsk) => (input, _options, _bindings, mockedSignature) =>
      // A fee estimate would ask the phone to sign, so none is built.
      mockedSignature
        ? Promise.reject(new SiteTxError('failed', new Error('A fee estimate is not built')))
        : build(account, input, onAsk),
  };
}
