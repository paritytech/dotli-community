// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page that opens the sign-in window where a dotli page cannot: one that finds a sign-in already stored, since a
// signed-in dotli page never opens it in Chromium, or one on an origin the window refuses. It runs the pages' own
// handoff client, so the handshake is the real one, and marks the round's outcome and the window's last reply on its
// output.

import { isValidNetwork } from '@dotli/config/networks';
import { listenToMessages } from '../../../src/runtime/session-handoff/messages.js';
import { createSessionHandoff } from '../../../src/runtime/session-handoff/opener.js';

const net = new URLSearchParams(location.search).get('net') ?? '';
if (!isValidNetwork(net)) {
  throw new Error(`the opener fixture needs a known network in ?net, got ${JSON.stringify(net)}`);
}
const network = net;
const button = document.querySelector<HTMLButtonElement>('[data-testid="opener-sign-in"]');
const output = document.querySelector<HTMLOutputElement>('[data-testid="opener-outcome"]');
if (button === null || output === null) {
  throw new Error('the opener fixture page lacks its button or its output');
}

// The preview server serves the root origin on every page's port.
const windowOrigin = `${location.protocol}//localhost:${location.port}`;

const handoff = createSessionHandoff({
  open: (url, name) => window.open(url, name),
  listen: listenToMessages,
  // The test waits on the window's own messages, so a return to this page needs no check.
  onReturn: () => () => undefined,
  randomId: () => crypto.randomUUID(),
  windowOrigin,
  network: () => network,
  // The fixture only signs in, so no sign-out drops a flag.
  presence: { clear: () => Promise.resolve() },
});

// What the window posted last, as the keys it carried, so a test sees that a refusal carries only its round and a
// reason.
listenToMessages(event => {
  const data = event.data as Record<string, unknown> | null;
  if (event.origin !== windowOrigin || typeof data !== 'object' || data === null || data['type'] === 'dotli:s:ready') {
    return;
  }
  output.dataset['reply'] = Object.keys(data).sort().join(' ');
});

button.addEventListener('click', () => {
  void handoff.signIn('signin').then(outcome => {
    if (outcome.kind === 'result') {
      output.dataset['session'] = String(outcome.result.session !== null);
      output.dataset['wallet'] = String(outcome.result.localWallet !== null);
    }
    output.dataset['outcome'] = outcome.kind;
  });
});
