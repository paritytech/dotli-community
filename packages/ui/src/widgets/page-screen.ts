// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What fills the page: its own content, or one full-page screen in its place. Both apps show their error page and
// their own screens through here, so a later screen always replaces an earlier one.

import type { JSX } from '@solidjs/web';
import { createSyncStore, registerStoreStateReset, type ReadableStore } from '@dotli/shared';
import { mountRoot } from '../mount/root.js';
import s from './page-screen.module.css';

/** `screen` while a full-page screen holds the page. */
export type PageContent = 'page' | 'screen';

const content = createSyncStore<PageContent>('page-content', 'page');
export const pageContentStore: ReadableStore<PageContent> = content;

let disposeShown: (() => void) | undefined;

/** Takes the shown screen down, for the page's own content to come back. */
export function clearScreen(): void {
  disposeShown?.();
  disposeShown = undefined;
  content.set('page');
}

registerStoreStateReset(clearScreen);

/**
 * Shows `view` in place of the page's content: `#app`, or the body of a page without one, which the screen then fills
 * itself (`standalone`). The screen shown before goes first. The element marked `data-overlays` stays, so a toast
 * raised after the screen still shows. A view that throws is reported.
 */
export function showScreen(view: (standalone: boolean) => JSX.Element): void {
  disposeShown?.();
  const app = document.getElementById('app') ?? document.body;
  const standalone = app === document.body;
  for (const node of [...app.childNodes]) {
    if (!(node instanceof Element && node.hasAttribute('data-overlays'))) {
      node.remove();
    }
  }
  // Its own element, so taking the screen down keeps what the page put beside it since, like the product frame.
  // Before the overlays, which stack and tab above it.
  const holder = document.createElement('div');
  holder.className = s['holder'] ?? '';
  app.prepend(holder);
  disposeShown = mountRoot('page-screen', holder, () => view(standalone), { removeContainer: true });
  content.set('screen');
}
