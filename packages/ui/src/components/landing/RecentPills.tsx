// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getActiveTldSuffix } from '@dotli/config';
import { forgetRecentLabel, loadRecentLabels } from '../../recent-labels.js';
import { dotUrl } from './dot-url.js';

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

  const itemOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>('.landing-recent-item') : null;

  // Native listeners, like the shell's islands (components/shell/islands.ts).
  const onClick = (e: MouseEvent): void => {
    const item = itemOf(e.target);
    const label = item?.dataset['label'];
    if (item === null || label === undefined) {
      return;
    }
    if ((e.target as Element).closest('.landing-recent-remove') !== null) {
      e.preventDefault();
      void forgetRecentLabel(label);
      setLabels(all => all.filter(l => l !== label));
      return;
    }
    // A long press revealed the remove button, so swallow the tap that ends it
    // rather than navigating to the site the visitor was about to forget.
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
    const label = itemOf(e.target)?.dataset['label'];
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
        el.addEventListener('click', onClick);
        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', cancelPress, { passive: true });
        el.addEventListener('touchend', cancelPress, { passive: true });
        el.addEventListener('touchcancel', cancelPress, { passive: true });
      }}
      id="dotli-recent"
      class="landing-recent"
      hidden={labels().length === 0}
    >
      <Show when={labels().length > 0}>
        <div class="landing-recent-list">
          <For each={labels()}>
            {label => (
              <span
                class={{
                  'landing-recent-item': true,
                  'is-removable': revealed() === label,
                }}
                data-label={label}
              >
                <a href={dotUrl(label)} class="landing-recent-pill">
                  <span class="landing-recent-label">
                    {label}
                    <span class="landing-tld">{suffix}</span>
                  </span>
                </a>
                <button
                  type="button"
                  class="landing-recent-remove"
                  aria-label={`Remove ${label}${suffix} from recently visited`}
                  title="Remove"
                >
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                    stroke-linecap="round"
                  >
                    <line x1="5" y1="5" x2="19" y2="19" />
                    <line x1="19" y1="5" x2="5" y2="19" />
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
