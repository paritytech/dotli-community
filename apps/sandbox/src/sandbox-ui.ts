// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's own UI loads the first time something needs it: a toast, a failure, a retry or a password. A product
// that loads needs none of it, so the boot carries no Solid.

import { reportExpected, spans as S } from '@dotli/metrics';
import { createLazyLoad, type ReadableStore } from '@dotli/shared';
import type { PageUiModule } from './lazy.js';

export type SandboxUiDeps = {
  load: () => Promise<PageUiModule>;
  /** Toasts queue here before the UI is up, and show once it mounts. */
  toasts: ReadableStore<{ readonly items: readonly unknown[] }>;
  /** Says why the page stopped, with a Reload, when the UI itself cannot load. */
  showFallback: (text: string) => void;
  /** Takes that screen away once a later load brings the UI up. Safe when it is not shown. */
  hideFallback: () => void;
};

export type SandboxUi = {
  /** The UI with its overlays mounted. One load at a time, and a failed load is not kept, so the next call loads again. */
  ready: () => Promise<PageUiModule>;
  showError: (title: string, message: string, retry?: () => void) => void;
  showRetryScreen: () => void;
  /**
   * The product's page replaces this one: from now on no toast, failure or retry loads the sandbox's UI, and a load
   * still in flight does not mount.
   */
  close: () => void;
};

export function createSandboxUi({ load, toasts, showFallback, hideFallback }: SandboxUiDeps): SandboxUi {
  let closed = false;
  const ready = createLazyLoad(
    async () => {
      const ui = await load();
      if (!closed) {
        hideFallback();
        ui.mountOverlays();
      }
      return ui;
    },
    {
      onFirstMiss: err => {
        // A missing chunk is a deploy race, counted as the host counts its own (owner's call: metric only).
        reportExpected(err, {
          flow: 'content',
          step: 'page_ui_load',
          metric: S.LAZY_CHUNK_LOAD,
          reason: 'page_ui_load',
          message: '[dot.li app] the page UI failed to load',
        });
      },
    },
  );

  /** `text` is what the page says in place of the UI when it cannot load. */
  const withUi = (show: (ui: PageUiModule) => void, text?: string): void => {
    if (closed) {
      return;
    }
    ready().then(
      ui => {
        if (!closed) {
          show(ui);
        }
      },
      () => {
        // Reported once where it loads.
        if (text !== undefined && !closed) {
          showFallback(text);
        }
      },
    );
  };

  const showQueued = (): void => {
    if (toasts.get().items.length > 0) {
      stop();
      withUi(() => undefined);
    }
  };
  const stop = toasts.subscribe(showQueued);
  showQueued();

  return {
    ready,
    showError: (title, message, retry) => {
      withUi(ui => {
        ui.showError(title, message, retry);
      }, `${title}. ${message}`);
    },
    showRetryScreen: () => {
      withUi(ui => {
        ui.showRetryScreen();
      }, 'Failed to load content.');
    },
    close: () => {
      closed = true;
      stop();
    },
  };
}
