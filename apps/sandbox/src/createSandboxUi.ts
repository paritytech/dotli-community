// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's own UI loads the first time something needs it: a toast, a failure, a retry or a password. A product
// that loads needs none of it, so the boot carries no Solid.

import { createReporter, defineCount, spans as S } from '@dotli/metrics';
import { createLazyLoad, createStateMachine, noop, type MachineTypes, type Transition } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import { APP_LOG_TAG } from './appLogTag.js';
import type { FallbackScreen } from './createFallbackScreen.js';
import type { PageUiModule } from './lazy.js';

const report = createReporter({ flow: 'content' });

/** A lazy chunk a caller could not load and went on without. Tagged `outcome` and `reason` (the caller's step). */
const lazyChunkLoadMetric = defineCount<'error'>(S.LAZY_CHUNK_LOAD);

/** Count. A transition of the sandbox UI threw, a bug. Tagged `outcome` (error) and `reason` (the error's name). */
const uiTransitionMetric = defineCount<'error'>('sandbox.ui_transition');

type Params = {
  /** Loads the page UI chunk. Rejects when the chunk cannot load. */
  load: () => Promise<PageUiModule>;
  /** Toasts queue here before the UI is up, and show once it mounts. */
  toasts: ReadableAtom<{ readonly items: readonly unknown[] }>;
  /** Says why the page stopped, with a Reload, when the UI itself cannot load, and takes that away once it does. */
  fallback: FallbackScreen;
};

/** A screen to show once the UI is up. */
type Show = (ui: PageUiModule) => void;

/** The UI is loaded once and mounted once. Until then each need loads it again, and the toasts are listened to. */
type UiState = { kind: 'waiting'; stopToasts: () => void } | { kind: 'up'; ui: PageUiModule } | { kind: 'disposed' };

type UiEvent =
  | { kind: 'toastsChanged' }
  | { kind: 'uiNeeded'; show: Show; fallbackText: string | null }
  | { kind: 'uiLoaded'; ui: PageUiModule; show: Show }
  | { kind: 'uiMissed'; fallbackText: string | null }
  | { kind: 'disposed' };

type UiMachine = MachineTypes<UiState, UiEvent>;

export type SandboxUi = ReturnType<typeof createSandboxUi>;

/** The sandbox's own UI, loaded the first time a toast, a failure or a retry needs it. */
export function createSandboxUi({ load, toasts, fallback }: Params) {
  const loadChunk = createLazyLoad({
    load,
    onFirstMiss: error => {
      // A missing chunk is a deploy race, so it is counted and not captured (owner's call).
      report.expected(error, {
        step: 'page_ui_load',
        metric: lazyChunkLoadMetric,
        reason: 'page_ui_load',
        message: `${APP_LOG_TAG} the page UI failed to load`,
      });
    },
  });

  const stopToasts = toasts.listen(() => {
    machine.update({ kind: 'toastsChanged' });
  });
  const machine = createStateMachine<UiMachine>({
    initial: { kind: 'waiting', stopToasts },
    handlers: {
      waiting: {
        toastsChanged(_state, _event, transition) {
          if (toasts.get().items.length > 0) {
            // Listening goes on until the UI has loaded, so a toast after a failed load starts the next try. Each toast
            // change during a load queues one more try. Mounting the overlays shows the toasts.
            requestUi(noop, null, transition);
          }
        },
        uiNeeded(_state, { show, fallbackText }, transition) {
          requestUi(show, fallbackText, transition);
        },
        uiLoaded(state, { ui, show }, { emitState }) {
          emitState({ kind: 'up', ui });
          state.stopToasts();
          fallback.hide();
          ui.mountOverlays();
          show(ui);
        },
        uiMissed(_state, { fallbackText }) {
          // Reported once where it loads.
          if (fallbackText !== null) {
            fallback.show(fallbackText);
          }
        },
        disposed(state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
          state.stopToasts();
        },
      },
      up: {
        uiNeeded(state, { show }) {
          show(state.ui);
        },
        uiLoaded(state, { show }) {
          // A load another need started before the UI came up.
          show(state.ui);
        },
        disposed(_state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
        },
      },
      disposed: null,
    },
    onError: error => {
      report.defect(error, {
        step: 'ui_transition',
        metric: uiTransitionMetric,
        message: `${APP_LOG_TAG} A transition of the sandbox UI threw`,
      });
    },
  });
  machine.update({ kind: 'toastsChanged' });

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
  function requestUi(show: Show, fallbackText: string | null, { update }: Transition<UiMachine>): void {
    update(
      loadChunk().then(
        ui => ({ kind: 'uiLoaded', ui, show }),
        () => ({ kind: 'uiMissed', fallbackText }),
      ),
    );
  }

  async function loadUi(): Promise<PageUiModule> {
    const ui = await loadChunk();
    machine.update({ kind: 'uiLoaded', ui, show: noop });
    return ui;
  }

  function showError(title: string, message: string, { retry }: { retry?: (() => void) | undefined } = {}): void {
    machine.update({
      kind: 'uiNeeded',
      show: ui => {
        ui.showError(title, { detail: message, action: retry });
      },
      fallbackText: `${title}. ${message}`,
    });
  }

  function showRetryScreen(): void {
    machine.update({
      kind: 'uiNeeded',
      show: ui => {
        ui.showRetryScreen();
      },
      fallbackText: 'Failed to load content.',
    });
  }

  function dispose(): void {
    machine.update({ kind: 'disposed' });
  }
}
