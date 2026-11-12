// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The session window's entry. It reads the request the page put in its URL, answers the page that opened it, and boots
// the protocol frame and the bridge on its own settings. For dot.li's own page, the sign-in window boots session state
// with a core that only pairs, so nothing it does switches wallet mode or reloads the page. Once the first hello named
// the opener's party, it runs its flow for dot.li's own page, or a site's sign-in or transaction. For a site, the window
// first runs its core under the product id of the account the site names, on a stored local wallet when there is one,
// and the site's round has that same flow sign in or resume a sign-in. A site's sign-in by redirect needs no opener:
// the window vets the return address the request names, and answers the round once, sealed in that address. The
// sign-out window answers its opener's hello too, but boots no session state, so its own flow reads the stored session
// first, and its steps never wait on the opener. The site list answers no page and boots nothing: it reads only the
// grants the main store keeps.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { getDefaultNetwork, getEnabledNetworks, isSharedWorkerAvailable, type Network } from '@dotli/config';
import { createReporter } from '@dotli/metrics';
import { createDeferred, listen, pageLocalStorage, pageSessionStorage, createRandomId } from '@dotli/shared';
import { siteGrants } from '@dotli/storage';
import type { ProductAccountId } from '@parity/truapi';
import { base64urlnopad } from '@scure/base';
import { getOpenerParty, type OpenerParty } from './runtime/sessionHandoff/openerRule.js';
import type { PageRole } from './runtime/pageRole.js';
import { startPageResponder, type Responder } from './runtime/sessionHandoff/createResponder.js';
import { parseWindowRequest, type SignInIntent } from './runtime/sessionHandoff/parseWindowRequest.js';
import type { SessionResult } from './runtime/sessionHandoff/parseSessionResult.js';
import type { SessionRequest } from './runtime/sessionHandoff/readSessionRequest.js';
import {
  answerSignIn,
  answerSignOut,
  type SIGNED_OUT_RESULT,
  type SignInRound,
} from './runtime/sessionHandoff/roundAnswer.js';
import { getRoute } from './runtime/sessionHandoff/sessionRoute.js';
import { forgetWindowRequest, takeWindowRequest, watchNewRequests } from './runtime/sessionHandoff/windowRequest.js';
import { closeWindow } from './sessionWindowPage.js';
import { reportWalletFailure } from './runtime/walletFailure.js';
import { loadRecoveryPhrase } from './lazy.js';
import type { HostBridge } from './runtime/bridge.js';
import { createWindowFlow, type WindowFlow, type WindowFlowParams } from './runtime/sessionHandoff/createWindowFlow.js';
import { getResponderScreen } from './runtime/sessionHandoff/windowScreen.js';
import { sessionWindowSignoutResultMetric } from './runtime/sessionHandoff/sessionWindowSignoutResultMetric.js';
import { signOutInWindow, type WindowSignOutParams } from './runtime/sessionHandoff/signOutInWindow.js';
import publicSuffixListUrl from './runtime/siteSignIn/public-suffix-list.dat?url';
import { createSiteGroups } from './runtime/siteSignIn/createSiteGroups.js';
import { createSiteList } from './runtime/siteSignIn/createSiteList.js';
import { createRedirectResponder } from './runtime/siteSignIn/createRedirectResponder.js';
import { vetRedirect } from './runtime/siteSignIn/vetRedirect.js';
import { readRedirectFields, type RedirectFields } from './runtime/siteSignIn/readRedirectFields.js';
import { SITE_TOKEN_BYTES } from './runtime/siteSignIn/parseSiteRequest.js';
import { checkReturnTo } from './runtime/siteSignIn/checkReturnTo.js';
import { probeSeal, sealRedirect } from './runtime/siteSignIn/siteSeal.js';
import { isUnsentGrantForgotten } from './runtime/siteSignIn/siteRoundGrants.js';
import { openSiteSignIn, openSiteTransaction, type SiteWindowParams } from './runtime/siteSignIn/siteWindow.js';
import { authState } from './runtime/state/authState.js';
import { getWindowSettings } from './getWindowSettings.js';
import { sessionWindowState } from './state/sessionWindowState.js';
import { startPage } from './startPage.js';
import { startHost, type StartHostParams } from './startHost.js';
import { reportBootFailure } from './reportBootFailure.js';
import { SITE_ROUTE_METRICS } from './runtime/siteSignIn/siteRouteMetrics.js';

