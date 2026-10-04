// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './SettingsRows.module.css';

/** A section's caps label, over the cards, wells or rows it heads. */
export function SettingsSection(props: {
  text: string;
  /** A class of the consumer's own, for its padding in a list. */
  class?: string | undefined;
  testId?: string;
}): JSX.Element {
  return (
    <div class={[s['section'], props.class]} data-testid={props.testId}>
      {props.text}
    </div>
  );
}

/** A row of a settings column: a label and its control, or a set of buttons. */
export function SettingsRow(props: {
  /** A class of the consumer's own, for its spacing. */
  class?: string | undefined;
  testId?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class={[s['row'], props.class]} data-testid={props.testId}>
      {props.children}
    </div>
  );
}

/**
 * An outlined action button spanning its row (Clear all caches, Save &
 * Apply, the diagnostics' links). `primary` fills it, as `data-primary`:
 * Save & Apply while there is something to apply.
 */
export function ClearButton(props: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
  /** A class of the consumer's own, for its size in the row. */
  class?: string | undefined;
  testId?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      onClick={() => {
        props.onClick();
      }}
      type="button"
      class={[s['clear'], props.class]}
      data-primary={props.primary === true ? '' : undefined}
      data-testid={props.testId}
      title={props.title}
      disabled={props.disabled === true}
    >
      {props.children}
    </button>
  );
}

/** How long a copied row reads "Copied". */
const COPIED_MS = 1000;

/**
 * A diagnostics label and value. A copyable row copies its value on click
 * (unless it is empty, "…" or "n/a") and reads "Copied" for a second, marked
 * `data-copied`.
 */
export function InfoRow(props: { label: string; value: string; copyable?: boolean }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(copiedTimer);
  });
  const copyable = untrack(() => props.copyable === true);
  return (
    <div
      onClick={() => {
        if (!copyable) {
          return;
        }
        const value = untrack(() => props.value);
        if (value === '' || value === '…' || value === 'n/a') {
          return;
        }
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          clearTimeout(copiedTimer);
          copiedTimer = setTimeout(() => {
            setCopied(false);
            copiedTimer = undefined;
          }, COPIED_MS);
        });
      }}
      class={s['info']}
      data-copyable={copyable ? '' : undefined}
      data-testid="mode-info-row"
      data-copied={copied() ? '' : undefined}
      title={copyable ? `Click to copy ${props.label}` : undefined}
    >
      <span class={s['infoLabel']}>{props.label}</span>
      <code class={s['infoValue']}>{copied() ? 'Copied' : props.value}</code>
    </div>
  );
}
