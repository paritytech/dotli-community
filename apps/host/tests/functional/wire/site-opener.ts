// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A third-party site that opens a session window as a site does: its request in the window URL's fragment, a hello for
// each ready the window says, and the window's last reply marked on its output by its type and reason, and by its
// result for a result. It speaks the wire protocol itself, as a site does, with nothing of dot.li's own pages.
// `?route=sign` asks for a transaction on the network's Asset Hub with the call and an account in the request, and any
// other route signs in with neither.

import { isValidNetwork, NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config/networks';
import { PROTOCOL_VERSION, requestUrl } from '../../../src/runtime/session-handoff/session-protocol.js';

const query = new URLSearchParams(location.search);
const net = query.get('net') ?? '';
if (!isValidNetwork(net)) {
  throw new Error(`the site fixture needs a known network in ?net, got ${JSON.stringify(net)}`);
}
const windowOrigin = query.get('window') ?? '';
if (!URL.canParse(windowOrigin)) {
  throw new Error(`the site fixture needs the window's origin in ?window, got ${JSON.stringify(windowOrigin)}`);
}
const button = document.querySelector<HTMLButtonElement>('[data-testid="opener-sign-in"]');
const output = document.querySelector<HTMLOutputElement>('[data-testid="site-reply"]');
if (button === null || output === null) {
  throw new Error('the site fixture page lacks its button or its output');
}

const route = query.get('route') === 'sign' ? 'sign' : 'auth';
const round = crypto.randomUUID();
// The window takes any hex of two or more bytes before it decodes it, which these rounds never reach.
const call = '0x000000';
let opened: Window | null = null;

window.addEventListener('message', event => {
  const data = event.data as Record<string, unknown> | null;
  if (event.origin !== windowOrigin || event.source !== opened || typeof data !== 'object' || data === null) {
    return;
  }
  if (data['type'] === 'dotli:s:ready') {
    opened?.postMessage({ type: 'dotli:s:hello', v: PROTOCOL_VERSION, round }, windowOrigin);
    return;
  }
  output.dataset['type'] = String(data['type']);
  output.dataset['reason'] = String(data['reason']);
  if (data['type'] === 'dotli:s:result') {
    output.dataset['result'] = JSON.stringify(data['result']);
  }
});

button.addEventListener('click', () => {
  // A sign-in names no account. `account=none` leaves the account out of a transaction, as a site that forgot it would.
  const params =
    route === 'sign'
      ? {
          v: PROTOCOL_VERSION,
          net,
          round,
          chain: NETWORK_NAME_TO_SERVICES_CONFIG[net].assethub.genesis,
          call,
          ...(query.get('account') === 'none'
            ? {}
            : { account: `myapp.${NETWORK_NAME_TO_SERVICES_CONFIG[net].dotns.TLD}/0` }),
        }
      : { v: PROTOCOL_VERSION, net, round };
  opened = window.open(requestUrl(windowOrigin, route, params), '_blank');
});
