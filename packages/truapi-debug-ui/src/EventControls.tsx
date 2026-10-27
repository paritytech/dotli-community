// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush, onCleanup, Show, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { formatExportFilename } from './model/formatExportFilename.js';
import { PanelEffectsContext } from './panelEffects.js';
import { Announce } from './shared/Announce.js';
import { copyText, formatCopyStatus, type CopyOutcome } from './shared/copyText.js';
import { createFlash } from './shared/createFlash.js';
import { Button } from './shared/Button.js';
import { CheckIcon } from './icons/CheckIcon.js';
import { CloseIcon } from './icons/CloseIcon.js';
import { CopyIcon } from './icons/CopyIcon.js';
import { ExportIcon } from './icons/ExportIcon.js';
import s from './EventControls.module.css';

const COPY_FLASH_MS = 1200;

/** The TrUAPI log's count and its controls: pause, clear, and the export as a download or a copy. */
export function EventControls(props: {
  counts: string;
  paused: boolean;
  exportJson: () => string;
  onTogglePause: () => void;
  onClear: () => void;
}): JSX.Element {
  const [copyOutcome, setCopyOutcome] = createSignal<CopyOutcome | null>(null);
  const [copyBusy, setCopyBusy] = createSignal(false);
  const copyFlash = createFlash<CopyOutcome>({
    durationMs: COPY_FLASH_MS,
    onChange: outcome => {
      flush(() => {
        setCopyOutcome(outcome);
        setCopyBusy(outcome !== null);
      });
    },
  });
  onCleanup(copyFlash.dispose);

  const effects = useContext(PanelEffectsContext);

  function downloadExport(): void {
    effects.download(formatExportFilename(new Date()), props.exportJson());
  }

  function copyToClipboard(): void {
    // Synchronous, so a rapid second click cannot start another write.
    flush(() => setCopyBusy(true));
    void copyText(effects.writeClipboard, props.exportJson()).then(copyFlash.show);
  }

  return (
    <div class={s['controls']} data-testid="td-event-controls">
      <span class={s['counts']} data-testid="td-counts">
        {props.counts}
      </span>
      <Button testId="td-pause" active={props.paused} onClick={props.onTogglePause}>
        {props.paused ? 'Resume' : 'Pause'}
      </Button>
      <Button testId="td-clear" onClick={props.onClear}>
        Clear
      </Button>
      <Button testId="td-export" icon title="Download as JSON" label="Download as JSON" onClick={downloadExport}>
        <ExportIcon />
      </Button>
      <Button
        testId="td-copy"
        icon
        title="Copy to clipboard"
        label="Copy to clipboard"
        disabled={copyBusy()}
        onClick={copyToClipboard}
      >
        <Show when={copyOutcome()} fallback={<CopyIcon />}>
          {outcome => renderCopyIcon(outcome())}
        </Show>
      </Button>
      <Announce testId="td-copy-status">{formatCopyStatus(copyOutcome())}</Announce>
    </div>
  );
}

function renderCopyIcon(outcome: CopyOutcome): JSX.Element {
  switch (outcome) {
    case 'copied':
      return <CheckIcon testId="td-copy-done" />;
    case 'failed':
      return <CloseIcon testId="td-copy-failed" />;
  }
}
