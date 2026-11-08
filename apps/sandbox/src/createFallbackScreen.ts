// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The failure screen for when the sandbox's own UI chunk cannot load. Its markup is static in the page, so it needs no
// chunk, and it is hidden until something shows it.

import { createReporter } from '@dotli/metrics';
import { APP_LOG_TAG } from './appLogTag.js';
import s from './createFallbackScreen.module.css';
import { appRunMetric } from './appRunMetric.js';

const report = createReporter({ flow: 'content' });

/** The part of `Document` the screen needs. */
export type FallbackPage = {
  /** The element of the page's static markup with `id`, or `null` when there is none. Never throws. */
  getElementById: (id: string) => FallbackElement | null;
};

/** The members of an element of the screen that the screen writes. */
type FallbackElement = Pick<HTMLElement, 'hidden' | 'className' | 'textContent'> & {
  /** Set to the Reload handler. The screen only writes it, so any click handler fits. */
  onclick: unknown;
};

type Params = {
  /** The page whose static markup holds the screen. */
  page: FallbackPage;
  /** What the screen's Reload button does. Never throws. */
  reload: () => void;
};

/** The screen's element in the page's static markup. */
const SCREEN_ID = 'sandbox-fallback';

/** The screen in `page`'s static markup, with a Reload button that calls `reload`. */
export function createFallbackScreen({ page, reload }: Params) {
  return {
    /**
     * Shows `text` with the Reload button. Calling it again replaces the text and keeps one Reload handler. Never
     * throws: a page without the markup is logged, captured and counted, since this screen is the last thing left to
     * show a failure with.
     */
    show,
    /** Hides the screen again. Safe when it is not shown or the page has no markup. Never throws. */
    hide,
  };

  function show(text: string): void {
    const section = page.getElementById(SCREEN_ID);
    const message = page.getElementById('sandbox-fallback-text');
    const button = page.getElementById('sandbox-fallback-reload');
    if (section === null || message === null || button === null) {
      const error = new Error('The sandbox page has no fallback screen');
      report.defect(error, {
        step: 'fallback_show',
        metric: appRunMetric,
        reason: 'fallback_missing',
        message: `${APP_LOG_TAG} Could not show the fallback screen`,
      });
      return;
    }
    section.className = s['screen'] ?? '';
    button.className = s['reload'] ?? '';
    message.textContent = text;
    button.onclick = reload;
    section.hidden = false;
  }

  function hide(): void {
    const section = page.getElementById(SCREEN_ID);
    if (section !== null) {
      section.hidden = true;
    }
  }
}
