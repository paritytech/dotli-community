// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, untrack, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { PanelEffectsContext } from '../panelEffects.js';
import { Announce } from './Announce.js';
import { copyText, formatCopyStatus, type CopyOutcome } from './copyText.js';
import { createFlash } from './createFlash.js';
import s from './CopyValue.module.css';

const FLASH_MS = 1000;

/**
 * A value that copies itself on click, then reads "Copied", or "Copy failed", for a moment, and says so to a screen
 * reader. Its name is the text it shows, and the title says what clicking copies.
 */
export function CopyValue(props: { label: string; value: string }): JSX.Element {
  const effects = useContext(PanelEffectsContext);
  const [outcome, setOutcome] = createSignal<CopyOutcome | null>(null);
  const flash = createFlash<CopyOutcome>({
    durationMs: FLASH_MS,
    onChange: next => {
      setOutcome(next);
    },
  });
  onCleanup(flash.dispose);
  function getStatus(): string {
    return formatCopyStatus(outcome());
  }
  function copy(): void {
    void copyText(
      effects.writeClipboard,
      untrack(() => props.value),
    ).then(flash.show);
  }
  return (
    <>
      <button
        class={s['copy']}
        type="button"
        title={`Click to copy ${props.label}`}
        data-copied={outcome() === 'copied' ? '' : undefined}
        data-copy-failed={outcome() === 'failed' ? '' : undefined}
        onClick={copy}
      >
        <code class={s['code']}>{getStatus() === '' ? props.value : getStatus()}</code>
      </button>
      <Announce>{getStatus()}</Announce>
    </>
  );
}
