// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds a site's transaction for the user's main account on the page core, which the phone signs. Each build runs over
 * one connection to the core, and a core that still restores its session is asked again for a while.
 */

import { SigningClient, type LegacyAccountTxPayload } from '@parity/truapi';
import type { TxCreator } from 'polkadot-api';
import { fromHex, toHex } from '@dotli/shared';
import { CoreRestoringError, withCoreCalls, type CoreCallsDeps } from './core-calls.js';

/** How long a build may wait on the phone. */
const BUILD_TIMEOUT_MS = 300_000;

/** An sr25519 public key's length. */
const PUBLIC_KEY_BYTES = 32;

type SiteTxErrorKind = 'rejected' | 'unsupported' | 'failed';

/** A transaction that was not built: the user rejected it, the phone does not support it, or the build failed. */
export class SiteTxError extends Error {
  override name = 'SiteTxError';
  readonly kind: SiteTxErrorKind;

  /** `error` is the TrUAPI error, or what else ended the build. */
  constructor(kind: SiteTxErrorKind, error: unknown) {
    super(`The site's transaction was not built: ${kind}`, { cause: error });
    this.kind = kind;
  }
}

export interface SiteTxSigner {
  /**
   * A creator papi builds the transaction with, signed by the main account of `mainPublicKey`. It resolves with the
   * transaction's hex and rejects with {@link SiteTxError}, at once for a fee estimate.
   */
  creator(mainPublicKey: Uint8Array): TxCreator;
}

/** papi's hex as TrUAPI types it, checked to be hex. */
function hex(value: string): `0x${string}` {
  return toHex(fromHex(value));
}

/** The TrUAPI request for papi's payload, signed by the main account. Extensions papi leaves out stay out. */
function txRequest(mainPublicKey: Uint8Array, input: Parameters<TxCreator>[0]): LegacyAccountTxPayload {
  if (mainPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new SiteTxError('failed', new Error(`The main key has ${String(mainPublicKey.length)} bytes`));
  }
  return {
    signer: toHex(mainPublicKey),
    genesisHash: hex(input.context.genesisHash),
    callData: hex(input.callData),
    extensions: input.extensions.map(extension => ({
      id: extension.id,
      extra: hex(extension.extra),
      additionalSigned: hex(extension.additionalSigned),
    })),
    txExtVersion: input.txExtVersion ?? 0,
  };
}

export function createSiteTxSigner(deps: CoreCallsDeps): SiteTxSigner {
  const build = async (mainPublicKey: Uint8Array, input: Parameters<TxCreator>[0]): Promise<string> => {
    try {
      const request = txRequest(mainPublicKey, input);
      return await withCoreCalls(deps, BUILD_TIMEOUT_MS, ({ transport, restores }) => {
        const signing = new SigningClient(transport);
        return restores.call(async () => {
          const result = await signing.createTransactionWithLegacyAccount(request);
          if (result.isOk()) {
            return result.value.transaction;
          }
          const error = result.error;
          const tag = error.tag === 'Domain' ? error.value.value.tag : null;
          if (tag === 'PermissionDenied') {
            throw new CoreRestoringError(error);
          }
          if (error.tag === 'Cancelled' || tag === 'Rejected') {
            throw new SiteTxError('rejected', error);
          }
          // A call the core does not serve at all cannot be built either.
          const unsupported = tag === 'NotSupported' || error.tag === 'Unsupported';
          throw new SiteTxError(unsupported ? 'unsupported' : 'failed', error);
        });
      });
    } catch (error) {
      if (error instanceof SiteTxError) {
        throw error;
      }
      throw new SiteTxError('failed', error instanceof CoreRestoringError ? error.error : error);
    }
  };

  return {
    creator: mainPublicKey => (input, _options, _bindings, mockedSignature) =>
      // A fee estimate would ask the phone to sign, so none is built.
      mockedSignature
        ? Promise.reject(new SiteTxError('failed', new Error('A fee estimate is not built')))
        : build(mainPublicKey, input),
  };
}
