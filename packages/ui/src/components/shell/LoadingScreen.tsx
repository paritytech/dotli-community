// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { PETAL_PATHS } from '../../petal-mark.js';
import { loadingStore } from '../../state/loading.js';
import { useStore } from '../use-store.js';
import s from './LoadingScreen.module.css';

/**
 * The loading screen (`#app-loading`), an island (see src/islands/) the host
 * page paints first and hydrates. It renders the loading store, which
 * loading-controller.ts writes, so progress made before it hydrates shows
 * once it has. It fades while the screen is dismissed and renders nothing
 * once it is gone (the `"loading"` app root disposed): the island stays on
 * the page, outside `#app`.
 */
export function LoadingScreen(): JSX.Element {
  // One selector per field, so a line is only written when it changes:
  // writing an unchanged live region could make a screen reader announce it
  // again.
  const progress = useStore(loadingStore, state => state.progress);
  const shown = createMemo(() => Math.round(progress()));
  const step = useStore(loadingStore, state => state.step);
  const explanation = useStore(loadingStore, state => state.explanation);
  const explanationOpacity = useStore(loadingStore, state => state.explanationOpacity);
  const srText = useStore(loadingStore, state => state.srText);
  const warning = useStore(loadingStore, state => state.warning);
  const dismissing = useStore(loadingStore, state => state.phase === 'dismissing');
  const gone = useStore(loadingStore, state => state.phase === 'gone');

  return (
    <Show when={!gone()}>
      <div class={s['screen']} id="app-loading" data-dismissing={dismissing() ? '' : undefined}>
        <div class={s['column']}>
          <div class={s['logo']} id="loading-logo">
            <svg
              class={s['mark']}
              width="56"
              height="56"
              viewBox="0 0 256 256"
              fill="none"
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
            >
              <For each={PETAL_PATHS}>{d => <path class={s['petal']} d={d} />}</For>
            </svg>
          </div>
          <div class={s['text']} id="loading-text">
            <div class={s['status']} id="loading-status">
              {/* Both lines are hidden from screen readers, which get whole
                sentences from the element below: the explanation is typed a
                character at a time. */}
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
            <svg
              class={s['warningIcon']}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              // @ts-expect-error -- not in Solid's SVG types, but hides the icon from focus
              focusable="false"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
            <span id="loading-warning-text">{warning() ?? ''}</span>
          </p>
        </div>
      </div>
    </Show>
  );
}
