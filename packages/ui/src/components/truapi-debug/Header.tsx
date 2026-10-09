// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush, onCleanup, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DockPosition } from '@dotli/truapi-debug';
import { exportFilename } from '@dotli/truapi-debug';
import { Button } from './shared/Button.js';
import { SectionTabs, type PanelSection } from './SectionTabs.js';
import s from './Header.module.css';

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
  section: PanelSection;
  onSelectSection: (section: PanelSection) => void;
  counts: string;
  paused: boolean;
  collapsed: boolean;
  dock: DockPosition;
  /** The picked dock, or the bottom on a narrow viewport. */
  placement: DockPosition;
  exportJson: () => string;
  onTogglePause: () => void;
  onClear: () => void;
  onToggleDock: () => void;
  onToggleCollapse: () => void;
}): JSX.Element {
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
    // Safari silently aborts the download unless the link is attached and the URL revoked a tick later.
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  };

  const copyToClipboard = (): void => {
    // Synchronous, so a rapid second click cannot start another write.
    flush(() => setCopyDisabled(true));
    // Typed as always present, but absent on non-secure origins.
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
    // Re-entry is via the Settings "Open in debug mode" button.
    try {
      sessionStorage.setItem(DEBUG_SESSION_KEY, '0');
      // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable, so fall through to a plain reload.
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  const dockLabel = (): string => (props.dock === 'right' ? 'Dock to bottom' : 'Dock to right');
  const events = (): boolean => props.section === 'truapi';
  const clearable = (): boolean => events() || props.section === 'resolution';

  return (
    <div class={s['header']} data-testid="td-header" data-dock={props.placement}>
      <SectionTabs section={props.section} onSelect={props.onSelectSection} />
      <span class={s['counts']} data-testid="td-counts" hidden={!events()}>
        {props.counts}
      </span>
      <span class={s['spacer']} />
      <Button testId="td-pause" hidden={!events()} active={props.paused} onClick={props.onTogglePause}>
        {props.paused ? 'Resume' : 'Pause'}
      </Button>
      <Button testId="td-clear" hidden={!clearable()} onClick={props.onClear}>
        Clear
      </Button>
      <Button
        testId="td-export"
        icon
        hidden={!events()}
        title="Download as JSON"
        label="Download as JSON"
        onClick={exportDownload}
      >
        <ExportIcon />
      </Button>
      <Button
        testId="td-copy"
        icon
        hidden={!events()}
        title="Copy to clipboard"
        label="Copy to clipboard"
        disabled={copyDisabled()}
        onClick={copyToClipboard}
      >
        <Show when={copyMark()} fallback={<CopyIcon />}>
          {copyMark()}
        </Show>
      </Button>
      <Button
        testId="td-dock"
        icon
        class={s['dock']}
        title={dockLabel()}
        label={dockLabel()}
        onClick={props.onToggleDock}
      >
        {props.dock === 'right' ? <DockBottomIcon /> : <DockRightIcon />}
      </Button>
      <Button testId="td-collapse" icon title="Collapse" onClick={props.onToggleCollapse}>
        {props.collapsed ? '▲' : '▼'}
      </Button>
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
