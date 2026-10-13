// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, untrack, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { PanelEffectsContext } from '../effects.js';
import { copyText } from './copy.js';
import s from './CopyValue.module.css';

const FLASH_MS = 1000;

/**
 * A value that copies itself on click, then reads "Copied", or "Copy failed", for a moment.
 * Its name is the text it shows, and the title says what clicking copies.
 */
export function CopyValue(props: { label: string; value: string }): JSX.Element {
  const effects = useContext(PanelEffectsContext);
  const [flash, setFlash] = createSignal<'copied' | 'failed' | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(flashTimer);
  });
  const show = (next: 'copied' | 'failed'): void => {
    setFlash(next);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      setFlash(null);
      flashTimer = undefined;
    }, FLASH_MS);
  };
  const copy = (): void => {
    void copyText(
      effects.writeClipboard,
      untrack(() => props.value),
    ).then(show);
  };
  return (
    <button
      class={s['copy']}
      type="button"
      title={`Click to copy ${props.label}`}
      data-copied={flash() === 'copied' ? '' : undefined}
      data-copy-failed={flash() === 'failed' ? '' : undefined}
      onClick={copy}
    >
      <code class={s['code']}>
        {flash() === 'copied' ? 'Copied' : flash() === 'failed' ? 'Copy failed' : props.value}
      </code>
    </button>
  );
}