const bootReport = createReporter({ flow: 'boot' });
const walletReport = createReporter({ flow: 'wallet' });

type OpenFlowParams = {
  responder: Responder<unknown>;
  intent: SignInIntent;
  bridge: HostBridge;
};

type GetSiteWindowParamsParams = {
  responder: Responder<unknown>;
  round: Extract<SignInRound<HostBridge>, { party: 'third' | 'third-sign' }>;
  /** The product account the window's core serves as, or `null` for dot.li's own. */
  account: ProductAccountId | null;
  /** Closes the window once the round is done. */
  close: () => void;
};

type OpenSiteFlowParams = {
  responder: Responder<unknown>;
  round: Extract<SignInRound<HostBridge>, { party: 'third' }>;
  close: () => void;
};

type OpenSiteTransactionFlowParams = {
  responder: Responder<unknown>;
  round: Extract<SignInRound<HostBridge>, { party: 'third-sign' }>;
  /** Ends the responder's view once the window has the site's call. */
  stopShowingResponder: () => void;
};

type RedirectSignInParams = {
  taken: SessionRequest;
  enabled: readonly Network[];
  fields: RedirectFields;
};

type RunSignOutParams = {
  taken: SessionRequest;
  enabled: readonly Network[];
} & Pick<WindowSignOutParams, 'notified' | 'read' | 'firstParty'>;

/** The sign-in window restores and pairs, while the sign-out window ends the stored session on a core of its own. */
function getWindowHostParams(
  role: Extract<PageRole, 'signin-window' | 'signout-window'>,
  network: Network,
): Omit<StartHostParams, 'bootFlowId'> {
  return {
    role,
    settings: getWindowSettings({
      network,
      local: pageLocalStorage,
      sharedWorkerAvailable: isSharedWorkerAvailable(),
    }),
  };
}

/** The network a window boots on: its request's when this deployment runs it, else the default. */
function bootNetwork(request: SessionRequest, enabled: readonly Network[]): Network {
  return enabled.find(network => network === request.network) ?? getDefaultNetwork();
}

/** The party of a hello's origin, dot.li's own page or a site, or why it has none. */
function judgeOpener(origin: string): OpenerParty {
  return getOpenerParty(origin, window.location.origin);
}

/** A request the window cannot read as dot.li's own has no round it answers, so it listens to nobody. */
function refuseUnreadable(): void {
  bootReport.log.event('Session window refused: no readable request');
  sessionWindowState.setScreen(getResponderScreen({ kind: 'refused' }));
}

/**
 * The page said all it had to in the request, so the window's sign-out waits for no hello and only tells the page it
 * has read the main store, with an empty result. The read goes out once it is made, or the sign-out ended without it,
 * and the first vetting found the round answerable, whichever comes last. The sites' grants go only for a round of
 * dot.li's own page.
 */
async function signOut(taken: SessionRequest, enabled: readonly Network[]): Promise<void> {
  // Only dot.li's own pages open the sign-out window, so its request is read as theirs before any hello.
  const request = parseWindowRequest(taken);
  if (request?.route !== 'signout') {
    refuseUnreadable();
    return;
  }
  const { notified } = request;
  sessionWindowState.setScreen({ view: 'signing-out' });
  // Before the boot, so the handshake runs while the frame comes up. A refused opener leaves the sign-out views as
  // they are. The responder lives as long as the window's page, so nothing disposes it.
  const responder = startPageResponder<typeof SIGNED_OUT_RESULT>(request.round, judgeOpener);
  const read = createDeferred<undefined>();
  function release(): void {
    read.resolve(undefined);
  }
  const answer = answerSignOut({ responder, request: taken, enabled, read: read.promise });
  answer.answered.catch((error: unknown) => {
    // Counted apart from how the sign-out ended, which a failed answer leaves unchanged.
    reportWalletFailure(error, {
      what: 'sign-out window answer',
      step: 'session_window_signout',
      reason: 'answer',
      metric: sessionWindowSignoutResultMetric,
    });
  });
  // The sign-out runs whether or not the round is answered.
  const signedOut = runSignOut({ taken, enabled, notified, read: release, firstParty: answer.firstParty });
  // A window that never booted reads nothing, so its end releases the page as well.
  signedOut.then(release, release);
  await signedOut;
}

