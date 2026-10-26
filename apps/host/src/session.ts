// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The session window's entry. It reads the request the page put in its URL, answers the page that opened it, and boots
// the protocol frame and the bridge on its own settings. The sign-in window boots session state with a core that only
// pairs, so nothing it does switches wallet mode or reloads the page. Once the first hello named the opener's party, it
// runs its flow for dot.li's own page, or a site's sign-in or transaction, which takes the main session through that
// same flow. A site's sign-in by redirect needs no opener: the window vets the return address the request names, and
// answers the round once, sealed in that address. The sign-out window answers its opener's hello too, but boots no
// session state, so its own flow reads the stored session first, and its steps never wait on the opener. The site list
// answers no page and boots nothing: it reads only the grants the main store keeps.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { defaultNetwork, getEnabledNetworks, isSharedWorkerAvailable, type Network } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { deferred, listen, log, pageLocalStorage, pageSessionStorage, randomId } from '@dotli/shared';
import { siteGrants } from '@dotli/storage';
import { base64urlnopad } from '@scure/base';
import {
  parseWindowRequest,
  type SIGNED_OUT_RESULT,
  type SessionResult,
  type SignInIntent,
} from './runtime/session-handoff/messages.js';
import { openerParty, type OpenerParty } from './runtime/session-handoff/opener-rule.js';
import type { PageRole } from './runtime/page-role.js';
import { startPageResponder, type Responder } from './runtime/session-handoff/responder.js';
import { answerSignIn, answerSignOut, type SignInRound } from './runtime/session-handoff/round-answer.js';
import { routeOfPath, type SessionRequest } from './runtime/session-handoff/session-protocol.js';
import { forgetWindowRequest, takeWindowRequest, watchNewRequests } from './runtime/session-handoff/window-request.js';
import { closeWindow } from './session-window-page.js';
import { reportWalletFailure } from './runtime/wallet-failure.js';
import { loadRecoveryPhrase, type BridgeModule } from './lazy.js';
import {
  createWindowFlow,
  responderScreen,
  type WindowFlow,
  type WindowFlowDeps,
} from './runtime/session-handoff/window-flow.js';
import { signOutInWindow, type WindowSignOutDeps } from './runtime/session-handoff/window-signout.js';
import publicSuffixListUrl from './runtime/site-sign-in/public-suffix-list.dat?url';
import { createSiteGroups } from './runtime/site-sign-in/site-groups.js';
import { createSiteList } from './runtime/site-sign-in/site-list.js';
import { createRedirectResponder } from './runtime/site-sign-in/redirect-responder.js';
import { vetRedirect } from './runtime/site-sign-in/site-redirect.js';
import { readRedirectFields, SITE_TOKEN_BYTES, type RedirectFields } from './runtime/site-sign-in/site-request.js';
import { checkReturnTo } from './runtime/site-sign-in/site-return.js';
import { sealProbe, sealRedirect } from './runtime/site-sign-in/site-seal.js';
import { forgetsUnsentGrant } from './runtime/site-sign-in/site-round.js';
import type { SiteSubmissions } from './runtime/site-sign-in/site-transaction.js';
import { openSiteSignIn, openSiteTransaction, type SiteWindowDeps } from './runtime/site-sign-in/site-window.js';
import { authStore } from './runtime/state/auth.js';
import { windowSettings } from './session-settings.js';
import {
  setCloseIntent,
  setSiteIntents,
  setSiteListIntents,
  setWindowIntents,
  setWindowScreen,
  showWindowScreen,
} from './state/session-window.js';
import { reportBootFailure, startHost, startPage, type StartHostOptions } from './startup.js';

/** The sign-in window restores and pairs, while the sign-out window ends the stored session on a core of its own. */
function windowHostOptions(
  role: Extract<PageRole, 'signin-window' | 'signout-window'>,
  net: Network,
): StartHostOptions {
  return {
    role,
    settings: windowSettings(net, pageLocalStorage, isSharedWorkerAvailable()),
  };
}

/** The network a window boots on: its request's when this deployment runs it, else the default. */
function bootNetwork(request: SessionRequest, enabled: readonly Network[]): Network {
  return enabled.find(net => net === request.net) ?? defaultNetwork();
}

/** The party of a hello's origin, dot.li's own page or a site, or why it has none. */
function judgeOpener(origin: string): OpenerParty {
  return openerParty(origin, window.location.origin);
}

