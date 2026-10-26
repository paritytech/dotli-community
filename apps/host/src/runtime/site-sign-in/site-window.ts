// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's round in the session window, its sign-in or its transaction, wired to the window flow it reuses. The window
// flow resumes the main session and hands it to the site's round, never to the responder, so what the site gets is only
// what its own round builds. The window shows the site's views, or the window flow's while the site hands the window to
// that flow. A transaction's round starts only once the window has the site's call.

import type { Network } from '@dotli/config';
import { createSyncStore, shallowEqual, type ReadableStore } from '@dotli/shared';
import type { SiteGrantStore } from '@dotli/storage';
import type { SignInScreen, SiteWindowScreen } from '../../state/session-window.js';
import type { Responder } from '../session-handoff/responder.js';
import { refuseRound } from '../session-handoff/round-answer.js';
import type { WindowFlow, WindowFlowDeps } from '../session-handoff/window-flow.js';
import type { DotliAuthState } from '../session/auth-state.js';
import type { SiteChain } from './site-chain.js';
import type { SiteGroups } from './site-groups.js';
import type { SiteRequest } from './site-request.js';
import type { SiteRound, SiteRoundDeps } from './site-round.js';
import { createSiteSignIn } from './site-sign-in.js';
import { parseSiteCall, type SiteSignRequest } from './site-sign-request.js';
import type { SiteSigner } from './site-signer.js';
import { createSiteTransaction, type SiteSubmissions } from './site-transaction.js';
import type { SiteTxSigner } from './site-tx-signer.js';

/** What the site's round decides for its window flow, which the caller completes with the window's own parts. */
type SiteWindowFlowDeps = Pick<WindowFlowDeps, 'responder' | 'intent' | 'pageLabel' | 'deliver' | 'close'>;

export interface SiteWindowDeps {
  request: SiteRequest;
  /** The vetted opener's origin, the site the round answers. */
  origin: string;
  net: Network;
  /** The window's one responder, which the site's round answers through and the window flow only watches. */
  responder: Responder<unknown>;
  /** Starts the window flow over the window's own store and core. */
  createWindowFlow: (flow: SiteWindowFlowDeps) => WindowFlow;
  grants: SiteGrantStore;
  /** The registrable domains a site's group is judged by. */
  groups: SiteGroups;
  /** The window's own origin. */
  self: string;
  signer: SiteSigner;
  auth: ReadableStore<DotliAuthState>;
  /** The main store's cached account, read again on a Retry. */
  readUiCache: () => Promise<string | null>;
  now: () => number;
  randomToken: () => string;
  close: () => void;
}

export interface SiteWindow {
  site: SiteRound;
  /** What the window shows: the site's view, or the window flow's while the site hands the window to it. */
  screen: ReadableStore<SignInScreen | SiteWindowScreen>;
}

/** What a site's transaction window runs on: a sign-in window's parts, with the chain and the transaction signer. */
export type SiteTransactionWindowDeps = Omit<SiteWindowDeps, 'request' | 'net'> & {
  request: SiteSignRequest;
  chain: SiteChain;
  txSigner: SiteTxSigner;
  submitted: SiteSubmissions;
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
  // The window flow's screen, once the site started that flow.
  const flowScreen = createSyncStore<SignInScreen | null>('siteWindowFlow', null);
  const site = createRound((deliver, close) => {
    // A site is named by its full origin, so two sites on one host never read the same.
    const flow = deps.createWindowFlow({ responder, intent: 'resume', pageLabel: origin => origin, deliver, close });
    flowScreen.set(flow.screen.get());
    flow.screen.subscribe(() => {
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
      net: deps.net,
      responder: deps.responder,
      grants: deps.grants,
      groups: deps.groups,
      self: deps.self,
      signer: deps.signer,
      auth: deps.auth,
      readUiCache: deps.readUiCache,
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
 * opened, or null once it refused a round whose transaction this tab submitted before, or a call that is not one, and
 * closed the window.
 */
export async function openSiteTransaction(deps: SiteTransactionWindowDeps): Promise<SiteWindow | null> {
  const { request, responder } = deps;
  if (deps.submitted.has(request.round)) {
    // A window reloaded after the chain had the round's transaction, which no consent or call may lead to again.
    refuseRound(responder, 'third', 'transaction_unknown', 'sign');
    deps.close();
    return null;
  }
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
      signer: deps.signer,
      submitted: deps.submitted,
      auth: deps.auth,
      readUiCache: deps.readUiCache,
      startWindowFlow,
      now: deps.now,
      randomToken: deps.randomToken,
      close: deps.close,
    }),
  );
}
