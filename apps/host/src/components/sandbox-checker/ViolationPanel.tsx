// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Violation fields come from the product, so they only ever render as text. A product tripping a guarded API
// in a loop posts at frame rate, so the log is capped and each update forces at most one layout.

import { createEffect, createSignal, For, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createDrags } from '@dotli/ui';
import { ChevronDownIcon } from '@dotli/ui/icons';
import { appendViolation, clampPanelHeight, violationFrom } from './violations.js';
import s from './ViolationPanel.module.css';

type Violation = {
  id: number;
  time: string;
  api: string;
  details: string;
};

const COLLAPSED_HEIGHT = 32;
const HEADER_AND_HANDLE = 32 + 5;

export type ViolationPanelProps = {
  /** The product's frame, whose violations the panel lists. */
  iframe: HTMLIFrameElement;
  /** The px the panel covers at the page's bottom, for the page to keep the product clear of. 0 as it goes. */
  onReserve: (bottom: number) => void;
};

export function ViolationPanel(props: ViolationPanelProps): JSX.Element {
  // One array trimmed in place, since copying it per violation makes a looping product quadratic.
  // `equals: false` makes each in-place update notify.
  const entries: Violation[] = [];
  const [violations, setViolations] = createSignal<readonly Violation[]>(entries, { equals: false });
  const [total, setTotal] = createSignal(0);
  const [collapsed, setCollapsed] = createSignal(false);
  const [height, setHeight] = createSignal<number | null>(null);
  // The iframe never changes, and the component body is under Solid's `STRICT_READ_UNTRACKED` check.
  const iframe = untrack(() => props.iframe);
  let panel: HTMLDivElement | undefined;
  let log: HTMLDivElement | undefined;
  let handle: HTMLDivElement | undefined;
  let nextId = 0;
  const drags = createDrags();

  const reserve = (bottom: number): void => {
    props.onReserve(bottom);
  };

  const onMessage = (event: MessageEvent): void => {
    const violation = violationFrom(event, iframe.contentWindow);
    if (violation === null) {
      return;
    }
    appendViolation(entries, {
      id: nextId++,
      time: new Date(violation.timestamp).toLocaleTimeString(),
      api: violation.api,
      details: violation.details,
    });
    setViolations(entries);
    setTotal(n => n + 1);
  };

  const onDragMove = (event: PointerEvent): void => {
    setHeight(clampPanelHeight(event.clientY, window.innerHeight));
  };

  window.addEventListener('message', onMessage);
  onCleanup(() => {
    window.removeEventListener('message', onMessage);
    drags.stopAll();
    reserve(0);
  });

  // A new entry can grow the log, so it refits the frame too. Both measures are read before either
  // write, so one update forces one layout.
  let reserved: number | null = null;
  let scrolledAt = 0;
  createEffect(
    () => [total(), collapsed(), height()] as const,
    ([count, isCollapsed]) => {
      if (count === 0) {
        return;
      }
      const bottom = isCollapsed ? COLLAPSED_HEIGHT : (panel?.offsetHeight ?? 0);
      if (log !== undefined && count !== scrolledAt) {
        scrolledAt = count;
        log.scrollTop = log.scrollHeight;
      }
      if (bottom !== reserved) {
        reserved = bottom;
        reserve(bottom);
      }
    },
  );

  return (
    <div
      id="sandbox-checker-panel"
      class={s['panel']}
      data-visible={total() > 0 ? '' : undefined}
      data-collapsed={collapsed() ? '' : undefined}
      style={{
        height: !collapsed() && height() !== null ? `${String(height())}px` : undefined,
      }}
      ref={el => {
        panel = el;
      }}
    >
      <div
        class={s['resizeHandle']}
        data-testid="sc-resize-handle"
        ref={el => {
          handle = el;
        }}
        onPointerDown={event => {
          if (!collapsed() && handle !== undefined) {
            drags.start(handle, event, { move: onDragMove });
          }
        }}
      />
      <div class={s['header']}>
        <span class={s['badge']} data-testid="sc-badge">
          {String(total())}
        </span>
        <span class={s['label']} data-testid="sc-label">
          API Violations
        </span>
        <button
          type="button"
          class={s['toggle']}
          data-testid="sc-toggle"
          aria-label="Violation log"
          aria-expanded={collapsed() ? 'false' : 'true'}
          aria-controls="sandbox-checker-log"
          onClick={() => {
            if (!collapsed()) {
              setHeight(null);
            }
            setCollapsed(!collapsed());
          }}
        >
          <ChevronDownIcon class={s['chevron']} size={12} />
        </button>
      </div>
      <div
        id="sandbox-checker-log"
        class={s['log']}
        data-testid="sc-log"
        // A region, not a log, so a frame-rate burst of violations is not read aloud.
        role="region"
        aria-label="API violations"
        // Focusable so a keyboard can scroll the log.
        tabindex="0"
        style={{
          'max-height':
            !collapsed() && height() !== null ? `${String((height() ?? 0) - HEADER_AND_HANDLE)}px` : undefined,
        }}
        ref={el => {
          log = el;
        }}
      >
        <For each={violations()}>
          {entry => (
            <div class={s['entry']} data-testid="sc-entry">
              <span class={s['time']} data-testid="sc-time">
                {entry.time}
              </span>{' '}
              <span class={s['api']} data-testid="sc-api">
                {entry.api}
              </span>{' '}
              {entry.details !== '' ? (
                <span class={s['details']} data-testid="sc-details">
                  {entry.details}
                </span>
              ) : null}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