/** Boots the sign-out window's core and signs out on it, calling `read` once it read the main store. */
async function runSignOut({ taken, enabled, notified, read, firstParty }: RunSignOutParams): Promise<void> {
  const { bridge } = await startHost({
    bootFlowId: createRandomId(),
    ...getWindowHostParams('signout-window', bootNetwork(taken, enabled)),
  }).catch((error: unknown) => {
    // Counted beside the window's own results, so every window opened counts how its sign-out ended. The boot
    // failure reports its own.
    sessionWindowSignoutResultMetric.count({ outcome: 'error', reason: notified ? 'notified' : 'unnotified' });
    throw error;
  });
  bootReport.log.event('Route: sign-out window', { notified });
  await signOutInWindow({
    notified,
    ...bridge.windowSignOut,
    read,
    firstParty,
    forgetGrants: () => siteGrants.forgetAll(),
    close: closeWindow,
    showSignedOut() {
      sessionWindowState.setScreen({ view: 'signed-out' });
    },
  });
}

/**
 * Starts the sign-in flow for `flow.intent`, whose views name the page by `flow.pageLabel` and which hands what the
 * store holds to `flow.deliver`, on the window's own store and core.
 */
function startFlow(
  bridge: HostBridge,
  flow: Pick<WindowFlowParams, 'responder' | 'intent' | 'pageLabel' | 'deliver' | 'close'>,
): WindowFlow {
  const started = createWindowFlow({
    auth: authState.store,
    commands: bridge.authCommands,
    signOut: bridge.pageSignOut,
    ...bridge.windowStore,
    loadPhrase: loadRecoveryPhrase,
    ...flow,
  });
  sessionWindowState.setWindowIntents(started);
  return started;
}

/** Shows the sign-in flow for `intent`, which delivers to the responder's opener. */
function openFlow({ responder, intent, bridge }: OpenFlowParams): void {
  // The flow lives as long as the window's page, so nothing disposes it.
  const { screen } = startFlow(bridge, {
    responder,
    intent,
    // dot.li's own pages are named by their host.
    pageLabel: origin => new URL(origin).host,
    deliver(result: SessionResult) {
      // Now, or with the next vetting of a window restored from the back-forward cache meanwhile.
      responder.send(result);
    },
    close: closeWindow,
  });
  sessionWindowState.showScreen(screen);
}

// One per page, so the suffix list loads at most once, and only for a site that asks for a group.
const siteGroups = createSiteGroups({
  listUrl: publicSuffixListUrl,
  // Wrapped, since the page's `fetch` throws when called as a method of another object.
  fetch: (input, init) => fetch(input, init),
});

/** Returns a fresh site token, unpadded base64url. */
function createSiteToken(): string {
  return base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(SITE_TOKEN_BYTES)));
}

/**
 * What a site's round in the window runs on, for the vetted origin `round` carries, whatever its route. `close` closes
 * the window once the round is done, and does nothing where the round's answer itself ends the page. `account` is the
 * product account the window's core serves as, or `null` for dot.li's own.
 */
function getSiteWindowParams({
  responder,
  round,
  account,
  close,
}: GetSiteWindowParamsParams): Omit<SiteWindowParams, 'request'> {
  const { booted: bridge } = round;
  // Before the round starts, so the first core the window boots runs as the right product: the named account's for a
  // transaction, and dot.li's own for a sign-in, which names no account.
  bridge.serveSite(account);
  return {
    origin: round.origin,
    responder,
    createWindowFlow: flow => startFlow(bridge, flow),
    grants: siteGrants,
    groups: siteGroups,
    self: window.location.origin,
    mainAccount: signal => bridge.mainAccount.read(signal),
    now: Date.now,
    randomToken: createSiteToken,
    close,
  };
}

/**
 * Runs a site's sign-in for the vetted origin the round carries, and shows its views until the returned function
 * stops it.
 */
function openSiteFlow({ responder, round, close }: OpenSiteFlowParams): () => void {
  // The site window lives as long as the window's page, so nothing disposes it.
  const { site, screen } = openSiteSignIn({
    ...getSiteWindowParams({ responder, round, account: null, close }),
    request: round.request,
  });
  sessionWindowState.setSiteIntents(site);
  return sessionWindowState.showScreen(screen);
}

