// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The rows the settings popover (SettingsContent.tsx), its diagnostics
// (Diagnostics.tsx) and the network popover's heading (ChainsContent.tsx)
// are made of: section headings, rows, radio choices, cache switches,
// diagnostics readouts and the outlined action buttons.

import { createSignal, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './SettingsRows.module.css';

/**
 * A section heading. `spaced` sets it apart from the section above it;
 * `bottom` also anchors it, and what follows it, to the bottom of its
 * column.
 */
export function SettingsSection(props: {
  text: string;
  spacing?: 'spaced' | 'bottom' | undefined;
  /** A class of the consumer's own, for placement. */
  class?: string | undefined;
  /** Rendered as `data-testid`. */
  testId?: string;
}): JSX.Element {
  return (
    <div
      class={[
        s['section'],
        props.spacing === 'spaced' && s['spaced'],
        props.spacing === 'bottom' && s['bottom'],
        props.class,
      ]}
      data-testid={props.testId}
    >
      {props.text}
    </div>
  );
}

/** A row of a settings column: a label and its control, or a set of buttons. */
export function SettingsRow(props: {
  /** A class of the consumer's own, for its spacing. */
  class?: string | undefined;
  /** Rendered as `data-testid`. */
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
  /** Rendered as `data-testid`. */
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

/**
 * A radio choice with a label and a description, marked `data-selected`
 * and `data-disabled`. Picking it calls `choose` and keeps the focus on it
 * (the old popover rebuilt the group and refocused the checked radio, so
 * arrow navigation survived).
 */
export function RadioRow(props: {
  name: string;
  value: string;
  label: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  choose: () => void;
}): JSX.Element {
  const disabled = (): boolean => props.disabled === true;
  return (
    <label
      class={s['radio']}
      data-selected={props.selected ? '' : undefined}
      data-disabled={disabled() ? '' : undefined}
    >
      <input
        onChange={e => {
          props.choose();
          e.currentTarget.focus();
        }}
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.selected}
        disabled={disabled()}
        class={s['radioInput']}
      />
      <span class={s['dot']} />
      <span class={s['radioText']}>
        <span class={s['radioLabel']}>{props.label}</span>
        <span class={s['radioDesc']}>{props.description}</span>
      </span>
    </label>
  );
}

/**
 * A cache on/off switch. It keeps its own state from `checked` at mount on,
 * as the old toggle painted itself, and reports each flip to `update`.
 */
export function CacheToggle(props: {
  label: string;
  checked: boolean;
  update: (enabled: boolean) => void;
}): JSX.Element {
  const [on, setOn] = createSignal(untrack(() => props.checked));
  return (
    <SettingsRow>
      <span class={s['cacheLabel']}>{props.label}</span>
      <button
        onClick={() => {
          const next = !untrack(on);
          setOn(next);
          props.update(next);
        }}
        role="switch"
        aria-label={props.label}
        class={s['switch']}
        aria-checked={on() ? 'true' : 'false'}
      >
        <span class={s['track']}>
          <span class={s['knob']} />
        </span>
      </button>
    </SettingsRow>
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
