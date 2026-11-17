// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's round in the session window, its sign-in or its transaction, wired to the window flow it reuses. The window
// flow signs in or resumes the main session and tells the site's round only that a sign-in is stored, never the session
// and never the responder, so what the site gets is only what its own round builds. The round shows the site's views,
// and the window flow's while that flow signs in.

import type { SiteGrantStore } from '@dotli/storage';
import type { Responder } from './createResponder.js';
import type { WindowFlow, WindowFlowParams } from './createWindowFlow.js';
import type { MainAccount } from '../siteSignIn/index.js';
import type { SiteChain } from '../siteSignIn/index.js';
import type { SiteGroups } from '../siteSignIn/index.js';
import type { SiteRequest } from '../siteSignIn/index.js';
import type { SiteRound } from '../siteSignIn/index.js';
import { createSiteSignIn } from '../siteSignIn/index.js';
import type { SiteAccountReader } from '../siteSignIn/index.js';
import { createSiteTransaction } from '../siteSignIn/index.js';
import type { SiteTransactionRequest } from '../siteSignIn/index.js';
import type { SiteTxSigner } from '../siteSignIn/index.js';

/** What the site's round decides for its window flow, which the caller completes with the window's own parts. */
type CreateWindowFlowParams = Pick<WindowFlowParams, 'responder' | 'intent' | 'page' | 'deliver' | 'close'>;

export type SiteWindowParams = {
  request: SiteRequest;
  /** The vetted opener's origin, the site the round answers. */
  origin: string;
  /** The window's one responder, which the site's round answers through and the window flow only watches. */
  responder: Responder<unknown>;
  /** Starts the window flow over the window's own store and core. */
  createWindowFlow: (flow: CreateWindowFlowParams) => WindowFlow;
  grants: SiteGrantStore;
  /** The registrable domains a site's group is judged by. */
  groups: SiteGroups;
  /** The window's own origin. */
  self: string;
  /**
   * The main account the window's core reports, once it reports one. Rejects with a `MainAccountError` when the core
   * cannot boot or its session is gone, or once `signal` aborts.
   */
  mainAccount: (signal: AbortSignal) => Promise<MainAccount>;
  /** The time a grant's first and last use are stamped with. */
  now: () => number;
  /** A new grant's site token. */
  randomToken: () => string;
  /** Closes the window. */
  close: () => void;
};

/**
 * What a site's transaction window runs on: a sign-in window's parts for a request whose call is known, with the chain,
 * the transaction signer and the account reader that reads the site account.
 */
type OpenSiteTransactionParams = Omit<SiteWindowParams, 'request'> & {
  request: SiteTransactionRequest;
  chain: SiteChain;
  txSigner: SiteTxSigner;
  accountReader: SiteAccountReader;
};

/** Runs a site's sign-in for the vetted origin with the window flow it reuses. */
export function openSiteSignIn({ origin, responder, createWindowFlow, ...round }: SiteWindowParams): SiteRound {
  const startWindowFlow = getWindowFlowStart({ origin, responder, createWindowFlow });
  return createSiteSignIn({ ...round, origin, responder, startWindowFlow });
}

/** Runs a site's transaction of the request's call for the vetted origin with the window flow it reuses. */
export function openSiteTransaction({
  origin,
  responder,
  createWindowFlow,
  ...round
}: OpenSiteTransactionParams): SiteRound {
  const startWindowFlow = getWindowFlowStart({ origin, responder, createWindowFlow });
  return createSiteTransaction({ ...round, origin, responder, startWindowFlow });
}

/** Starts the window flow a site's round reuses, which resumes the stored sign-in for the site. */
function getWindowFlowStart({
  origin,
  responder,
  createWindowFlow,
}: Pick<SiteWindowParams, 'origin' | 'responder' | 'createWindowFlow'>) {
  return (stored: () => void, close: () => void) =>
    createWindowFlow({
      responder,
      intent: 'resume',
      // A site is named by its full origin, so two sites on one host never read the same.
      page: origin,
      // The result stays here, so nothing of the session reaches the round.
      deliver() {
        stored();
      },
      close,
    });
}
