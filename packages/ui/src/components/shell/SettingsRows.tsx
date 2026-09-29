// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The rows the settings popover (SettingsPopover.tsx) and its diagnostics
// (Diagnostics.tsx) are made of, rendering what topbar.ts's
// appendSectionHeader, buildRadioRow, renderCacheToggle and renderInfoRow
// built.

import { createSignal, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';

/** A section heading, with an optional modifier class. */
export function SectionHeader(props: { text: string; modifier?: string | undefined }): JSX.Element {
  return (
    <div class={props.modifier === undefined ? 'mode-popover-section' : `mode-popover-section ${props.modifier}`}>
      {props.text}
    </div>
  );
}

/**
 * A radio choice with a label and a description. Picking it calls `choose`
 * and keeps the focus on it (the old popover rebuilt the group and refocused
 * the checked radio, so arrow navigation survived).
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
    <label class={`mode-radio-row${props.selected ? ' selected' : ''}${disabled() ? ' disabled' : ''}`}>
      <input
        ref={el => {
          el.addEventListener('change', () => {
            props.choose();
            el.focus();
          });
        }}
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.selected}
        disabled={disabled()}
        class="mode-radio-input"
      />
      <span class="mode-radio-dot" />
      <span class="mode-radio-text">
        <span class="mode-radio-label">{props.label}</span>
        <span class="mode-radio-desc">{props.description}</span>
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
    <div class="mode-cache-row">
      <span class="mode-cache-label">{props.label}</span>
      <button
        ref={el => {
          el.addEventListener('click', () => {
            const next = !untrack(on);
            setOn(next);
            props.update(next);
          });
        }}
        role="switch"
        aria-label={props.label}
        class={`permissions-popover-toggle ${on() ? 'on' : ''}`}
        aria-checked={on() ? 'true' : 'false'}
      >
        <span class="permissions-toggle-track">
          <span class="permissions-toggle-knob" />
        </span>
      </button>
    </div>
  );
}

/** How long a copied row reads "Copied". */
const COPIED_MS = 1000;

/**
 * A diagnostics label and value. A copyable row copies its value on click
 * (unless it is empty, "…" or "n/a") and reads "Copied" for a second.
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
      ref={el => {
        if (!copyable) {
          return;
        }
        el.addEventListener('click', () => {
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
        });
      }}
      class={`mode-endpoint-row mode-info-row${copyable ? ' mode-info-row-copyable' : ''}${copied() ? ' copied' : ''}`}
      title={copyable ? `Click to copy ${props.label}` : undefined}
    >
      <span class="mode-endpoint-label">{props.label}</span>
      <code class="mode-endpoint-value">{copied() ? 'Copied' : props.value}</code>
    </div>
  );
}
