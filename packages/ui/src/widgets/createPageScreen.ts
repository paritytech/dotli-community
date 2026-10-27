// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What fills the page: its own content, or one full-page screen in its place. Both apps show their error page and
// their own screens through here, so a later screen always replaces an earlier one.

import type { JSX } from '@solidjs/web';
import { createSyncStore, registerStoreStateReset, type ReadableStore } from '@dotli/shared';
import { mountRoot } from '../mount/root.js';
import s from './pageScreen.module.css';

/** `screen` while a full-page screen holds the page. */
export type PageContent = 'page' | 'screen';

type Params = {
  /** The document a screen fills. The page's own without one, read on each `show`. */
  page?: Document | undefined;
};

/** Builds the page's screen slot over `page`. Building one never reads the document. */
export function createPageScreen({ page }: Params = {}) {
  const content = createSyncStore<PageContent>({ name: 'page-content', initial: 'page' });
  const store: ReadableStore<PageContent> = content;
  let disposeShown: (() => void) | undefined;

  registerStoreStateReset(clear);

  return {
    /** Whether the page's own content or a full-page screen fills the page. */
    store,
    /**
     * Shows `view` in place of the page's content: `#app`, or the body of a page without one, which the screen then
     * fills itself (`standalone`). The screen shown before goes first. The element marked `data-overlays` stays, so a
     * toast raised after the screen still shows. A view that throws is reported, never thrown.
     */
    show,
    /** Takes the shown screen down, for the page's own content to come back. Never throws. */
    clear,
  };

  function show(view: (standalone: boolean) => JSX.Element): void {
    disposeShown?.();
    const pageDocument = page ?? document;
    const app = pageDocument.getElementById('app') ?? pageDocument.body;
    const standalone = app === pageDocument.body;
    for (const node of [...app.childNodes]) {
      if (!(node instanceof Element && node.hasAttribute('data-overlays'))) {
        node.remove();
      }
    }
    // Its own element, so taking the screen down keeps what the page put beside it since, like the product frame.
    // Before the overlays, which stack and tab above it.
    const holder = pageDocument.createElement('div');
    holder.className = s['holder'] ?? '';
    app.prepend(holder);
    disposeShown = mountRoot({
      name: 'page-screen',
      container: holder,
      view: () => view(standalone),
      removeContainer: true,
    });
    content.set('screen');
  }

  function clear(): void {
    disposeShown?.();
    disposeShown = undefined;
    content.set('page');
  }
}

/** The page's screen slot, over the page's own document. */
export const pageScreen = createPageScreen();
