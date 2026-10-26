// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's transaction, the action a site's round runs on the sign route. It decodes the site's call for the review,
// has the phone build the transaction for the main account once the user confirms, and submits it once. The site gets
// the transaction's hash, its block and how it went, and nothing of the main account or the signed transaction.

import { spans as S } from '@dotli/metrics';
import {
  SiteChainError,
  type SiteChain,
  type SiteChainSession,
  type SiteDecodedCall,
  type SiteSubmitEvent,
} from './site-chain.js';
import {
  createSiteRound,
  reportSiteFailure,
  SiteRoundFailure,
  SiteRoundRefusal,
  SiteRoundRejected,
  type SiteAction,
  type SiteActionScreen,
  type SiteRound,
  type SiteRoundDeps,
} from './site-round.js';
import type { SiteSignRequest } from './site-sign-request.js';
import { SiteSignRejectedError, type SiteSigner } from './site-signer.js';
import { SiteTxError, type SiteTxSigner } from './site-tx-signer.js';

/** What the site gets for its transaction. `error` names the dispatch error of a transaction that failed. */
export interface SiteTransactionResult {
  tx_hash: string;
  status: 'included' | 'failed';
  block_hash: string;
  error?: string;
}

/**
 * The rounds whose transaction the chain has, kept as long as anything can answer the same round again, such as a
 * window reloaded on its kept request.
 */
export interface SiteSubmissions {
  has(round: string): boolean;
  mark(round: string): void;
}

export type SiteTransactionDeps = Omit<SiteRoundDeps<SiteTransactionResult>, 'action' | 'metric' | 'request'> & {
  request: SiteSignRequest;
  /** The site's call, from its request or its payload. */
  call: Uint8Array;
  submitted: SiteSubmissions;
  chain: SiteChain;
  txSigner: SiteTxSigner;
  signer: Pick<SiteSigner, 'account'>;
};

type Included = Extract<SiteSubmitEvent, { kind: 'included' }>;

function resultOf(event: Included): SiteTransactionResult {
  // Lowercased rather than parsed, so nothing after the broadcast can fail into a Try again.
  const txHash = event.txHash.toLowerCase();
  const blockHash = event.blockHash.toLowerCase();
  return event.ok
    ? { tx_hash: txHash, status: 'included', block_hash: blockHash }
    : { tx_hash: txHash, status: 'failed', block_hash: blockHash, error: event.error };
}

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

/**
 * What a submission that failed before the chain had the transaction ends the round with. Once the chain has it,
 * nothing offers Try again, which would submit it twice.
 */
function submitFailure(error: unknown, sent: boolean): Error {
  if (error instanceof SiteTxError) {
    if (error.kind === 'rejected') {
      return new SiteRoundRejected(error);
    }
    if (error.kind === 'unsupported') {
      return new SiteRoundRefusal('transaction_invalid', error);
    }
    return new SiteRoundFailure('build', !sent, 'The transaction could not be built', error);
  }
  // papi reads the chain before it builds, so anything else is the chain's.
  return new SiteRoundFailure('chain', !sent, 'Asset Hub failed before the transaction was built', error);
}

