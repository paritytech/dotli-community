// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The session window's entry. It reads the request the page put in its URL, answers the page that opened it, and boots
// the protocol frame and the bridge on its own settings. The sign-in window boots session state with a core that only
// pairs, so nothing it does switches wallet mode or reloads the page. The sign-out window answers its opener's hello
// too, but boots no session state, so its own flow reads the stored session first, and its steps never wait on the
// opener.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { isSharedWorkerAvailable, type Network } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { listen, log, pageLocalStorage, pageSessionStorage, randomId } from '@dotli/shared';
import { SIGNED_OUT_RESULT, type SessionResult, type WindowRequest } from './runtime/session-handoff/messages.js';
import type { PageRole } from './runtime/page-role.js';
import { startPageResponder } from './runtime/session-handoff/responder.js';
import { takeWindowRequest, watchNewRequests } from './runtime/session-handoff/window-request.js';
import { closeWindow } from './session-window-page.js';
import { loadRecoveryPhrase } from './lazy.js';
import { createWindowFlow, responderScreen } from './runtime/session-handoff/window-flow.js';
import { signOutInWindow } from './runtime/session-handoff/window-signout.js';
import { authStore } from './runtime/state/auth.js';
import { windowSettings } from './session-settings.js';
import { setWindowIntents, setWindowScreen, showWindowScreen } from './state/session-window.js';
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

/**
 * The page said all it had to in the request, so the window's steps wait for no hello and only tell the page it has
 * read the main store, with an empty result. The read goes out as soon as it is made, or once the opener is vetted.
 */
async function signOut(request: Extract<WindowRequest, { route: 'signout' }>): Promise<void> {
  const { notified } = request;
  setWindowScreen({ view: 'signing-out' });
  // Before the boot, so the handshake runs while the frame comes up. A refused opener leaves the sign-out views as
  // they are.
  const responder = startPageResponder<typeof SIGNED_OUT_RESULT>(request.round);
  const read = (): void => {
    responder.send(SIGNED_OUT_RESULT);
  };
  try {
    const { bridgeModule } = await startHost(randomId(), windowHostOptions('signout-window', request.net)).catch(
      (error: unknown) => {
        // Counted beside the window's own results, so they add up to the windows opened. The boot failure reports its
        // own.
        m.count(S.SESSION_WINDOW_SIGNOUT_RESULT, { outcome: 'error', reason: notified ? 'notified' : 'unnotified' });
        throw error;
      },
    );
    log.event('Route: sign-out window', { flow: 'boot', notified });
    await signOutInWindow({
      notified,
      ...bridgeModule.windowSignOut,
      read,
      close: closeWindow,
      showSignedOut: () => {
        setWindowScreen({ view: 'signed-out' });
      },
    });
  } finally {
    // A window that never booted reads nothing, so the page need not wait for it.
    read();
  }
}

async function signIn(request: Extract<WindowRequest, { route: 'auth' }>): Promise<void> {
  // Before the boot, so the handshake runs while the frame comes up. Until the boot ends there is no flow, and a
  // vetted round or a window with no opener waits on Connecting.
  const responder = startPageResponder<SessionResult>(request.round);
  setWindowScreen(responderScreen(responder.state()));
  const stopShowingResponder = responder.subscribe(state => {
    setWindowScreen(responderScreen(state));
  });

  const { bridgeModule } = await startHost(randomId(), windowHostOptions('signin-window', request.net));
  log.event('Route: session window', { flow: 'boot' });

  stopShowingResponder();
  const flow = createWindowFlow({
    responder,
    auth: authStore,
    commands: bridgeModule.authCommands,
    ...bridgeModule.windowStore,
    loadPhrase: loadRecoveryPhrase,
    intent: request.intent,
    close: closeWindow,
  });
  setWindowIntents(flow);
  showWindowScreen(flow.screen);
}

async function main(): Promise<void> {
  // No page may frame the window, and one that tried gets nothing from it, not even the page start.
  if (window.self !== window.top) {
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
    log.event('Session window refused: no readable request', { flow: 'boot' });
    setWindowScreen(responderScreen({ kind: 'refused' }));
    return;
  }
  if (request.route === 'signout') {
    await signOut(request);
    return;
  }
  await signIn(request);
}

main().catch(reportBootFailure);
