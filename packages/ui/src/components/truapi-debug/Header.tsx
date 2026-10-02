// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Header bar of the TrUAPI debug panel: title, counts and the pause, clear,
// export, copy, dock, collapse and close controls.

import { createSignal, flush, onCleanup, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DockPosition } from '@dotli/truapi-debug';
import { exportFilename } from '@dotli/truapi-debug';

const DEBUG_SESSION_KEY = 'dotli:truapi-debug';
const COPY_FLASH_MS = 1200;

// Lucide glyphs.
function ExportIcon(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
    </svg>
  );
}

function CopyIcon(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

/** Shown while docked at the bottom: the target layout, a right column. */
function DockRightIcon(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <line x1="10" y1="2.5" x2="10" y2="13.5" />
      <rect x="10" y="2.5" width="4.5" height="11" fill="currentColor" fill-opacity="0.4" stroke="none" />
    </svg>
  );
}

/** Shown while docked right: the target layout, a bottom strip. */
function DockBottomIcon(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <line x1="1.5" y1="10" x2="14.5" y2="10" />
      <rect x="1.5" y="10" width="13" height="3.5" fill="currentColor" fill-opacity="0.4" stroke="none" />
    </svg>
  );
}

export function Header(props: {
  counts: string;
  walletEntry?: JSX.Element | undefined;
  paused: boolean;
  collapsed: boolean;
  dock: DockPosition;
  /** The filtered events as export JSON: what the user currently sees. */
  exportJson: () => string;
  onTogglePause: () => void;
  onClear: () => void;
  onToggleDock: () => void;
  onToggleCollapse: () => void;
}): JSX.Element {
  // A flashed mark replaces the copy icon for a moment, button disabled.
  const [copyMark, setCopyMark] = createSignal<string | null>(null);
  const [copyDisabled, setCopyDisabled] = createSignal(false);
  const flashTimers = new Set<number>();
  onCleanup(() => {
    for (const id of flashTimers) {
      window.clearTimeout(id);
    }
  });

  const flashCopy = (mark: string): void => {
    flush(() => {
      setCopyMark(mark);
      setCopyDisabled(true);
    });
    const id = window.setTimeout(() => {
      flashTimers.delete(id);
      flush(() => {
        setCopyMark(null);
        setCopyDisabled(false);
      });
    }, COPY_FLASH_MS);
    flashTimers.add(id);
  };

  const exportDownload = (): void => {
    const blob = new Blob([props.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename(new Date());
    // Attach before clicking and revoke on the next tick — Safari can
    // silently abort the download otherwise.
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  };

  const copyToClipboard = (): void => {
    // Disabled synchronously, so a rapid second click cannot start another
    // write while the first one is still in flight.
    flush(() => setCopyDisabled(true));
    // Typed as always present, but absent on non-secure origins
    // (Clipboard API is [SecureContext]-only).
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      flashCopy('✕');
      return;
    }
    clipboard.writeText(props.exportJson()).then(
      () => {
        flashCopy('✓');
      },
      () => {
        flashCopy('✕');
      },
    );
  };

  const exitDebugMode = (): void => {
    // Exit debug mode entirely: the panel is bound to debug mode, and
    // re-entry is via the host Settings "Open in debug mode" button.
    try {
      sessionStorage.setItem(DEBUG_SESSION_KEY, '0');
      // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in exotic environments; fall through to plain reload.
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  const dockLabel = (): string => (props.dock === 'right' ? 'Dock to bottom' : 'Dock to right');

  return (
    <div class="td-header">
      {props.walletEntry}
      <span class="td-title">TrUAPI Debug</span>
      <span class="td-counts">{props.counts}</span>
      <span class="td-spacer" />
      <button
        class={props.paused ? 'td-btn td-pause active' : 'td-btn td-pause'}
        type="button"
        onClick={() => {
          props.onTogglePause();
        }}
      >
        {props.paused ? 'Resume' : 'Pause'}
      </button>
      <button
        class="td-btn td-clear"
        type="button"
        onClick={() => {
          props.onClear();
        }}
      >
        Clear
      </button>
      <button
        class="td-btn td-btn-icon td-export"
        type="button"
        title="Download as JSON"
        aria-label="Download as JSON"
        onClick={exportDownload}
      >
        <ExportIcon />
      </button>
      <button
        class="td-btn td-btn-icon td-copy"
        type="button"
        title="Copy to clipboard"
        aria-label="Copy to clipboard"
        disabled={copyDisabled()}
        onClick={copyToClipboard}
      >
        <Show when={copyMark()} fallback={<CopyIcon />}>
          {copyMark()}
        </Show>
      </button>
      <button
        class="td-btn td-btn-icon td-dock"
        type="button"
        title={dockLabel()}
        aria-label={dockLabel()}
        onClick={() => {
          props.onToggleDock();
        }}
      >
        {props.dock === 'right' ? <DockBottomIcon /> : <DockRightIcon />}
      </button>
      <button
        class="td-btn td-btn-icon td-collapse"
        type="button"
        title="Collapse"
        onClick={() => {
          props.onToggleCollapse();
        }}
      >
        {props.collapsed ? '▲' : '▼'}
      </button>
      <button class="td-close" type="button" title="Hide (Ctrl+Shift+D)" onClick={exitDebugMode}>
        ×
      </button>
    </div>
  );
}
