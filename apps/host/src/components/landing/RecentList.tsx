// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, onCleanup, onSettled, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { CloseIcon } from '@dotli/ui/icons';
import { Row, SectionLabel, Well } from '@dotli/ui';
import { dotUrl } from './dot-url.js';
import s from './RecentList.module.css';

// Touch has no hover, so a long press on a row reveals its remove button instead of navigating.
const LONG_PRESS_MS = 450;

export interface RecentListProps {
  /** Recently visited names. None hides the list. */
  labels: Accessor<readonly string[]>;
  /** The TLD shown beside each name, with its leading dot. Null until the browser knows the visitor's network. */
  suffix: Accessor<string | null>;
  /** The remove button of `label`'s row. */
  onForget: (label: string) => void;
}

/** Recently visited names as a list of links. */
export function RecentList(props: RecentListProps): JSX.Element {
  const labels = (): readonly string[] => props.labels();
  const suffix = (): string => props.suffix() ?? '';
  const [revealed, setRevealed] = createSignal<string | null>(null);
  let container: HTMLDivElement | undefined;

  const forget = (e: MouseEvent, label: string): void => {
    e.preventDefault();
    props.onForget(label);
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
        <SectionLabel as="h2" text="Recent" id="dotli-recent-label" />
        <div class={s['list']} role="group" aria-labelledby="dotli-recent-label" data-testid="landing-recent-list">
          <Well layout="controls">
            <For each={labels()}>
              {label => (
                <Row
                  class={s['item']}
                  testId="landing-recent-item"
                  label={
                    <a
                      href={dotUrl(label)}
                      class={s['link']}
                      data-testid="landing-recent-link"
                      data-label={label}
                      onClick={e => {
                        open(e, label);
                      }}
                    >
                      <span class={s['label']} data-testid="landing-recent-label">
                        {label}
                        <span class={s['tld']} data-testid="landing-tld">
                          {suffix()}
                        </span>
                      </span>
                    </a>
                  }
                >
                  <button
                    type="button"
                    class={s['remove']}
                    data-testid="landing-recent-remove"
                    data-revealed={revealed() === label ? '' : undefined}
                    aria-label={`Remove ${label}${suffix()} from recently visited`}
                    title="Remove"
                    onClick={e => {
                      forget(e, label);
                    }}
                  >
                    <CloseIcon />
                  </button>
                </Row>
              )}
            </For>
          </Well>
        </div>
      </Show>
    </div>
  );
}
