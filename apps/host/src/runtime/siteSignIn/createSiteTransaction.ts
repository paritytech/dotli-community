// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's transaction, the action a site's round runs on the sign route. It decodes the site's call for the review,
// and once the user confirms, has the phone sign it as the product account the site names. The account's key is read
// from the phone only after Confirm. The site gets the signed transaction to send itself, and the window never sends
// it. Nothing of the main account reaches the site.

import type { ProductAccountId } from '@parity/truapi';
import { spans as S } from '@dotli/metrics';
import { toHex } from '@dotli/shared';
import type { MainAccount } from './createMainAccountSource.js';
import { toDisplayAccount } from './toDisplayAccount.js';
import { SiteChainError, type SiteChain, type SiteChainSession, type SiteDecodedCall } from './createSiteChain.js';
import { createSiteRound, type SiteAction, type SiteRound, type SiteRoundParams } from './createSiteRound.js';
import { reportSiteFailure } from './reportSiteFailure.js';
import { SiteRoundFailure, SiteRoundRefusal, SiteRoundRejected } from './siteRoundErrors.js';
import type { SiteSignRequest } from './parseSiteSignRequest.js';
import { SiteAccountRejectedError, type SiteAccountReader } from './createSiteAccountReader.js';
import { SiteTxError, type SiteTxSigner } from './createSiteTxSigner.js';

/** What the site gets for its transaction: the signed transaction, in lowercase `0x` hex. */
export type SiteTransactionResult = {
  transaction: string;
};

type CreateSiteTransactionParams = Omit<SiteRoundParams<SiteTransactionResult>, 'action' | 'metric' | 'request'> & {
  request: SiteSignRequest;
  /** The site's call, from its request or its payload. */
  call: Uint8Array;
  /** Asset Hub, which decodes the call and builds its transaction. */
  chain: SiteChain;
  /** Signs the call as the account the site names. */
  txSigner: SiteTxSigner;
  /** Reads the key of the account the site names. */
  accountReader: Pick<SiteAccountReader, 'account'>;
};

type GetSiteTransactionActionParams = Pick<
  CreateSiteTransactionParams,
  'origin' | 'call' | 'chain' | 'txSigner' | 'accountReader'
> & {
  /** The product account the site names, which signs the call. */
  account: ProductAccountId;
  /** The genesis of the Asset Hub the site asked for. */
  genesis: string;
};

/** A site's transaction in the session window: the site's round with the transaction as its action. */
export function createSiteTransaction({
  request,
  call,
  chain,
  txSigner,
  accountReader,
  ...round
}: CreateSiteTransactionParams): SiteRound {
  return createSiteRound({
    ...round,
    request: { round: request.round, siteToken: request.siteToken, groupToken: request.groupToken },
    action: getSiteTransactionAction({
      origin: round.origin,
      account: request.account,
      genesis: request.chain,
      call,
      chain,
      txSigner,
      accountReader,
    }),
    metric: S.SITE_TRANSACTION,
  });
}

