// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's own UI loads the first time something needs it: a toast, a failure, a retry or a password. A product
// that loads needs none of it, so the boot carries no Solid.

import { createReporter, defineCount, spans as S } from '@dotli/metrics';
import { createLazyLoad, createStateMachine, type MachineTypes } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import { APP_LOG_TAG } from './appLogTag.js';
import type { FallbackScreen } from './createFallbackScreen.js';
import type { PageUiModule } from './lazy.js';

const report = createReporter({ flow: 'content' });

/** A lazy chunk a caller could not load and went on without. Tagged `outcome` and `reason` (the caller's step). */
const lazyChunkLoadMetric = defineCount<'error'>(S.LAZY_CHUNK_LOAD);

/** Count. A transition of the sandbox UI threw, a bug. Tagged `outcome` (error) and `reason` (the error's name). */
const uiTransitionMetric = defineCount<'error'>('sandbox.ui_transition');

type ToastQueue = { readonly items: readonly unknown[] };

type Params = {
  /** Loads the page UI chunk. Rejects when the chunk cannot load. */
  load: () => Promise<PageUiModule>;
  /** Toasts queue here before the UI is up, and show once it mounts. */
  toasts: ReadableAtom<ToastQueue>;
  /** Says why the page stopped, with a Reload, when the UI itself cannot load, and takes that away once it does. */
  fallback: FallbackScreen;
};

/** A full-page screen to show once the UI is up. A need that wants the UI only, such as a toast, has none (`null`). */
type Screen = { kind: 'error'; title: string; message: string; retry: (() => void) | undefined } | { kind: 'retry' };

/**
 * The UI is loaded once and mounted once. Until then each need loads it again, the toasts are listened to, and the last
 * screen the fallback took (`missed`) waits to move into the UI.
 */
type UiState =
  | { kind: 'waiting'; stopToasts: () => void; missed: Screen | null }
  | { kind: 'up'; ui: PageUiModule }
  | { kind: 'disposed' };

type UiEvent =
  | { kind: 'toastsChanged'; queued: boolean }
  | { kind: 'uiNeeded'; screen: Screen }
  | { kind: 'uiLoaded'; ui: PageUiModule; screen: Screen | null }
  | { kind: 'uiMissed'; screen: Screen | null }
  | { kind: 'disposed' };

type UiEffect =
  | { kind: 'mount'; ui: PageUiModule }
  | { kind: 'show'; ui: PageUiModule; screen: Screen }
  | { kind: 'showFallback'; screen: Screen };

type UiMachine = MachineTypes<UiState, UiEvent, UiEffect>;

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

  const machine = createStateMachine<UiMachine>({
    initial: { kind: 'waiting', stopToasts: toasts.listen(tellToasts), missed: null },
    handlers: {
      waiting: {
        toastsChanged(_state, { queued }, { update }) {
          // Listening goes on until the UI has loaded, so a toast after a failed load starts the next try. Each toast
          // change during a load queues one more try. Mounting the overlays shows the toasts.
          if (queued) {
            update(loadFor(null));
          }
        },
        uiNeeded(_state, { screen }, { update }) {
          update(loadFor(screen));
        },
        uiLoaded(state, { ui, screen }, { emitState, emitSideEffect }) {
          emitState({ kind: 'up', ui });
          state.stopToasts();
          emitSideEffect({ kind: 'mount', ui });
          // A load with no screen of its own, such as a toast's, still moves the fallback's screen into the UI.
          const shown = screen ?? state.missed;
          if (shown !== null) {
            emitSideEffect({ kind: 'show', ui, screen: shown });
          }
        },
        uiMissed(state, { screen }, { emitState, emitSideEffect }) {
          // Reported once where it loads.
          if (screen === null) {
            return;
          }
          emitState({ ...state, missed: screen });
          emitSideEffect({ kind: 'showFallback', screen });
        },
        disposed(state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
          state.stopToasts();
        },
      },
      up: {
        uiNeeded({ ui }, { screen }, { emitSideEffect }) {
          emitSideEffect({ kind: 'show', ui, screen });
        },
        // A load another need started before the UI came up.
        uiLoaded({ ui }, { screen }, { emitSideEffect }) {
          if (screen !== null) {
            emitSideEffect({ kind: 'show', ui, screen });
          }
        },
        disposed(_state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
        },
      },
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'mount':
          fallback.hide();
          effect.ui.mountOverlays();
          return;
        case 'show':
          showScreen(effect.ui, effect.screen);
          return;
        case 'showFallback':
          showFallback(effect.screen);
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'ui_transition',
        metric: uiTransitionMetric,
        message: `${APP_LOG_TAG} A transition of the sandbox UI threw`,
      });
    },
  });
  tellToasts(toasts.get());

  return {
    /**
     * Resolves with the UI once its overlays are mounted, or without mounting them once disposed. One load at a time, and a failed load is not kept, so the
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

  function tellToasts({ items }: ToastQueue): void {
    machine.update({ kind: 'toastsChanged', queued: items.length > 0 });
  }

  function loadFor(screen: Screen | null): Promise<UiEvent> {
    return loadChunk().then(
      ui => ({ kind: 'uiLoaded', ui, screen }),
      () => ({ kind: 'uiMissed', screen }),
    );
  }

  async function loadUi(): Promise<PageUiModule> {
    const ui = await loadChunk();
    machine.update({ kind: 'uiLoaded', ui, screen: null });
    return ui;
  }

  function showError(title: string, message: string, { retry }: { retry?: (() => void) | undefined } = {}): void {
    machine.update({ kind: 'uiNeeded', screen: { kind: 'error', title, message, retry } });
  }

  function showRetryScreen(): void {
    machine.update({ kind: 'uiNeeded', screen: { kind: 'retry' } });
  }

  function dispose(): void {
    machine.update({ kind: 'disposed' });
  }

  function showScreen(ui: PageUiModule, screen: Screen): void {
    switch (screen.kind) {
      case 'error':
        ui.showError(screen.title, { detail: screen.message, action: screen.retry });
        return;
      case 'retry':
        ui.showRetryScreen();
        return;
    }
  }

  /** Says in place of the UI what `screen` would have said. */
  function showFallback(screen: Screen): void {
    switch (screen.kind) {
      case 'error':
        fallback.show(`${screen.title}. ${screen.message}`);
        return;
      case 'retry':
        fallback.show('Failed to load content.');
        return;
    }
  }
}
