// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import { pinPageAboveKeyboard } from '@dotli/ui';

type Params = {
  /** The page's own by default. */
  document?: Pick<Document, 'querySelector'>;
};

const report = createReporter({ flow: 'landing_keyboard' });

/** A landing page that could not pin itself above the keyboard. Tagged `outcome` (error) and `reason`. */
const keyboardPinMetric = defineCount<'error'>('landing.keyboard_pin');

/**
 * Keeps the landing page in place while the keyboard is open for its name field. A box missing from the markup is
 * reported, and the page runs unpinned.
 */
export function startKeyboardPin({ document = globalThis.document }: Params = {}): void {
  const page = document.querySelector<HTMLElement>('[data-landing-page]');
  const scroller = document.querySelector<HTMLElement>('[data-landing-scroller]');
  if (!page || !scroller) {
    report.defect(new Error(`Landing box missing: page ${String(!!page)}, scroller ${String(!!scroller)}`), {
      step: 'find_boxes',
      metric: keyboardPinMetric,
      message: '[dot.li landing] Keyboard pin not started, a page box is missing',
    });
    return;
  }
  // The page lasts as long as the pin, so its stop goes unused.
  pinPageAboveKeyboard({ page, scroller });
}
