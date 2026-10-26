// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, untrack, type Accessor } from 'solid-js';
import { createAsyncTaskPool } from '@dotli/shared';
import type { PhraseScreenModule } from '../../lazy.js';
import { reportLazyMiss } from '../../lazy-miss.js';

/** Where the phrase form's chunk stands on a phrase view: on its way, failed, or loaded. */
export type PhraseForm = 'loading' | 'failed' | PhraseScreenModule;

export interface PhraseFormLoad {
  /** Where the form's chunk stands, on its way until a phrase view first asks for it. */
  form: Accessor<PhraseForm>;
  /** Loads the form again after a failed load. */
  reload: () => void;
}

/**
 * Loads the debug-only phrase form the first time `onShow` says a phrase view is on show, and again on each reload
 * after a failure. A load starts only when none has started or the last one failed, so two never run at once and a
 * loaded form stays.
 */
export function createPhraseFormLoad(load: () => Promise<PhraseScreenModule>, onShow: () => boolean): PhraseFormLoad {
  const [state, setState] = createSignal<'idle' | PhraseForm>('idle');
  const loads = createAsyncTaskPool({ poolSize: 1 });
  const start = (from: 'idle' | 'failed'): void => {
    void loads.call(async () => {
      // A call queued behind a load that fails would otherwise load again by itself.
      if (untrack(state) !== from) {
        return;
      }
      setState('loading');
      try {
        setState(await load());
      } catch (error: unknown) {
        reportLazyMiss('wallet', 'phrase_screen', error);
        setState('failed');
      }
    });
  };
  createEffect(onShow, shown => {
    if (shown) {
      start('idle');
    }
  });
  // Not asked for yet reads as on its way, so the first load leaves the view unchanged.
  const form = createMemo<PhraseForm>(() => {
    const current = state();
    return current === 'idle' ? 'loading' : current;
  });
  return {
    form,
    reload: () => {
      if (untrack(state) === 'failed') {
        start('failed');
      }
    },
  };
}
