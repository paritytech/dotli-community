// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The screen the sandbox shows while it reloads a product whose connection dropped. Its view loads in a lazy chunk, and
// when that cannot load the same words show as text alone.

import type { Reporter } from '@dotli/ui-core';
import { showPageScreen, type PageSlot } from '@dotli/ui-widgets';
import { loadRetryScreen, type RetryScreenModule } from './lazy.js';
import { uiReporter } from './ui-reporter.js';
import s from './RetryScreen.module.css';

export const RETRY_STATUS = 'Retrying…';
export const RETRY_LINE = "The app's connection dropped, so it is starting again";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  ...classes: (string | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.classList.add(...classes.filter((c): c is string => c !== undefined));
  return node;
}

/** The screen in text alone, with no mark. */
function renderRetryText({ app, standalone }: PageSlot): HTMLElement {
  const screen = el('div', s['screen'], standalone ? s['standalone'] : undefined);
  screen.dataset['testid'] = 'retry-screen';
  const column = el('div', s['column']);
  const status = el('p', s['step']);
  status.id = 'status';
  status.textContent = RETRY_STATUS;
  const line = el('p', s['line']);
  line.textContent = RETRY_LINE;
  column.append(status, line);
  screen.append(column);
  app.replaceChildren(screen);
  return screen;
}

export interface RetryScreenDeps {
  load: () => Promise<RetryScreenModule>;
  /** Takes a view chunk that failed to load and a view that broke while rendering. */
  report: Reporter;
}

const pageDeps: RetryScreenDeps = { load: loadRetryScreen, report: uiReporter };

/** Settles once the screen shows. The page's content roots are disposed before it returns. */
export function showRetryScreen(deps: RetryScreenDeps = pageDeps): Promise<void> {
  return showPageScreen({
    root: 'retry-screen',
    load: deps.load,
    mount: ({ mountRetryScreen }, slot) => {
      mountRetryScreen(slot);
    },
    fallback: renderRetryText,
    report: deps.report,
  });
}
