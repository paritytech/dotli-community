// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, untrack, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { PanelEffectsContext } from '../effects.js';
import { Announce } from './Announce.js';
import { COPY_STATUS, copyText, type CopyOutcome } from './copy.js';
import { createFlash } from './flash.js';
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
    ms: FLASH_MS,
    onChange: next => {
      setOutcome(next);
    },
  });
  onCleanup(flash.dispose);
  const status = (): string => {
    const current = outcome();
    return current === null ? '' : COPY_STATUS[current];
  };
  const copy = (): void => {
    void copyText(
      effects.writeClipboard,
      untrack(() => props.value),
    ).then(flash.show);
  };
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
        <code class={s['code']}>{status() === '' ? props.value : status()}</code>
      </button>
      <Announce>{status()}</Announce>
    </>
  );
}
