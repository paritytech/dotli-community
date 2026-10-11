// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './CopyValue.module.css';

const COPIED_MS = 1000;

/** A value that copies itself on click, then reads "Copied" for a moment. */
export function CopyValue(props: { label: string; value: string }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(copiedTimer);
  });
  const copy = (): void => {
    void navigator.clipboard.writeText(untrack(() => props.value)).then(() => {
      setCopied(true);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        setCopied(false);
        copiedTimer = undefined;
      }, COPIED_MS);
    });
  };
  return (
    <button
      class={s['copy']}
      type="button"
      title={`Click to copy ${props.label}`}
      aria-label={`Copy ${props.label}`}
      data-copied={copied() ? '' : undefined}
      onClick={copy}
    >
      <code class={s['code']}>{copied() ? 'Copied' : props.value}</code>
    </button>
  );
}
