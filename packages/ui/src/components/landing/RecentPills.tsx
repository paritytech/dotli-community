// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, onCleanup, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getActiveTldSuffix } from '@dotli/config';
import { forgetRecentLabel, loadRecentLabels } from '../../recent-labels.js';
import { CloseIcon } from '../primitives/IconButton.js';
import { SectionLabel } from '../primitives/SectionLabel.js';
import { dotUrl } from './dot-url.js';
import s from './RecentPills.module.css';

// Touch has no hover, so a long press on a pill reveals its remove button instead of navigating.
const LONG_PRESS_MS = 450;

/**
 * Recently visited names as pills.
 * The list is written on the subdomain that resolved, so it loads from the cross-subdomain store, not this
 * origin's localStorage.
 */
export function RecentPills(): JSX.Element {
  const suffix = getActiveTldSuffix();
  const [labels, setLabels] = createSignal<string[]>([]);
  const [revealed, setRevealed] = createSignal<string | null>(null);
  let container: HTMLDivElement | undefined;

  const forget = (e: MouseEvent, label: string): void => {
    e.preventDefault();
    void forgetRecentLabel(label);
    setLabels(all => all.filter(l => l !== label));
  };

  // Swallow the tap that ends a long press rather than open the site being forgotten.
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

  const onDocumentPointerDown = (e: Event): void => {
    if (container?.contains(e.target as Node) !== true) {
      setRevealed(null);
    }
  };
  // Once in the browser, as the build renders this too.
  onSettled(() => {
    void loadRecentLabels().then(loaded => {
      setLabels(loaded);
    });
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
    };
  });
  onCleanup(cancelPress);

  return (
    <div
      ref={el => {
        container = el;
        // Passive so a press never holds up scrolling. Solid's JSX events take no listener options.
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
        <SectionLabel as="h2" text="Recent" id="dotli-recent-label" class={s['heading']} />
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
                  <CloseIcon />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
