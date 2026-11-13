// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's round in the session window, its sign-in or its transaction, wired to the window flow it reuses. The window
// flow signs in or resumes the main session and tells the site's round only that a sign-in is stored, never the session
// and never the responder, so what the site gets is only what its own round builds. The window shows the site's views,
// or the window flow's while the site hands the window to that flow. A transaction's round starts only once the window
// has the site's call.

import { atom, type ReadableAtom } from 'nanostores';
import { isShallowEqual } from '@dotli/shared';
import type { SiteGrantStore } from '@dotli/storage';
import type { SignInScreen, SiteWindowScreen } from '../../state/sessionWindowState.js';
import type { Responder } from '../sessionHandoff/createResponder.js';
import type { WindowFlow, WindowFlowParams } from '../sessionHandoff/createWindowFlow.js';
import { refuseRound } from '../sessionHandoff/roundAnswer.js';
import type { MainAccount } from './mainAccount.js';
import type { SiteChain } from './createSiteChain.js';
import type { SiteGroups } from './createSiteGroups.js';
import type { SiteRequest } from './parseSiteRequest.js';
import type { SiteRound, SiteRoundParams } from './createSiteRound.js';
import type { SiteRoute } from './siteRouteMetrics.js';
import { createSiteSignIn } from './createSiteSignIn.js';
import { parseSiteCall, type SiteSignRequest } from './parseSiteSignRequest.js';
import type { SiteAccountReader } from './createSiteAccountReader.js';
import { createSiteTransaction } from './createSiteTransaction.js';
import type { SiteTxSigner } from './createSiteTxSigner.js';

/** What the site's round decides for its window flow, which the caller completes with the window's own parts. */
type CreateWindowFlowParams = Pick<WindowFlowParams, 'responder' | 'intent' | 'pageLabel' | 'deliver' | 'close'>;

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
 * What a site's transaction window runs on: a sign-in window's parts, with the chain, the transaction signer and the
 * account reader that reads the site account.
 */
type OpenSiteTransactionParams = Omit<SiteWindowParams, 'request'> & {
  request: SiteSignRequest;
  chain: SiteChain;
  txSigner: SiteTxSigner;
  accountReader: SiteAccountReader;
};

type OpenSiteWindowParams = Pick<SiteWindowParams, 'origin' | 'responder' | 'createWindowFlow'> & {
  route: SiteRoute;
  /** Makes the site's round with the start of the window flow it reuses. */
  createRound: (startWindowFlow: SiteRoundParams<unknown, string>['startWindowFlow']) => SiteRound;
};

/** A site's round and what its window shows. */
export type SiteWindow = ReturnType<typeof openSiteWindow>;

/** Runs a site's sign-in for the vetted origin with the window flow it reuses. */
export function openSiteSignIn({ origin, responder, createWindowFlow, ...round }: SiteWindowParams): SiteWindow {
  return openSiteWindow({
    origin,
    responder,
    createWindowFlow,
    route: 'auth',
    createRound: startWindowFlow => createSiteSignIn({ ...round, origin, responder, startWindowFlow }),
  });
}

/**
 * Runs a site's transaction for the vetted origin with the window flow it reuses, once the window has the site's call:
 * the request's, else the payload's, while the responder's view stays on show. Resolves with the window once the round
 * opened, or null once it refused a call that is not one and closed the window.
 */
export async function openSiteTransaction({
  request,
  origin,
  responder,
  createWindowFlow,
  close,
  ...round
}: OpenSiteTransactionParams): Promise<SiteWindow | null> {
  // A request that carries its call never reads a payload.
  const call = parseSiteCall(request.call ?? (await responder.payload()));
  if (call === null) {
    refuseRound({ responder, party: 'third', reason: 'bad_request', route: 'sign' });
    close();
    return null;
  }
  return openSiteWindow({
    origin,
    responder,
    createWindowFlow,
    route: 'sign',
    createRound: startWindowFlow =>
      createSiteTransaction({ ...round, request, call, origin, responder, close, startWindowFlow }),
  });
}

/** The window for a site's round on `route`, which `createRound` makes with the start of the window flow it reuses. */
function openSiteWindow({ origin, responder, createWindowFlow, route, createRound }: OpenSiteWindowParams) {
  // The window flow's screen, while a flow the site started has not stored its sign-in.
  const flowScreen = atom<SignInScreen | null>(null);
  const stops: (() => void)[] = [];
  // Set on dispose, after which the round starts no flow, as nothing would release it.
  let disposed = false;
  const site = createRound((stored, close, failed) => {
    if (disposed) {
      return;
    }
    // A round whose stored session is gone starts a flow again on Try again. The flow before it is left until the
    // window is disposed, since closing the window twice is harmless.
    let stopFollowing = (): void => undefined;
    let flow: WindowFlow;
    try {
      flow = createWindowFlow({
        responder,
        intent: 'resume',
        // A site is named by its full origin, so two sites on one host never read the same.
        pageLabel: pageOrigin => pageOrigin,
        // The flow is done once it stored a sign-in, so a flow the round starts after it shows alone. The result stays
        // here, so nothing of the session reaches the round.
        deliver() {
          stopFollowing();
          flowScreen.set(null);
          stored();
        },
        close,
      });
    } catch (error) {
      failed(error);
      return;
    }
    stopFollowing = flow.screen.subscribe(next => {
      flowScreen.set(next);
    });
    stops.push(stopFollowing, () => {
      flow.dispose();
    });
  });

  const screen = atom<SignInScreen | SiteWindowScreen>({ view: 'site-signing', origin, route });
  screen.eq = isShallowEqual;

  // Until the window flow shows a view, the window keeps what it showed.
  function showCurrent(): void {
    const shown = site.screen.get();
    const next = shown.view === 'window' ? flowScreen.get() : shown;
    if (next !== null) {
      screen.set(next);
    }
  }

  stops.push(site.screen.listen(showCurrent), flowScreen.listen(showCurrent));
  showCurrent();

  function dispose(): void {
    disposed = true;
    for (const stop of stops.splice(0)) {
      stop();
    }
  }

  const shownScreen: ReadableAtom<SignInScreen | SiteWindowScreen> = screen;
  return {
    /** The site's round, with the intents of its views. */
    site,
    /** What the window shows: the site's view, or the window flow's while the site hands the window to it. */
    screen: shownScreen,
    /**
     * Stops showing the site's round, disposes every window flow it started and starts none after it, never disposes
     * the responder, which is its caller's, is safe to call twice, and leaves the site's round open, where a Try again
     * then starts no flow and nothing more of it shows. Throws what a window flow's `dispose` throws, and then disposes
     * no flow after it.
     */
    dispose,
  };
}
