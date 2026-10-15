// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush, onCleanup, Show, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DockPosition } from './model/dock-storage.js';
import type { PanelSection } from './model/section-storage.js';
import { exportFilename } from './model/export.js';
import { PanelEffectsContext } from './effects.js';
import { Announce } from './shared/Announce.js';
import { COPY_STATUS, copyText, type CopyOutcome } from './shared/copy.js';
import { createFlash } from './shared/flash.js';
import { Button } from './shared/Button.js';
import { SectionTabs } from './SectionTabs.js';
import { CloseIcon } from './icons/CloseIcon.js';
import { CopyIcon } from './icons/CopyIcon.js';
import { DockBottomIcon } from './icons/DockBottomIcon.js';
import { DockRightIcon } from './icons/DockRightIcon.js';
import { ExportIcon } from './icons/ExportIcon.js';
import s from './Header.module.css';

const COPY_FLASH_MS = 1200;

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
  /** Hide leaves debug mode. Re-entry is the Settings "Open in debug mode" button. */
  onExit: () => void;
  onToggleDock: () => void;
  onToggleCollapse: () => void;
}): JSX.Element {
  const [copyOutcome, setCopyOutcome] = createSignal<CopyOutcome | null>(null);
  const [copyBusy, setCopyBusy] = createSignal(false);
  const copyFlash = createFlash<CopyOutcome>({
    ms: COPY_FLASH_MS,
    onChange: outcome => {
      flush(() => {
        setCopyOutcome(outcome);
        setCopyBusy(outcome !== null);
      });
    },
  });
  onCleanup(copyFlash.dispose);
  const copyStatus = (): string => {
    const outcome = copyOutcome();
    return outcome === null ? '' : COPY_STATUS[outcome];
  };

  const effects = useContext(PanelEffectsContext);

  const exportDownload = (): void => {
    effects.download(exportFilename(new Date()), props.exportJson());
  };

  const copyToClipboard = (): void => {
    // Synchronous, so a rapid second click cannot start another write.
    flush(() => setCopyBusy(true));
    void copyText(effects.writeClipboard, props.exportJson()).then(copyFlash.show);
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
        disabled={copyBusy()}
        onClick={copyToClipboard}
      >
        <Show when={copyOutcome()} fallback={<CopyIcon />}>
          {outcome => (outcome() === 'copied' ? '✓' : '✕')}
        </Show>
      </Button>
      <Announce testId="td-copy-status">{copyStatus()}</Announce>
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
      <Button testId="td-close" icon title="Hide" label="Hide" onClick={props.onExit}>
        <CloseIcon />
      </Button>
    </div>
  );
}
