// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Violation fields come from the product, so they only ever render as text. A product tripping a guarded API
// in a loop posts at frame rate, so the log is capped and each update forces at most one layout.

import { createEffect, createSignal, For, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { setDockInset } from '../../product-frame-layout.js';
import { startDrag } from '../drag.js';
import s from './ViolationPanel.module.css';

interface Violation {
  id: number;
  time: string;
  api: string;
  details: string;
}

const COLLAPSED_HEIGHT = 32;
const HEADER_AND_HANDLE = 32 + 5;
const MIN_HEIGHT = 40;
const MAX_VIEWPORT_SHARE = 0.8;
/** Older entries are dropped, but the badge still counts them. */
const MAX_ENTRIES = 500;

function parseViolation(raw: unknown): { api: string; details: string; timestamp: number } | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const data = raw as {
    type?: unknown;
    api?: unknown;
    details?: unknown;
    timestamp?: unknown;
  };
  if (data.type !== 'DOTLI_API_VIOLATION') {
    return null;
  }
  const details =
    typeof data.details === 'object' && data.details !== null
      ? Object.entries(data.details as Record<string, unknown>)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' ')
      : '';
  return {
    api: String(data.api),
    details,
    timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
  };
}

export function ViolationPanel(props: { iframe: HTMLIFrameElement }): JSX.Element {
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
  let stopDrag: (() => void) | undefined;

  // The frame layout keeps the product clear of the panel's height.
  const reserve = (bottom: number): void => {
    setDockInset({ right: 0, bottom }, 'sandbox-checker');
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) {
      return;
    }
    const violation = parseViolation(event.data);
    if (violation === null) {
      return;
    }
    entries.push({
      id: nextId++,
      time: new Date(violation.timestamp).toLocaleTimeString(),
      api: violation.api,
      details: violation.details,
    });
    if (entries.length > MAX_ENTRIES) {
      entries.shift();
    }
    setViolations(entries);
    setTotal(n => n + 1);
  };

  const onDragMove = (event: PointerEvent): void => {
    const viewportHeight = window.innerHeight;
    setHeight(Math.max(MIN_HEIGHT, Math.min(viewportHeight - event.clientY, viewportHeight * MAX_VIEWPORT_SHARE)));
  };

  window.addEventListener('message', onMessage);
  onCleanup(() => {
    window.removeEventListener('message', onMessage);
    stopDrag?.();
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
            stopDrag = startDrag(handle, event, { move: onDragMove });
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
          aria-label="Toggle panel"
          onClick={() => {
            if (!collapsed()) {
              setHeight(null);
            }
            setCollapsed(!collapsed());
          }}
        >
          {collapsed() ? '▲' : '▼'}
        </button>
      </div>
      <div
        class={s['log']}
        data-testid="sc-log"
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
