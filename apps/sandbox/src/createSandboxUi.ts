// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's own UI loads the first time something needs it: a toast, a failure, a retry or a password. A product
// that loads needs none of it, so the boot carries no Solid.

import { reportExpected, spans as S } from '@dotli/metrics';
import { createLazyLoad, type ReadableStore } from '@dotli/shared';
import { APP_LOG_TAG } from './appLogTag.js';
import type { PageUiModule } from './lazy.js';

type Params = {
  /** Loads the page UI chunk. Rejects when the chunk cannot load. */
  load: () => Promise<PageUiModule>;
  /** Toasts queue here before the UI is up, and show once it mounts. */
  toasts: ReadableStore<{ readonly items: readonly unknown[] }>;
  /** Says why the page stopped, with a Reload, when the UI itself cannot load. Never throws. */
  showFallback: (text: string) => void;
  /** Takes that screen away once a later load brings the UI up. Safe when it is not shown. Never throws. */
  hideFallback: () => void;
};

export type SandboxUi = ReturnType<typeof createSandboxUi>;

/** The sandbox's own UI, loaded the first time a toast, a failure or a retry needs it. */
export function createSandboxUi({ load, toasts, showFallback, hideFallback }: Params) {
  let disposed = false;
  const loadUi = createLazyLoad({
    load: async () => {
      const ui = await load();
      if (!disposed) {
        hideFallback();
        ui.mountOverlays();
      }
      return ui;
    },
    onFirstMiss: error => {
      // A missing chunk is a deploy race, so it is counted and not captured (owner's call).
      reportExpected(error, {
        flow: 'content',
        step: 'page_ui_load',
        metric: S.LAZY_CHUNK_LOAD,
        reason: 'page_ui_load',
        message: `${APP_LOG_TAG} the page UI failed to load`,
      });
    },
  });

  const unsubscribeToasts = toasts.subscribe(showQueued);
  showQueued();

  return {
    /**
     * Resolves with the UI once its overlays are mounted. One load at a time, and a failed load is not kept, so the
     * next call loads again. Rejects when the chunk cannot load.
     */
    loadUi,
    /**
     * Shows the error page with `title` and `message`, and a retry when one is given. Shows the fallback screen when
     * the UI cannot load. Never throws.
     */
    showError,
    /** Shows the retry screen, or the fallback screen when the UI cannot load. Never throws. */
    showRetryScreen,
    /**
     * The product's page replaces this one: from now on no toast, failure or retry loads the sandbox's UI, and a load
     * still in flight does not mount. Never throws.
     */
    dispose,
  };

  /** `fallbackText` is what the page says in place of the UI when it cannot load. */
  function showWithUi(show: (ui: PageUiModule) => void, { fallbackText }: { fallbackText?: string } = {}): void {
    if (disposed) {
      return;
    }
    loadUi().then(
      ui => {
        if (!disposed) {
          show(ui);
        }
      },
      () => {
        // Reported once where it loads.
        if (fallbackText !== undefined && !disposed) {
          showFallback(fallbackText);
        }
      },
    );
  }

  function showQueued(): void {
    if (toasts.get().items.length > 0) {
      unsubscribeToasts();
      showWithUi(() => undefined);
    }
  }

  function showError(title: string, message: string, { retry }: { retry?: () => void } = {}): void {
    showWithUi(
      ui => {
        ui.showError(title, { detail: message, action: retry });
      },
      { fallbackText: `${title}. ${message}` },
    );
  }

  function showRetryScreen(): void {
    showWithUi(
      ui => {
        ui.showRetryScreen();
      },
      { fallbackText: 'Failed to load content.' },
    );
  }

  function dispose(): void {
    disposed = true;
    unsubscribeToasts();
  }
}