/** Has the main account build, sign and submit the site's call, and watches it into its first best block. */
export function siteTransactionAction(deps: {
  /** The site's round, whose transaction goes out at most once however often the window answers it. */
  round: string;
  submitted: SiteSubmissions;
  origin: string;
  /** The genesis of the Asset Hub the site asked for. */
  genesis: string;
  call: Uint8Array;
  chain: SiteChain;
  txSigner: SiteTxSigner;
  signer: Pick<SiteSigner, 'account'>;
}): SiteAction<SiteTransactionResult> {
  const { round, submitted, origin, genesis, call, chain, txSigner, signer } = deps;
  // The site account's key once read, which a Retry within the round uses rather than asking the phone again.
  let readKey: Uint8Array | null = null;
  // Whether the chain has the transaction, here or before a reload. It never unsets, so a Cancel after it is never
  // taken as nothing done, and a run after it refuses rather than submitting again.
  let sent = submitted.has(round);

  const siteKey = async (index: `0x${string}`, knownKey: Uint8Array | null): Promise<Uint8Array> => {
    if (knownKey !== null) {
      return knownKey;
    }
    if (readKey !== null) {
      return readKey;
    }
    let key: Uint8Array;
    try {
      key = await signer.account(index);
    } catch (error) {
      if (error instanceof SiteSignRejectedError) {
        throw new SiteRoundRejected(error);
      }
      throw new SiteRoundFailure('account', true, 'The site account could not be read', error);
    }
    readKey = key;
    return key;
  };

  /** Reads the submission's events to its end. A round that ends stops the watch at once. */
  const watch = async (
    events: AsyncIterable<SiteSubmitEvent>,
    show: (screen: SiteActionScreen) => void,
    signal: AbortSignal,
  ): Promise<SiteTransactionResult> => {
    const iterator = events[Symbol.asyncIterator]();
    // Stopping unsubscribes, so papi never broadcasts a transaction the user left before the phone answered.
    const stop = (): void => {
      void iterator.return?.();
    };
    signal.addEventListener('abort', stop);
    try {
      signal.throwIfAborted();
      for (;;) {
        let next: IteratorResult<SiteSubmitEvent>;
        try {
          next = await iterator.next();
        } catch (error) {
          throw submitFailure(error, sent);
        }
        if (next.done === true) {
          throw signal.aborted
            ? new Error('The round ended', { cause: signal.reason })
            : new SiteRoundFailure('submit', !sent, 'The transaction watch ended before a best block');
        }
        const event = next.value;
        switch (event.kind) {
          case 'submitted':
            sent = true;
            // At once, so a reload from here on finds the round submitted.
            submitted.mark(round);
            show({ view: 'site-submitting', origin, sent: true });
            break;
          case 'included':
            return resultOf(event);
          case 'invalid':
            throw new SiteRoundRefusal('transaction_invalid', event.error);
          case 'lost':
            throw sent
              ? new SiteRoundRefusal('transaction_unknown', event.error)
              : new SiteRoundFailure('submit', true, 'The transaction watch failed before its broadcast', event.error);
        }
      }
    } finally {
      signal.removeEventListener('abort', stop);
      await iterator.return?.();
    }
  };

  return {
    route: 'sign',
    outcome: result => result.status,
    cancelAs: () => (sent ? 'transaction_unknown' : null),
    async run({ main, index, knownKey, show, confirmed, signal }) {
      if (sent) {
        // Whatever failed after the chain had the transaction, submitting again could apply the site's call twice.
        throw new SiteRoundRefusal('transaction_unknown');
      }
      const session = await openChain(chain, genesis);
      try {
        // Decoded before the key, so a call that cannot be shown costs no approval on the phone.
        const decoded = await decode(session, call);
        const publicKey = await siteKey(index, knownKey);
        show({ view: 'site-review', origin, call: decoded.display });
        await confirmed();
        show({ view: 'site-submitting', origin, sent: false });
        // The decode the review showed, so the phone signs the call the user confirmed.
        const result = await watch(session.submit(decoded, txSigner.creator(main.publicKey)), show, signal);
        return { result, publicKey };
      } finally {
        closeChain(session);
      }
    },
  };
}

/** A site's transaction in the session window: the site's round with the transaction as its action. */
export function createSiteTransaction(deps: SiteTransactionDeps): SiteRound {
  const { request, call, submitted, chain, txSigner, signer, ...round } = deps;
  return createSiteRound({
    ...round,
    request: { round: request.round, siteToken: request.siteToken, groupToken: request.groupToken, statement: null },
    action: siteTransactionAction({
      round: request.round,
      submitted,
      origin: deps.origin,
      genesis: request.chain,
      call,
      chain,
      txSigner,
      signer,
    }),
    metric: S.SITE_TRANSACTION,
  });
}
