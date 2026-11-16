// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getNetwork } from '@dotli/config';
import { getProtocolOrigin } from '@dotli/protocol';
import { listenForPageReturn } from '@dotli/shared';
import { getSignInSurface, sessionPresence, type PageRole } from '../account/index.js';
import { createSessionHandoff, type SessionHandoff } from './createSessionHandoff.js';
import { listenToMessages } from './listenToMessages.js';

let pageHandoff: SessionHandoff | undefined;

/** The page's handoff when `role` signs in through the sign-in window, else null for a page that pairs in place. */
export function getPageSignInHandoff(role: PageRole): SessionHandoff | null {
  return getSignInSurface(role) === 'window' ? getPageSessionHandoff() : null;
}

/** The page's one handoff, built on first use, so importing the module reads no page globals. */
function getPageSessionHandoff(): SessionHandoff {
  pageHandoff ??= createSessionHandoff({
    open: (url, name) => window.open(url, name),
    listen: listenToMessages,
    onReturn: listener => listenForPageReturn({ visibility: document, target: window, handler: listener }),
    randomId: () => crypto.randomUUID(),
    windowOrigin: getProtocolOrigin(),
    network: getNetwork,
    presence: sessionPresence,
  });
  return pageHandoff;
}
