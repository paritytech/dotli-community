// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's round in the session window, its sign-in or its transaction, wired to the window flow it reuses. The window
// flow signs in or resumes the main session and tells the site's round only that a sign-in is stored, never the session
// and never the responder, so what the site gets is only what its own round builds. The window shows the site's views,
// or the window flow's while the site hands the window to that flow. A transaction's round starts only once the window
// has the site's call.

import { createSyncStore, shallowEqual, type ReadableStore } from '@dotli/shared';
import type { SiteGrantStore } from '@dotli/storage';
import type { SignInScreen, SiteWindowScreen } from '../../state/session-window.js';
import type { Responder } from '../session-handoff/responder.js';
import { refuseRound } from '../session-handoff/round-answer.js';
import type { WindowFlow, WindowFlowDeps } from '../session-handoff/window-flow.js';
import type { MainAccount } from './main-account.js';
import type { SiteChain } from './site-chain.js';
import type { SiteGroups } from './site-groups.js';
import type { SiteRequest } from './site-request.js';
import type { SiteRound, SiteRoundDeps } from './site-round.js';
import { createSiteSignIn } from './site-sign-in.js';
import { parseSiteCall, type SiteSignRequest } from './site-sign-request.js';
import type { SiteAccountReader } from './site-account-reader.js';
import { createSiteTransaction } from './site-transaction.js';
import type { SiteTxSigner } from './site-tx-signer.js';

/** What the site's round decides for its window flow, which the caller completes with the window's own parts. */
type SiteWindowFlowDeps = Pick<WindowFlowDeps, 'responder' | 'intent' | 'pageLabel' | 'deliver' | 'close'>;

export type SiteWindowDeps = {
  request: SiteRequest;
  /** The vetted opener's origin, the site the round answers. */
  origin: string;
  /** The window's one responder, which the site's round answers through and the window flow only watches. */
  responder: Responder<unknown>;
  /** Starts the window flow over the window's own store and core. */
  createWindowFlow: (flow: SiteWindowFlowDeps) => WindowFlow;
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
  now: () => number;
  randomToken: () => string;
  close: () => void;
};

export type SiteWindow = {
  site: SiteRound;
  /** What the window shows: the site's view, or the window flow's while the site hands the window to it. */
  screen: ReadableStore<SignInScreen | SiteWindowScreen>;
};

/**
 * What a site's transaction window runs on: a sign-in window's parts, with the chain, the transaction signer and the
 * account reader that reads the site account.
 */
export type SiteTransactionWindowDeps = Omit<SiteWindowDeps, 'request'> & {
  request: SiteSignRequest;
  chain: SiteChain;
  txSigner: SiteTxSigner;
  accountReader: SiteAccountReader;
};

/**
 * The window for a site's round on `route`, which `createRound` makes with the start of the window flow it reuses.
 */
function openSiteWindow(
  deps: Pick<SiteWindowDeps, 'origin' | 'responder' | 'createWindowFlow'>,
  route: 'auth' | 'sign',
  createRound: (startWindowFlow: SiteRoundDeps<unknown>['startWindowFlow']) => SiteRound,
): SiteWindow {
  const { responder } = deps;
  // The window flow's screen, while a flow the site started has not stored its sign-in.
  const flowScreen = createSyncStore<SignInScreen | null>('siteWindowFlow', null);
  const site = createRound((stored, close) => {
    // A round whose stored session is gone starts a flow again on Try again. The flow before it delivered, so its
    // phase is ended and it acts on nothing, and it is left to go with the window.
    let stopFollowing = (): void => undefined;
    const flow = deps.createWindowFlow({
      responder,
      intent: 'resume',
      // A site is named by its full origin, so two sites on one host never read the same.
      pageLabel: origin => origin,
      // The flow is done once it stored a sign-in, so a flow the round starts after it shows alone. The result stays
      // here, so nothing of the session reaches the round.
      deliver: () => {
        stopFollowing();
        flowScreen.set(null);
        stored();
      },
      close,
    });
    flowScreen.set(flow.screen.get());
    stopFollowing = flow.screen.subscribe(() => {
      flowScreen.set(flow.screen.get());
    });
  });

  const screen = createSyncStore<SignInScreen | SiteWindowScreen>(
    'siteWindow',
    { view: 'site-signing', origin: deps.origin, route },
    { equals: shallowEqual },
  );
  // Until the window flow shows a view, the window keeps what it showed.
  const show = (): void => {
    const shown = site.screen.get();
    const next = shown.view === 'window' ? flowScreen.get() : shown;
    if (next !== null) {
      screen.set(next);
    }
  };
  site.screen.subscribe(show);
  flowScreen.subscribe(show);
  show();
  return { site, screen };
}

/** Runs a site's sign-in for the vetted origin with the window flow it reuses. */
export function openSiteSignIn(deps: SiteWindowDeps): SiteWindow {
  return openSiteWindow(deps, 'auth', startWindowFlow =>
    createSiteSignIn({
      request: deps.request,
      origin: deps.origin,
      responder: deps.responder,
      grants: deps.grants,
      groups: deps.groups,
      self: deps.self,
      mainAccount: deps.mainAccount,
      startWindowFlow,
      now: deps.now,
      randomToken: deps.randomToken,
      close: deps.close,
    }),
  );
}

/**
 * Runs a site's transaction for the vetted origin with the window flow it reuses, once the window has the site's call:
 * the request's, else the payload's, while the responder's view stays on show. Resolves with the window once the round
 * opened, or null once it refused a call that is not one and closed the window.
 */
export async function openSiteTransaction(deps: SiteTransactionWindowDeps): Promise<SiteWindow | null> {
  const { request, responder } = deps;
  // A request that carries its call never reads a payload.
  const call = parseSiteCall(request.call ?? (await responder.payload()));
  if (call === null) {
    refuseRound(responder, 'third', 'bad_request', 'sign');
    deps.close();
    return null;
  }
  return openSiteWindow(deps, 'sign', startWindowFlow =>
    createSiteTransaction({
      request,
      call,
      origin: deps.origin,
      responder,
      grants: deps.grants,
      groups: deps.groups,
      self: deps.self,
      chain: deps.chain,
      txSigner: deps.txSigner,
      accountReader: deps.accountReader,
      mainAccount: deps.mainAccount,
      startWindowFlow,
      now: deps.now,
      randomToken: deps.randomToken,
      close: deps.close,
    }),
  );
}