/** A request the window cannot read as dot.li's own has no round it answers, so it listens to nobody. */
function refuseUnreadable(): void {
  log.event('Session window refused: no readable request', { flow: 'boot' });
  setWindowScreen(responderScreen({ kind: 'refused' }));
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
  setWindowScreen({ view: 'signing-out' });
  // Before the boot, so the handshake runs while the frame comes up. A refused opener leaves the sign-out views as
  // they are.
  const responder = startPageResponder<typeof SIGNED_OUT_RESULT>(request.round, judgeOpener);
  const read = deferred<undefined>();
  const release = (): void => {
    read.resolve(undefined);
  };
  const answer = answerSignOut({ responder, request: taken, enabled, read: read.promise });
  answer.answered.catch((error: unknown) => {
    // Counted apart from how the sign-out ended, which a failed answer leaves unchanged.
    reportWalletFailure(error, {
      what: 'sign-out window answer',
      step: 'session_window_signout',
      reason: 'answer',
      metric: S.SESSION_WINDOW_SIGNOUT_RESULT,
    });
  });
  // The sign-out runs whether or not the round is answered.
  const signedOut = runSignOut(taken, enabled, { notified, read: release, firstParty: answer.firstParty });
  // A window that never booted reads nothing, so its end releases the page as well.
  signedOut.then(release, release);
  await signedOut;
}

/** Boots the sign-out window's core and signs out on it, calling `read` once it read the main store. */
async function runSignOut(
  taken: SessionRequest,
  enabled: readonly Network[],
  { notified, read, firstParty }: Pick<WindowSignOutDeps, 'notified' | 'read' | 'firstParty'>,
): Promise<void> {
  const { bridgeModule } = await startHost(
    randomId(),
    windowHostOptions('signout-window', bootNetwork(taken, enabled)),
  ).catch((error: unknown) => {
    // Counted beside the window's own results, so every window opened counts how its sign-out ended. The boot
    // failure reports its own.
    m.count(S.SESSION_WINDOW_SIGNOUT_RESULT, { outcome: 'error', reason: notified ? 'notified' : 'unnotified' });
    throw error;
  });
  log.event('Route: sign-out window', { flow: 'boot', notified });
  await signOutInWindow({
    notified,
    ...bridgeModule.windowSignOut,
    read,
    firstParty,
    forgetGrants: () => siteGrants.forgetAll(),
    close: closeWindow,
    showSignedOut: () => {
      setWindowScreen({ view: 'signed-out' });
    },
  });
}

/**
 * Starts the sign-in flow for `flow.intent`, whose views name the page by `flow.pageLabel` and which hands what the
 * store holds to `flow.deliver`, on the window's own store and core.
 */
function startFlow(
  bridgeModule: BridgeModule,
  flow: Pick<WindowFlowDeps, 'responder' | 'intent' | 'pageLabel' | 'deliver' | 'close'>,
): WindowFlow {
  const started = createWindowFlow({
    auth: authStore,
    commands: bridgeModule.authCommands,
    ...bridgeModule.windowStore,
    loadPhrase: loadRecoveryPhrase,
    ...flow,
  });
  setWindowIntents(started);
  return started;
}

/** Shows the sign-in flow for `intent`, which delivers to the responder's opener. */
function openFlow(responder: Responder<unknown>, intent: SignInIntent, bridgeModule: BridgeModule): void {
  const { screen } = startFlow(bridgeModule, {
    responder,
    intent,
    // dot.li's own pages are named by their host.
    pageLabel: origin => new URL(origin).host,
    deliver: (result: SessionResult) => {
      // Now, or with the next vetting of a window restored from the back-forward cache meanwhile.
      responder.send(result);
    },
    close: closeWindow,
  });
  showWindowScreen(screen);
}

// One per page, so the suffix list loads at most once, and only for a site that asks for a group.
const siteGroups = createSiteGroups({
  listUrl: publicSuffixListUrl,
  // Wrapped, since the page's `fetch` throws when called as a method of another object.
  fetch: (input, init) => fetch(input, init),
});

const SUBMITTED_KEY = 'dotli:s:submitted:';

/** The rounds this tab submitted a transaction for, kept in its session storage, which outlives a reload. */
const submittedRounds: SiteSubmissions = {
  has: round => pageSessionStorage.getItem(SUBMITTED_KEY + round) !== null,
  mark: round => {
    pageSessionStorage.setItem(SUBMITTED_KEY + round, '1');
  },
};

