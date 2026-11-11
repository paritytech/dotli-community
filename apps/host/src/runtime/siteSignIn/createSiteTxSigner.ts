// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Signs a site's transaction on the page core as the product account the site names, which the phone approves.
 * papi's fillers fill every extension first, so the core only signs. Each signing runs over one connection to the core.
 */

import { SigningClient, type ProductAccountId, type ProductAccountTxPayload } from '@parity/truapi';
import type { TxCreator } from 'polkadot-api';
import { fromHex, toHex } from '@dotli/shared';
import { getSiteCallErrorKind, withCoreCalls, type CoreCallsParams, type SiteCallErrorKind } from './withCoreCalls.js';

/** Signs a site's transaction as the account the site names, over extensions already filled. */
export type SiteTxSigner = ReturnType<typeof createSiteTxSigner>;

/** What papi hands a creator to sign. */
type TxInput = Parameters<TxCreator>[0];

type CreatorParams = {
  /** Called right before the core is asked to sign. */
  onAsk?: (() => void) | undefined;
};

type SignTransactionParams = CreatorParams & {
  account: ProductAccountId;
  input: TxInput;
};

/** How long a signing may wait on the phone. */
const BUILD_TIMEOUT_MS = 300_000;

/** Makes a signer that opens one connection to the page core for each signing and closes it after. */
export function createSiteTxSigner({ acquire }: CoreCallsParams) {
  /** Has the core sign `input` as `account`. Rejects with {@link SiteTxError}. */
  async function signTransaction({ account, input, onAsk }: SignTransactionParams): Promise<string> {
    try {
      const request = createTxRequest(account, input);
      return await withCoreCalls({ acquire, requestTimeoutMs: BUILD_TIMEOUT_MS }, async ({ transport }) => {
        onAsk?.();
        const result = await new SigningClient(transport).createTransaction(request);
        if (result.isOk()) {
          return result.value.transaction;
        }
        throw new SiteTxError(getSiteCallErrorKind(result.error), result.error);
      });
    } catch (error) {
      if (error instanceof SiteTxError) {
        throw error;
      }
      throw new SiteTxError('failed', error);
    }
  }

  return {
    /**
     * A creator that signs as `account` the payload papi hands it with every extension filled. It calls `onAsk` right
     * before it asks the core to sign. It resolves with the signed transaction's hex and rejects with
     * {@link SiteTxError}, at once for a fee estimate.
     */
    creator(account: ProductAccountId, { onAsk }: CreatorParams = {}): TxCreator {
      // eslint-disable-next-line @typescript-eslint/max-params -- papi's `TxCreator` fixes this signature
      return (input, _options, _bindings, mockedSignature) =>
        // A fee estimate would ask the phone to sign, so none is built.
        mockedSignature
          ? Promise.reject(new SiteTxError('failed', new Error('A fee estimate is not built')))
          : signTransaction({ account, input, onAsk });
    },
  };
}

/**
 * A transaction that was not signed: the user rejected it, the wallet does not support or allow it, or the signing
 * failed.
 */
export class SiteTxError extends Error {
  override name = 'SiteTxError';
  readonly kind: SiteCallErrorKind;

  /** `error` is the TrUAPI error, or what else ended the signing. */
  constructor(kind: SiteCallErrorKind, error: unknown) {
    super(`The site's transaction was not signed: ${kind}`, { cause: error });
    this.kind = kind;
  }
}

/** The TrUAPI request for papi's payload, signed by `account`. A site's call names no contact. */
function createTxRequest(account: ProductAccountId, input: TxInput): ProductAccountTxPayload {
  return {
    signer: account,
    genesisHash: toCheckedHex(input.context.genesisHash),
    callData: toCheckedHex(input.callData),
    extensions: input.extensions.map(extension => ({
      id: extension.id,
      extra: toCheckedHex(extension.extra),
      additionalSigned: toCheckedHex(extension.additionalSigned),
    })),
    txExtVersion: input.txExtVersion ?? 0,
    contacts: [],
  };
}

/** papi's hex as TrUAPI types it, checked to be hex. */
function toCheckedHex(value: string): `0x${string}` {
  return toHex(fromHex(value));
}