/**
 * Runs a site's transaction for the vetted origin the round carries, and shows its views once the window has the
 * site's call. Until then the responder's view stays, which `stopShowingResponder` ends.
 */
async function openSiteTransactionFlow({
  responder,
  round,
  stopShowingResponder,
}: OpenSiteTransactionFlowParams): Promise<void> {
  const { booted: bridge } = round;
  // The site window lives as long as the window's page, so nothing disposes it.
  const opened = await openSiteTransaction({
    ...getSiteWindowParams({ responder, round, account: round.request.account, close: closeWindow }),
    request: round.request,
    chain: bridge.siteChain,
    txSigner: bridge.siteTxSigner,
    accountReader: bridge.siteAccountReader,
  });
  // A refused round keeps showing the responder, which says it refused, while the window closes.
  if (opened === null) {
    return;
  }
  stopShowingResponder();
  sessionWindowState.setSiteIntents(opened.site);
  sessionWindowState.showScreen(opened.screen);
}

/** Shows where the responder stands until the returned function stops it. */
function showResponder(responder: Responder<unknown>): () => void {
  sessionWindowState.setScreen(getResponderScreen(responder.state.get()));
  return responder.state.listen(state => {
    sessionWindowState.setScreen(getResponderScreen(state));
  });
}

async function bootSignIn(taken: SessionRequest, enabled: readonly Network[]): Promise<HostBridge> {
  const { bridge } = await startHost({
    bootFlowId: createRandomId(),
    ...getWindowHostParams('signin-window', bootNetwork(taken, enabled)),
  });
  bootReport.log.event('Route: session window');
  return bridge;
}

/**
 * A site's sign-in by redirect, for a site that cannot keep a popup. Until vetting passed, the return address is not
 * trusted, so the window answers nothing and only says why. Once it passed, the window boots and answers the round
 * once, sealed in the return address's fragment, and that navigation ends the page, so the round never closes it.
 */
async function redirectSignIn({ taken, enabled, fields }: RedirectSignInParams): Promise<void> {
  sessionWindowState.setScreen(getResponderScreen({ kind: 'connecting' }));
  const verdict = await vetRedirect(fields, {
    self: window.location.origin,
    probe: sitePublicKey => probeSeal(sitePublicKey),
    // Wrapped, since the page's `fetch` throws when called as a method of another object. The deadline keeps a site
    // that never answers from leaving the window on Connecting.
    checkReturnTo: url =>
      checkReturnTo(url, { fetch: (input, init) => fetch(input, init), signal: AbortSignal.timeout(10_000) }),
  });
  if (!verdict.ok) {
    const { view, reason } = verdict;
    walletReport.log.event('redirect sign-in refused', { reason });
    SITE_ROUTE_METRICS.auth.count({ outcome: 'refused', reason });
    sessionWindowState.setScreen(view === 'refused' ? getResponderScreen({ kind: 'refused' }) : { view });
    return;
  }
  // Stops showing the round's screen once the round opened, and does nothing before.
  let stopShowingRound = (): void => undefined;
  // The responder lives as long as the window's page, so nothing disposes it.
  const responder = createRedirectResponder({
    origin: verdict.origin,
    fields,
    round: taken.round,
    seal: sealRedirect,
    forgetRequest() {
      forgetWindowRequest(pageSessionStorage);
    },
    navigate(url) {
      location.replace(url);
    },
    failed(error, siteToken) {
      reportWalletFailure(error, {
        what: 'redirect answer',
        step: 'site_redirect',
        reason: 'seal',
        metric: SITE_ROUTE_METRICS.auth,
      });
      stopShowingRound();
      sessionWindowState.setScreen({ view: 'site-unsupported' });
      if (siteToken !== undefined) {
        void forgetUnsentGrant(siteToken);
      }
    },
  });
  sessionWindowState.setCloseIntent(() => {
    // Closing or going back in history while the sealed answer is on its way would leave the site unanswered.
    const delivery = responder.delivery();
    if (delivery !== 'sealing' && delivery !== 'sent') {
      closeWindow();
    }
  });
  const round = await answerSignIn({ responder, request: taken, enabled, booted: bootSignIn(taken, enabled) });
  // A site's round on the sign-in route is its sign-in, or one the dispatch refused, which the responder answered.
  if (round?.party !== 'third') {
    return;
  }
  stopShowingRound = openSiteFlow({ responder, round, close: () => undefined });
}