/** Has the account the site names sign the site's call, and returns the signed transaction without sending it. */
export function getSiteTransactionAction({
  origin,
  account,
  genesis,
  call,
  chain,
  txSigner,
  accountReader,
}: GetSiteTransactionActionParams): SiteAction<SiteTransactionResult> {
  // The named account's key once read for a main account, which a Retry within the round for that main account uses
  // rather than asking the phone again. Another main account derives another key.
  let readKey: { owner: string; key: Uint8Array } | null = null;

  async function readSiteKey(main: MainAccount, asking: () => void): Promise<Uint8Array> {
    if (readKey?.owner === main.owner) {
      return readKey.key;
    }
    asking();
    let key: Uint8Array;
    try {
      key = await accountReader.account(account);
    } catch (error) {
      if (error instanceof SiteAccountRejectedError) {
        throw new SiteRoundRejected({ cause: error });
      }
      throw new SiteRoundFailure({
        step: 'account',
        retry: true,
        message: 'The site account could not be read',
        cause: error,
      });
    }
    readKey = { owner: main.owner, key };
    return key;
  }

  return {
    route: 'sign',
    outcome: () => 'signed',
    async run({ main, show, confirmed, signal }) {
      const session = await openChain(chain, genesis);
      let closed = false;
      // Once only, since a round that ends closes the session at once and the run closes it again as it ends.
      function closeOnce(): void {
        if (!closed) {
          closed = true;
          closeChain(session);
        }
      }
      try {
        // A Cancel lets the chain go at once, rather than once the phone answers.
        signal.addEventListener('abort', closeOnce, { once: true });
        // A round that ended while the chain opened asks nothing more of the chain or the phone.
        signal.throwIfAborted();
        const decoded = await decodeCall(session, call);
        show({ view: 'site-review', origin, call: decoded.display, account: toDisplayAccount(account) });
        await confirmed();
        // Nothing reaches the phone before the user confirms the review. The account's key fills the nonce.
        const publicKey = await readSiteKey(main, () => {
          show({ view: 'site-sharing', origin });
        });
        // A round that ended while the phone was asked builds nothing.
        signal.throwIfAborted();
        // The extensions fill before the phone is asked, so Approve shows only once it is.
        show({ view: 'site-signing', origin, route: 'sign' });
        const creator = txSigner.creator(account, {
          onAsk() {
            show({ view: 'site-approving', origin });
          },
        });
        let transaction: Uint8Array;
        try {
          // The decode the review showed, so the phone signs the call the user confirmed.
          transaction = await session.create({ call: decoded, creator, publicKey });
        } catch (error) {
          throw getBuildFailure(error);
        }
        return { transaction: toHex(transaction) };
      } finally {
        signal.removeEventListener('abort', closeOnce);
        closeOnce();
      }
    },
  };
}

async function openChain(chain: SiteChain, genesis: string): Promise<SiteChainSession> {
  try {
    return await chain.open(genesis);
  } catch (error) {
    // Another network's Asset Hub stays another network's on a Try again.
    const retry = !(error instanceof SiteChainError && error.kind === 'mismatch');
    throw new SiteRoundFailure({ step: 'chain', retry, message: 'Asset Hub could not be opened', cause: error });
  }
}

/** Ends a chain session. A close that fails is reported and counted, and never takes the place of how the run ended. */
function closeChain(session: SiteChainSession): void {
  try {
    session.close();
  } catch (error) {
    const failure = new SiteRoundFailure({
      step: 'chain',
      retry: false,
      message: 'Asset Hub could not be closed',
      cause: error,
    });
    reportSiteFailure(failure, S.SITE_TRANSACTION);
  }
}

async function decodeCall(session: SiteChainSession, call: Uint8Array): Promise<SiteDecodedCall> {
  try {
    return await session.decode(call);
  } catch (error) {
    if (error instanceof SiteChainError && error.kind === 'undecodable') {
      // The site's own input, which is no failure of the window to report.
      throw new SiteRoundRefusal('bad_request');
    }
    throw new SiteRoundFailure({
      step: 'chain',
      retry: true,
      message: 'The call could not be decoded on Asset Hub',
      cause: error,
    });
  }
}

/** What a build that failed ends the round with. Nothing was sent, so a failure may always be tried again. */
function getBuildFailure(error: unknown): Error {
  if (error instanceof SiteTxError) {
    return getSigningFailure(error);
  }
  // Anything else failed before the phone was asked: the fillers did not load, or papi's reads of the chain failed.
  return new SiteRoundFailure({
    step: 'chain',
    retry: true,
    message: 'Asset Hub failed before the transaction was signed',
    cause: error,
  });
}

/** What a signing that failed ends the round with: a rejection, a refusal, or a failure to try again. */
function getSigningFailure(error: SiteTxError): Error {
  switch (error.kind) {
    case 'rejected':
      return new SiteRoundRejected({ cause: error });
    case 'unsupported':
      return new SiteRoundRefusal('transaction_invalid', { cause: error });
    case 'failed':
      return new SiteRoundFailure({
        step: 'build',
        retry: true,
        message: 'The transaction could not be signed',
        cause: error,
      });
  }
}
