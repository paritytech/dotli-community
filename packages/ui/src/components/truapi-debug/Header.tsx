// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Header bar of the TrUAPI debug panel: the debug-build wallet entry, title,
// counts and the pause, clear, export, copy, dock, collapse and close controls.

import { createSignal, flush, onCleanup, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DockPosition } from '@dotli/truapi-debug';
import { exportFilename } from '@dotli/truapi-debug';
import s from './Header.module.css';
import { WALLET_VIEW_ID } from './wallet/WalletView.js';

const DEBUG_SESSION_KEY = 'dotli:truapi-debug';
const COPY_FLASH_MS = 1200;

/** The header's wallet button: what it shows and what it opens. */
export interface WalletEntryState {
  /** A known full or Lite username, or empty for the icon. */
  name: string;
  /** The Wallet tab is on screen. */
  expanded: boolean;
  onOpen: () => void;
}

function walletTitle(name: string): string {
  return name === '' ? 'Open wallet' : `Open wallet: ${name}`;
}

// Lucide glyphs.
function WalletIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v12H5a2 2 0 0 1-2-2V6" />
      <path d="M20 12h-4a2 2 0 0 0 0 4h4" />
    </svg>
  );
}

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
      <path d="M12 15V3m9 12v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
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
      <path d="M10 2.5v11" />
      <path fill="currentColor" fill-opacity=".4" d="M10 2.5h4.5v11H10z" stroke="none" />
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
      <path d="M1.5 10h13" />
      <path fill="currentColor" fill-opacity=".4" d="M1.5 10h13v3.5h-13z" stroke="none" />
    </svg>
  );
}

export function Header(props: {
  counts: string;
  /** Debug builds with the experimental wallet only. */
  wallet?: WalletEntryState | undefined;
  /** The PolkaVM runtime badge, while a PolkaVM product reports diagnostics. */
  runtimeEntry?: JSX.Element | undefined;
  paused: boolean;
  collapsed: boolean;
  dock: DockPosition;
  /** Where the panel sits: the picked dock, or the bottom on a phone. */
  placement: DockPosition;
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
    <div class={s['header']} data-testid="td-header" data-dock={props.placement}>
      <Show when={props.wallet}>
        {wallet => (
          <button
            class={`${s['btn'] ?? ''} ${s['icon'] ?? ''} ${s['wallet'] ?? ''}`}
            data-testid="td-wallet-entry"
            type="button"
            title={walletTitle(wallet().name)}
            aria-label={walletTitle(wallet().name)}
            aria-controls={WALLET_VIEW_ID}
            aria-expanded={wallet().expanded ? 'true' : 'false'}
            onClick={() => {
              wallet().onOpen();
            }}
          >
            <span class={s['walletIcon']} aria-hidden="true" hidden={wallet().name !== ''}>
              <WalletIcon />
            </span>
            <span class={s['walletName']}>{wallet().name}</span>
          </button>
        )}
      </Show>
      <span class={s['title']} data-testid="td-title">
        TrUAPI Debug
      </span>
      <span class={s['counts']} data-testid="td-counts">
        {props.counts}
      </span>
      {props.runtimeEntry}
      <span class={s['spacer']} />
      <button
        class={s['btn']}
        data-testid="td-pause"
        data-active={props.paused ? '' : undefined}
        type="button"
        onClick={() => {
          props.onTogglePause();
        }}
      >
        {props.paused ? 'Resume' : 'Pause'}
      </button>
      <button
        class={s['btn']}
        data-testid="td-clear"
        type="button"
        onClick={() => {
          props.onClear();
        }}
      >
        Clear
      </button>
      <button
        class={[s['btn'], s['icon'], s['glyph']]}
        data-testid="td-export"
        type="button"
        title="Download as JSON"
        aria-label="Download as JSON"
        onClick={exportDownload}
      >
        <ExportIcon />
      </button>
      <button
        class={[s['btn'], s['icon'], s['glyph']]}
        data-testid="td-copy"
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
        class={[s['btn'], s['icon'], s['glyph'], s['dock']]}
        data-testid="td-dock"
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
        class={[s['btn'], s['icon']]}
        data-testid="td-collapse"
        type="button"
        title="Collapse"
        onClick={() => {
          props.onToggleCollapse();
        }}
      >
        {props.collapsed ? '▲' : '▼'}
      </button>
      <button
        class={s['close']}
        data-testid="td-close"
        type="button"
        title="Hide (Ctrl+Shift+D)"
        onClick={exitDebugMode}
      >
        ×
      </button>
    </div>
  );
}
