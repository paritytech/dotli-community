// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The failure screen for when the sandbox's own UI chunk cannot load. Its markup is static in the page, so it needs no
// chunk, and it is hidden until something shows it.

import { captureException, m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import s from './fallback-screen.module.css';

const contentLog = log.child({ flow: 'content' });

/** The part of `Document` the screen needs. */
export interface FallbackPage {
  getElementById: (id: string) => HTMLElement | null;
}

/**
 * Shows `text` with a Reload button. Calling it again replaces the text and keeps one Reload handler. A page without
 * the markup is reported, since the caller is already handling a failure and has nothing left to show.
 */
export function showFallbackScreen(page: FallbackPage, text: string, reload: () => void): void {
  const section = page.getElementById('sandbox-fallback');
  const message = page.getElementById('sandbox-fallback-text');
  const button = page.getElementById('sandbox-fallback-reload');
  if (section === null || message === null || button === null) {
    const err = new Error('The sandbox page has no fallback screen');
    captureException(err, { flow: 'content', step: 'fallback_show' });
    contentLog.error('[dot.li app] Could not show the fallback screen', err);
    m.count(S.APP_RUN, { outcome: 'error', reason: 'fallback_missing' });
    return;
  }
  section.className = s['screen'] ?? '';
  button.className = s['reload'] ?? '';
  message.textContent = text;
  button.onclick = reload;
  section.hidden = false;
}

/** Hides the screen again once the page UI is up to show failures itself. */
export function hideFallbackScreen(page: FallbackPage): void {
  const section = page.getElementById('sandbox-fallback');
  if (section !== null) {
    section.hidden = true;
  }
}
