// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's transaction, the action a site's round runs on the sign route. It decodes the site's call for the review,
// and once the user confirms, has the phone sign it as the product account the site names. The site gets the signed
// transaction to send itself, and the window never sends it. Nothing of the main account reaches the site.

import type { ProductAccountId } from '@parity/truapi';
import { spans as S } from '@dotli/metrics';
import { toHex } from '@dotli/shared';
import type { MainAccount } from './main-account.js';
import { displayAccount } from './site-account.js';
import { SiteChainError, type SiteChain, type SiteChainSession, type SiteDecodedCall } from './site-chain.js';
import {
  createSiteRound,
  reportSiteFailure,
  SiteRoundFailure,
  SiteRoundRefusal,
  SiteRoundRejected,
  type SiteAction,
  type SiteRound,
  type SiteRoundDeps,
} from './site-round.js';
import type { SiteSignRequest } from './site-sign-request.js';
import { SiteSignRejectedError, type SiteSigner } from './site-signer.js';
import { SiteTxError, type SiteTxSigner } from './site-tx-signer.js';

/** What the site gets for its transaction: the signed transaction, in lowercase `0x` hex. */
export interface SiteTransactionResult {
  transaction: string;
}

export type SiteTransactionDeps = Omit<SiteRoundDeps<SiteTransactionResult>, 'action' | 'metric' | 'request'> & {
  request: SiteSignRequest;
  /** The site's call, from its request or its payload. */
  call: Uint8Array;
  chain: SiteChain;
  txSigner: SiteTxSigner;
  signer: Pick<SiteSigner, 'account'>;
};

async function openChain(chain: SiteChain, genesis: string): Promise<SiteChainSession> {
  try {
    return await chain.open(genesis);
  } catch (error) {
    // Another network's Asset Hub stays another network's on a Try again.
    const retry = !(error instanceof SiteChainError && error.kind === 'mismatch');
    throw new SiteRoundFailure('chain', retry, 'Asset Hub could not be opened', error);
  }
}

/** Ends a chain session. A close that fails is reported and counted, and never takes the place of how the run ended. */
function closeChain(session: SiteChainSession): void {
  try {
    session.close();
  } catch (error) {
    reportSiteFailure(new SiteRoundFailure('chain', false, 'Asset Hub could not be closed', error), S.SITE_TRANSACTION);
  }
}

async function decode(session: SiteChainSession, call: Uint8Array): Promise<SiteDecodedCall> {
  try {
    return await session.decode(call);
  } catch (error) {
    if (error instanceof SiteChainError && error.kind === 'undecodable') {
      // The site's own input, which is no failure of the window to report.
      throw new SiteRoundRefusal('bad_request');
    }
    throw new SiteRoundFailure('chain', true, 'The call could not be decoded on Asset Hub', error);
  }
}

/** What a build that failed ends the round with. Nothing was sent, so a failure may always be tried again. */
function buildFailure(error: unknown): Error {
  if (error instanceof SiteTxError) {
    if (error.kind === 'rejected') {
      return new SiteRoundRejected(error);
    }
    if (error.kind === 'unsupported') {
      return new SiteRoundRefusal('transaction_invalid', error);
    }
    return new SiteRoundFailure('build', true, 'The transaction could not be signed', error);
  }
  // Anything else failed before the phone was asked: the fillers did not load, or papi's reads of the chain failed.
  return new SiteRoundFailure('chain', true, 'Asset Hub failed before the transaction was signed', error);
}

/** Has the account the site names sign the site's call, and returns the signed transaction without sending it. */
export function siteTransactionAction(deps: {
  origin: string;
  /** The product account the site names, which signs the call. */
  account: ProductAccountId;
  /** The genesis of the Asset Hub the site asked for. */
  genesis: string;
  call: Uint8Array;
  chain: SiteChain;
  txSigner: SiteTxSigner;
  signer: Pick<SiteSigner, 'account'>;
}): SiteAction<SiteTransactionResult> {
  const { origin, account, genesis, call, chain, txSigner, signer } = deps;
  // The named account's key once read for a main account, which a Retry within the round for that main account uses
  // rather than asking the phone again. Another main account derives another key.
  let readKey: { owner: string; key: Uint8Array } | null = null;

  const siteKey = async (main: MainAccount): Promise<Uint8Array> => {
    if (readKey?.owner === main.owner) {
      return readKey.key;
    }
    let key: Uint8Array;
    try {
      key = await signer.account(account);
    } catch (error) {
      if (error instanceof SiteSignRejectedError) {
        throw new SiteRoundRejected(error);
      }
      throw new SiteRoundFailure('account', true, 'The site account could not be read', error);
    }
    readKey = { owner: main.owner, key };
    return key;
  };

  return {
    route: 'sign',
    outcome: () => 'signed',
    async run({ main, show, confirmed, signal }) {
      const session = await openChain(chain, genesis);
      let closed = false;
      // Once only, since a round that ends closes the session at once and the run closes it again as it ends.
      const close = (): void => {
        if (!closed) {
          closed = true;
          closeChain(session);
        }
      };
      try {
        // A Cancel lets the chain go at once, rather than once the phone answers.
        signal.addEventListener('abort', close, { once: true });
        // A round that ended while the chain opened asks nothing more of the chain or the phone.
        signal.throwIfAborted();
        // Decoded before the key, so a call that cannot be shown costs no approval on the phone.
        const decoded = await decode(session, call);
        // The account's key fills the nonce.
        const publicKey = await siteKey(main);
        show({ view: 'site-review', origin, call: decoded.display, account: displayAccount(account) });
        await confirmed();
        // The extensions fill before the phone is asked, so Approve shows only once it is.
        show({ view: 'site-signing', origin, route: 'sign' });
        const creator = txSigner.creator(account, () => {
          show({ view: 'site-approving', origin });
        });
        let transaction: Uint8Array;
        try {
          // The decode the review showed, so the phone signs the call the user confirmed.
          transaction = await session.create(decoded, creator, publicKey);
        } catch (error) {
          throw buildFailure(error);
        }
        return { transaction: toHex(transaction) };
      } finally {
        signal.removeEventListener('abort', close);
        close();
      }
    },
  };
}

/** A site's transaction in the session window: the site's round with the transaction as its action. */
export function createSiteTransaction(deps: SiteTransactionDeps): SiteRound {
  const { request, call, chain, txSigner, signer, ...round } = deps;
  return createSiteRound({
    ...round,
    request: { round: request.round, siteToken: request.siteToken, groupToken: request.groupToken },
    action: siteTransactionAction({
      origin: deps.origin,
      account: request.account,
      genesis: request.chain,
      call,
      chain,
      txSigner,
      signer,
    }),
    metric: S.SITE_TRANSACTION,
  });
}
