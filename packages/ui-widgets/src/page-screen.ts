// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A full-page screen whose view loads in a lazy chunk, with a text version for when it cannot. Both apps' boot imports
// this, so it imports no Solid.

import { disposeContentRoots, registerAppRoot, type Reporter } from '@dotli/ui-core';

/** Where a screen shows: the page's `#app`, or the body of a page without one. */
export interface PageSlot {
  app: HTMLElement;
  /** No `#app` frames the screen, so it fills the body itself. */
  standalone: boolean;
}

/** What a screen's view mounts with: its slot and the content root it registers as. */
export interface ScreenSlot extends PageSlot {
  root: string;
  report: Reporter;
  /** Shows the text version once a view that broke while rendering is gone. */
  onBroken: () => void;
}

export interface PageScreen<M> {
  /** The app root the screen registers as, so a later full-page screen takes it down. */
  root: string;
  load: () => Promise<M>;
  /** Mounts the view through `mountScreen`. */
  mount: (module: M, slot: ScreenSlot) => void;
  /** Puts the screen in the slot as text alone, built without the chunk, and returns what it put there. */
  fallback: (slot: PageSlot) => HTMLElement;
  /** Takes a chunk that failed to load and a view that broke while rendering. */
  report: Reporter;
}

/**
 * Takes the page's content roots down at once, then shows the screen's view, or its text version when the chunk cannot
 * load. Never rejects. A full-page screen shown before this one's chunk arrives takes it down, so it never mounts.
 */
export async function showPageScreen<M>(screen: PageScreen<M>): Promise<void> {
  const { root, report } = screen;
  disposeContentRoots();
  // Read now, since the page this screen replaces may be gone by the time the chunk arrives.
  const app = document.getElementById('app') ?? document.body;
  const page: PageSlot = { app, standalone: app === document.body };
  const showText = (): void => {
    const shown = screen.fallback(page);
    registerAppRoot(
      root,
      () => {
        shown.remove();
      },
      report.failure,
      { content: true },
    );
  };
  // The screen is the page's content from now on. Its view replaces this root when it mounts.
  const pending = new AbortController();
  registerAppRoot(
    root,
    () => {
      pending.abort();
    },
    report.failure,
    { content: true },
  );
  let module: M;
  try {
    module = await screen.load();
  } catch (err: unknown) {
    report.failure(err, { flow: 'ui', step: 'root_load', tags: { root, kind: `${root}_load_error` } });
    if (!pending.signal.aborted) {
      showText();
    }
    return;
  }
  if (!pending.signal.aborted) {
    screen.mount(module, { ...page, root, report, onBroken: showText });
  }
}
