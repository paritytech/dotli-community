// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { PetalMark } from '@dotli/ui/brand';
import { AlertTriangleIcon } from '@dotli/ui/icons';
import type { LoadingState } from '../../state/loading.js';
import s from './LoadingScreen.module.css';

export type LoadingScreenProps = {
  state: Accessor<LoadingState>;
};

/** The screen the host page paints first, showing the load's progress, its lines and a stall warning. */
export function LoadingScreen(props: LoadingScreenProps): JSX.Element {
  // One memo per field: writing an unchanged live region could make a screen reader announce it again.
  const progress = createMemo(() => props.state().progress);
  const shown = createMemo(() => Math.round(progress()));
  const step = createMemo(() => props.state().step);
  const explanation = createMemo(() => props.state().explanation);
  const explanationOpacity = createMemo(() => props.state().explanationOpacity);
  const srText = createMemo(() => props.state().srText);
  const warning = createMemo(() => props.state().warning);
  const dismissing = createMemo(() => props.state().phase === 'dismissing');
  const gone = createMemo(() => props.state().phase === 'gone');

  return (
    <Show when={!gone()}>
      <div class={s['screen']} id="app-loading" data-dismissing={dismissing() ? '' : undefined}>
        <div class={s['column']}>
          <div class={s['logo']} id="loading-logo">
            <PetalMark pulse />
          </div>
          <div class={s['text']} id="loading-text">
            <div class={s['status']} id="loading-status">
              {/* The explanation is typed a character at a time, so screen readers get whole sentences
                from the element below instead. */}
              <p id="loading-step" class={s['step']} aria-hidden="true">
                <For each={step()}>
                  {part =>
                    typeof part === 'string' ? (
                      part
                    ) : (
                      <>
                        <span class={s['host']}>{part.host}</span>
                        <span class={s['tld']}>{part.tld}</span>
                      </>
                    )
                  }
                </For>
              </p>
              <p id="status" class={s['line']} aria-hidden="true" style={{ opacity: String(explanationOpacity()) }}>
                {explanation()}
              </p>
              <p class={s['srOnly']} id="status-sr" aria-live="polite">
                {srText()}
              </p>
            </div>
          </div>
          <div
            class={s['progress']}
            id="loading-progress"
            role="progressbar"
            aria-label="Loading"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={String(shown())}
          >
            <div class={s['bar']}>
              <div class={s['fill']} id="loading-progress-fill" style={{ width: `${String(progress())}%` }} />
            </div>
            <span class={s['pct']} id="loading-progress-pct">
              {`${String(shown())}%`}
            </span>
          </div>
          <p class={s['warning']} id="loading-warning" role="status" data-visible={warning() !== null ? '' : undefined}>
            <AlertTriangleIcon class={s['warningIcon']} size={16} strokeWidth="2" />
            <span id="loading-warning-text">{warning() ?? ''}</span>
          </p>
        </div>
      </div>
    </Show>
  );
}
