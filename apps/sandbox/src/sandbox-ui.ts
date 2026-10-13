// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's own UI loads the first time something needs it: a toast, a failure, a retry or a password. A product
// that loads needs none of it, so the boot carries no Solid.

import { reportExpected, spans as S } from '@dotli/metrics';
import type { ReadableStore } from '@dotli/shared';
import type { PageUiModule } from './lazy.js';

export interface SandboxUiDeps {
  load: () => Promise<PageUiModule>;
  /** Toasts queue here before the UI is up, and show once it mounts. */
  toasts: ReadableStore<{ readonly items: readonly unknown[] }>;
  /** Says why the page stopped, as plain text, when the UI itself cannot load. */
  showText: (text: string) => void;
}

export interface SandboxUi {
  /**
   * The UI with its overlays mounted. One load serves every caller. A failed load is not retried, since a deploy
   * replaced the chunk, and a reload is the way out.
   */
  ready: () => Promise<PageUiModule>;
  showError: (title: string, message: string, retry?: () => void) => void;
  showRetryScreen: () => void;
  /**
   * The product's page replaces this one: from now on no toast, failure or retry loads the sandbox's UI, and a load
   * still in flight does not mount.
   */
  close: () => void;
}

export function createSandboxUi({ load, toasts, showText }: SandboxUiDeps): SandboxUi {
  let loaded: Promise<PageUiModule> | undefined;
  let closed = false;
  const ready = (): Promise<PageUiModule> =>
    (loaded ??= load().then(
      ui => {
        if (!closed) {
          ui.mountOverlays();
        }
        return ui;
      },
      (err: unknown) => {
        // A missing chunk is a deploy race, counted as the host counts its own (owner's call: metric only).
        reportExpected(err, {
          flow: 'content',
          step: 'page_ui_load',
          metric: S.LAZY_CHUNK_LOAD,
          reason: 'page_ui_load',
          message: '[dot.li app] the page UI failed to load',
        });
        throw err;
      },
    ));

  /** `text` is what the page says in place of the UI when it cannot load. */
  const withUi = (show: (ui: PageUiModule) => void, text?: string): void => {
    if (closed) {
      return;
    }
    ready().then(show, () => {
      // Reported once where it loads.
      if (text !== undefined) {
        showText(text);
      }
    });
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
      });
    },
    close: () => {
      closed = true;
      stop();
    },
  };
}