/** A fresh site token, unpadded base64url. */
function newSiteToken(): string {
  return base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(SITE_TOKEN_BYTES)));
}

/**
 * What a site's round in the window runs on, for the vetted origin `round` carries, whatever its route. `close` closes
 * the window once the round is done, and does nothing where the round's answer itself ends the page.
 */
function siteWindowDeps(
  responder: Responder<unknown>,
  round: Extract<SignInRound<BridgeModule>, { party: 'third' | 'third-sign' }>,
  close: () => void,
): Omit<SiteWindowDeps, 'request' | 'net'> {
  const { booted: bridgeModule } = round;
  return {
    origin: round.origin,
    responder,
    createWindowFlow: flow => startFlow(bridgeModule, flow),
    grants: siteGrants,
    groups: siteGroups,
    self: window.location.origin,
    signer: bridgeModule.siteSigner,
    auth: authStore,
    readUiCache: bridgeModule.windowStore.store.readUiCache,
    now: Date.now,
    randomToken: newSiteToken,
    close,
  };
}

/**
 * Runs a site's sign-in for the vetted origin the round carries, and shows its views until the returned function
 * stops it.
 */
function openSiteFlow(
  responder: Responder<unknown>,
  round: Extract<SignInRound<BridgeModule>, { party: 'third' }>,
  close: () => void,
): () => void {
  const { site, screen } = openSiteSignIn({
    ...siteWindowDeps(responder, round, close),
    net: round.net,
    request: round.request,
  });
  setSiteIntents(site);
  return showWindowScreen(screen);
}

/**
 * Runs a site's transaction for the vetted origin the round carries, and shows its views once the window has the
 * site's call. Until then the responder's view stays, which `stopShowingResponder` ends.
 */
async function openSiteTransactionFlow(
  responder: Responder<unknown>,
  round: Extract<SignInRound<BridgeModule>, { party: 'third-sign' }>,
  stopShowingResponder: () => void,
): Promise<void> {
  const { booted: bridgeModule } = round;
  const opened = await openSiteTransaction({
    ...siteWindowDeps(responder, round, closeWindow),
    request: round.request,
    chain: bridgeModule.siteChain,
    txSigner: bridgeModule.siteTxSigner,
    submitted: submittedRounds,
  });
  // A refused round keeps showing the responder, which says it refused, while the window closes.
  if (opened === null) {
    return;
  }
  stopShowingResponder();
  setSiteIntents(opened.site);
  showWindowScreen(opened.screen);
}

/** Shows where the responder stands until the returned function stops it. */
function showResponder(responder: Responder<unknown>): () => void {
  setWindowScreen(responderScreen(responder.state()));
  return responder.subscribe(state => {
    setWindowScreen(responderScreen(state));
  });
}

async function bootSignIn(taken: SessionRequest, enabled: readonly Network[]): Promise<BridgeModule> {
  const { bridgeModule } = await startHost(randomId(), windowHostOptions('signin-window', bootNetwork(taken, enabled)));
  log.event('Route: session window', { flow: 'boot' });
  return bridgeModule;
}

/**
 * A site's sign-in by redirect, for a site that cannot keep a popup. Until vetting passed, the return address is not
 * trusted, so the window answers nothing and only says why. Once it passed, the window boots and answers the round
 * once, sealed in the return address's fragment, and that navigation ends the page, so the round never closes it.
 */
