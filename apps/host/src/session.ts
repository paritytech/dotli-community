// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in window's entry. It answers the page that opened it, and boots the protocol frame, the bridge and session
// state on its own settings, with a core that only pairs, so nothing it does switches wallet mode or reloads the page.
// A sign-out window answers no hello and boots no session state, so its own flow reads the stored session first.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { isSharedWorkerAvailable } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { deferred, log, pageLocalStorage, randomId } from '@dotli/shared';
import {
  SIGNED_OUT_READ,
  windowUrlIntent,
  windowUrlSignOut,
  type WindowHandle,
} from './runtime/session-handoff/messages.js';
import type { PageRole } from './runtime/page-role.js';
import { startPageResponder } from './runtime/session-handoff/responder.js';
import { closeWindow } from './session-window-page.js';
import { loadRecoveryPhrase } from './lazy.js';
import { createWindowFlow, responderScreen } from './runtime/session-handoff/window-flow.js';
import { signOutInWindow } from './runtime/session-handoff/window-signout.js';
import { authStore } from './runtime/state/auth.js';
import { windowSettings } from './session-settings.js';
import { setWindowIntents, setWindowScreen, showWindowScreen } from './state/session-window.js';
import { reportBootFailure, startHost, startPage, type StartHostOptions } from './startup.js';

/** The sign-in window restores and pairs, while the sign-out window ends the stored session on a core of its own. */
function windowHostOptions(role: Extract<PageRole, 'signin-window' | 'signout-window'>): StartHostOptions {
  return {
    role,
    settings: windowSettings(window.location.search, pageLocalStorage, isSharedWorkerAvailable()),
  };
}

/**
 * The page said all it had to in the URL, so the window waits for no hello and only tells the page it has read the
 * main store, a message that carries nothing. It says so once, as soon as it read, or as it ends without reading.
 */
async function signOut(notified: boolean): Promise<void> {
  setWindowScreen({ view: 'signing-out' });
  const opener = window.opener as WindowHandle | null;
  const told = deferred<undefined>();
  void told.promise.then(() => {
    opener?.postMessage(SIGNED_OUT_READ, '*');
  });
  const read = (): void => {
    told.resolve(undefined);
  };
  try {
    const { bridgeModule } = await startHost(randomId(), windowHostOptions('signout-window')).catch(
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

async function main(): Promise<void> {
  // No page may frame the window, and one that tried gets nothing from it, not even the page start.
  if (window.self !== window.top) {
    return;
  }
  startPage({ desktopOffer: false });

  const signOutUrl = windowUrlSignOut(window.location.search);
  if (signOutUrl !== null) {
    await signOut(signOutUrl.notified);
    return;
  }

  // Before the boot, so the handshake runs while the frame comes up. Until the boot ends there is no flow, and a
  // vetted round or a window with no opener waits on Connecting.
  const responder = startPageResponder();
  setWindowScreen(responderScreen(responder.state()));
  const stopShowingResponder = responder.subscribe(state => {
    setWindowScreen(responderScreen(state));
  });

  const { bridgeModule } = await startHost(randomId(), windowHostOptions('signin-window'));
  log.event('Route: session window', { flow: 'boot' });

  stopShowingResponder();
  const flow = createWindowFlow({
    responder,
    auth: authStore,
    commands: bridgeModule.authCommands,
    ...bridgeModule.windowStore,
    loadPhrase: loadRecoveryPhrase,
    urlIntent: windowUrlIntent(window.location.search),
    close: closeWindow,
  });
  setWindowIntents(flow);
  showWindowScreen(flow.screen);
}

main().catch(reportBootFailure);
