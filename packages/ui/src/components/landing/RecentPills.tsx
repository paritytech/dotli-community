// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getActiveTldSuffix } from '@dotli/config';
import { forgetRecentLabel, loadRecentLabels } from '../../recent-labels.js';
import { dotUrl } from './dot-url.js';
import s from './RecentPills.module.css';

// Touch has no hover, so a long press on a pill reveals its remove button
// instead of navigating.
const LONG_PRESS_MS = 450;

/**
 * The recently visited names (`#dotli-recent`), as pills linking to their
 * sites, each with a button that forgets the name. Hidden until the list
 * loads, and again once the last name is forgotten. The list is written on
 * the subdomain that resolved, so it comes from the cross-subdomain store
 * (recent-labels.ts), not this origin's localStorage.
 */
export function RecentPills(): JSX.Element {
  const suffix = getActiveTldSuffix();
  const [labels, setLabels] = createSignal<string[]>([]);
  // The one pill whose remove button a long press revealed.
  const [revealed, setRevealed] = createSignal<string | null>(null);
  let container: HTMLDivElement | undefined;

  void loadRecentLabels().then(loaded => {
    setLabels(loaded);
  });

  const forget = (e: MouseEvent, label: string): void => {
    e.preventDefault();
    void forgetRecentLabel(label);
    setLabels(all => all.filter(l => l !== label));
  };

  // A long press revealed the remove button, so swallow the tap that ends it
  // rather than navigating to the site the visitor was about to forget.
  const open = (e: MouseEvent, label: string): void => {
    if (revealed() === label) {
      e.preventDefault();
    }
  };

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelPress = (): void => {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };
  const onTouchStart = (e: Event): void => {
    const target = e.target instanceof Element ? e.target : null;
    const label = target?.closest<HTMLElement>('[data-label]')?.dataset['label'];
    if (label === undefined || revealed() === label) {
      return;
    }
    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      setRevealed(label);
    }, LONG_PRESS_MS);
  };

  // Tapping anywhere else puts the revealed pill back.
  const onDocumentPointerDown = (e: Event): void => {
    if (container?.contains(e.target as Node) !== true) {
      setRevealed(null);
    }
  };
  document.addEventListener('pointerdown', onDocumentPointerDown);
  onCleanup(() => {
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    cancelPress();
  });

  return (
    <div
      ref={el => {
        container = el;
        // Passive, so a press never holds up scrolling: Solid's JSX events
        // take no listener options.
        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', cancelPress, { passive: true });
        el.addEventListener('touchend', cancelPress, { passive: true });
        el.addEventListener('touchcancel', cancelPress, { passive: true });
      }}
      id="dotli-recent"
      class={s['recent']}
      hidden={labels().length === 0}
    >
      <Show when={labels().length > 0}>
        <h2 id="dotli-recent-label" class={s['heading']}>
          Recent
        </h2>
        <div class={s['list']} role="group" aria-labelledby="dotli-recent-label" data-testid="landing-recent-list">
          <For each={labels()}>
            {label => (
              <span
                class={s['item']}
                data-testid="landing-recent-item"
                data-label={label}
                data-removable={revealed() === label ? '' : undefined}
              >
                <a
                  href={dotUrl(label)}
                  class={s['pill']}
                  data-testid="landing-recent-pill"
                  onClick={e => {
                    open(e, label);
                  }}
                >
                  <span class={s['label']} data-testid="landing-recent-label">
                    {label}
                    <span class={s['tld']} data-testid="landing-tld">
                      {suffix}
                    </span>
                  </span>
                </a>
                <button
                  type="button"
                  class={s['remove']}
                  data-testid="landing-recent-remove"
                  aria-label={`Remove ${label}${suffix} from recently visited`}
                  title="Remove"
                  onClick={e => {
                    forget(e, label);
                  }}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