async function redirectSignIn(
  taken: SessionRequest,
  enabled: readonly Network[],
  fields: RedirectFields,
): Promise<void> {
  setWindowScreen(responderScreen({ kind: 'connecting' }));
  const verdict = await vetRedirect(fields, {
    self: window.location.origin,
    probe: pub => sealProbe(pub),
    // Wrapped, since the page's `fetch` throws when called as a method of another object. The deadline keeps a site
    // that never answers from leaving the window on Connecting.
    checkReturnTo: url =>
      checkReturnTo(url, { fetch: (input, init) => fetch(input, init), signal: AbortSignal.timeout(10_000) }),
  });
  if (!verdict.ok) {
    const { view, reason } = verdict;
    log.event('redirect sign-in refused', { flow: 'wallet', reason });
    m.count(S.SITE_SIGN_IN, { outcome: 'refused', reason });
    setWindowScreen(view === 'refused' ? responderScreen({ kind: 'refused' }) : { view });
    return;
  }
  // Stops showing the round's screen once the round opened, and does nothing before.
  let stopShowingRound = (): void => undefined;
  const responder = createRedirectResponder({
    origin: verdict.origin,
    returnTo: fields.returnTo,
    pub: fields.pub,
    round: taken.round,
    seal: sealRedirect,
    forgetRequest: () => {
      forgetWindowRequest(pageSessionStorage);
    },
    navigate: url => {
      location.replace(url);
    },
    failed: (error, siteToken) => {
      reportWalletFailure(error, {
        what: 'redirect answer',
        step: 'site_redirect',
        reason: 'seal',
        metric: S.SITE_SIGN_IN,
      });
      stopShowingRound();
      setWindowScreen({ view: 'site-unsupported' });
      if (siteToken !== undefined) {
        void forgetUnsentGrant(siteToken);
      }
    },
  });
  setCloseIntent(() => {
    // Closing or going back in history while the sealed answer is on its way would leave the site unanswered.
    const delivery = responder.delivery();
    if (delivery !== 'pending' && delivery !== 'sent') {
      closeWindow();
    }
  });
  const round = await answerSignIn({ responder, request: taken, enabled, booted: bootSignIn(taken, enabled) });
  // A site's round on the sign-in route is its sign-in, or one the dispatch refused, which the responder answered.
  if (round?.party !== 'third') {
    return;
  }
  stopShowingRound = openSiteFlow(responder, round, () => undefined);
}

/** Forgets the grant of a redirect answer that never reached the site, unless the round keeps it. Never rejects. */
async function forgetUnsentGrant(token: string): Promise<void> {
  try {
    const grant = await siteGrants.read(token);
    if (grant !== null && forgetsUnsentGrant(grant)) {
      await siteGrants.forget(token);
    }
  } catch (error) {
    reportWalletFailure(error, {
      what: 'redirect unsent grant forget',
      step: 'site_redirect',
      reason: 'grant_forget',
      metric: S.SITE_SIGN_IN,
    });
  }
}

async function signIn(taken: SessionRequest, enabled: readonly Network[]): Promise<void> {
  // A redirect runs with or without an opener, and starts no popup responder.
  if (taken.route === 'auth') {
    const fields = readRedirectFields(taken.params);
    if (fields === 'invalid') {
      log.event('Session window refused: invalid redirect fields', { flow: 'boot' });
      setWindowScreen(responderScreen({ kind: 'refused' }));
      return;
    }
    if (fields !== 'none') {
      await redirectSignIn(taken, enabled, fields);
      return;
    }
  }
  // Before the boot, so the handshake runs while the frame comes up. Until the window knows the flow it runs, it shows
  // Connecting.
  const responder = startPageResponder<unknown>(taken.round, judgeOpener);
  if (responder.state().kind === 'no-opener') {
    // No hello names a party, so the request is read at once as dot.li's own.
    const request = parseWindowRequest(taken);
    if (request?.route !== 'auth') {
      refuseUnreadable();
      return;
    }
    const stopShowingResponder = showResponder(responder);
    const bridgeModule = await bootSignIn(taken, enabled);
    stopShowingResponder();
    openFlow(responder, request.intent, bridgeModule);
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
    await openSiteTransactionFlow(responder, round, stopShowingResponder);
    return;
  }
  stopShowingResponder();
  if (round.party === 'first') {
    openFlow(responder, round.intent, round.booted);
  } else {
    openSiteFlow(responder, round, closeWindow);
  }
}

/** Lists the sites the user signed in to, each with Revoke. */
function manageSites(): void {
  log.event('Route: site list', { flow: 'boot' });
  const list = createSiteList({ grants: siteGrants });
  setSiteListIntents(list);
  showWindowScreen(list.screen);
}

async function main(): Promise<void> {
  // No page may frame the window, and one that tried gets nothing from it, not even the page start.
  if (window.self !== window.top) {
    return;
  }
  // The site list carries no request, so it reads none and keeps none.
  if (routeOfPath(location.pathname) === 'manage') {
    startPage({ desktopOffer: false });
    manageSites();
    return;
  }
  // A page that puts a new request in this window's fragment gets a fresh load for it.
  watchNewRequests({
    pathname: location.pathname,
    listen: handler => listen(window, 'hashchange', handler),
    hash: () => location.hash,
    storage: pageSessionStorage,
    reload: () => {
      location.reload();
    },
  });
  const request = takeWindowRequest({
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    storage: pageSessionStorage,
    replaceUrl: url => {
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