/** Forgets the grant of a redirect answer that never reached the site, unless the round keeps it. Never rejects. */
async function forgetUnsentGrant(token: string): Promise<void> {
  try {
    const grant = await siteGrants.read(token);
    if (grant !== null && isUnsentGrantForgotten(grant)) {
      await siteGrants.forget(token);
    }
  } catch (error) {
    reportWalletFailure(error, {
      what: 'redirect unsent grant forget',
      step: 'site_redirect',
      reason: 'grant_forget',
      metric: SITE_ROUTE_METRICS.auth,
    });
  }
}

async function signIn(taken: SessionRequest, enabled: readonly Network[]): Promise<void> {
  // A redirect runs with or without an opener, and starts no popup responder.
  if (taken.route === 'auth') {
    const fields = readRedirectFields(taken.params);
    if (fields === 'invalid') {
      bootReport.log.event('Session window refused: invalid redirect fields');
      sessionWindowState.setScreen(getResponderScreen({ kind: 'refused' }));
      return;
    }
    if (fields !== 'none') {
      await redirectSignIn({ taken, enabled, fields });
      return;
    }
  }
  // Before the boot, so the handshake runs while the frame comes up. Until the window knows the flow it runs, it shows
  // Connecting. The responder lives as long as the window's page, so nothing disposes it.
  const responder = startPageResponder<unknown>(taken.round, judgeOpener);
  if (responder.state.get().kind === 'no-opener') {
    // No hello names a party, so the request is read at once as dot.li's own.
    const request = parseWindowRequest(taken);
    if (request?.route !== 'auth') {
      refuseUnreadable();
      return;
    }
    const stopShowingResponder = showResponder(responder);
    const bridge = await bootSignIn(taken, enabled);
    stopShowingResponder();
    openFlow({ responder, intent: request.intent, bridge });
    return;
  }

  const stopShowingResponder = showResponder(responder);
  // A refused round keeps showing the responder, which says it refused.
  const round = await answerSignIn({ responder, request: taken, enabled, booted: bootSignIn(taken, enabled) });
  if (round === null) {
    return;
  }
  if (round.party === 'third-sign') {
    // Waiting for the site's call shows Connecting, whose Close closes the window.
    await openSiteTransactionFlow({ responder, round, stopShowingResponder });
    return;
  }
  stopShowingResponder();
  if (round.party === 'first') {
    openFlow({ responder, intent: round.intent, bridge: round.booted });
  } else {
    openSiteFlow({ responder, round, close: closeWindow });
  }
}

/** Lists the sites the user signed in to, each with Revoke. */
function manageSites(): void {
  bootReport.log.event('Route: site list');
  const list = createSiteList({ grants: siteGrants });
  sessionWindowState.setSiteListIntents(list);
  sessionWindowState.showScreen(list.screen);
}

async function main(): Promise<void> {
  // No page may frame the window, and one that tried gets nothing from it, not even the page start.
  if (window.self !== window.top) {
    return;
  }
  // The site list carries no request, so it reads none and keeps none.
  if (getRoute(location.pathname) === 'manage') {
    startPage({ desktopOffer: false });
    manageSites();
    return;
  }
  // A page that puts a new request in this window's fragment gets a fresh load for it. The watch lasts the page's life,
  // so its stop goes unused.
  watchNewRequests({
    pathname: location.pathname,
    listen: handler => listen({ target: window, type: 'hashchange', handler }),
    hash: () => location.hash,
    storage: pageSessionStorage,
    reload() {
      location.reload();
    },
  });
  const request = takeWindowRequest({
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    storage: pageSessionStorage,
    replaceUrl(url) {
      history.replaceState(history.state, '', url);
    },
  });
  startPage({ desktopOffer: false });

  // A window with no request has no round to answer, so it listens to nobody.
  if (request === null) {
    refuseUnreadable();
    return;
  }
  const enabled = getEnabledNetworks();
  if (request.route === 'signout') {
    await signOut(request, enabled);
    return;
  }
  await signIn(request, enabled);
}

main().catch(reportBootFailure);
