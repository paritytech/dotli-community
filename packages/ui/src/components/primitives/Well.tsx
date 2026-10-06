// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createUniqueId } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './Well.module.css';

/**
 * `plain` padded content, `list` text rows (16 px sides), `controls` rows
 * ending in a control (closer to the right edge, matching the control's top
 * and bottom inset), `kv` key-value rows, `flush` full-bleed menu rows.
 */
export type WellLayout = 'plain' | 'list' | 'controls' | 'kv' | 'flush';

/** A sunken panel inside the glass. */
export function Well(props: {
  layout?: WellLayout;
  class?: string | undefined;
  testId?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class={[s['well'], props.class]} data-layout={props.layout ?? 'plain'} data-testid={props.testId}>
      {props.children}
    </div>
  );
}

/** A 48 px row: the label takes the space, the trailing control keeps its size. */
export function Row(props: {
  label: JSX.Element;
  children?: JSX.Element;
  class?: string | undefined;
  testId?: string;
}): JSX.Element {
  return (
    <div class={[s['row'], props.class]} data-testid={props.testId}>
      <span class={s['rowLabel']}>{props.label}</span>
      {props.children}
    </div>
  );
}

/**
 * A key and its mono value (code, so it reads as a value to copy). A
 * `copyable` row is the click target: it carries the pointer and underlines
 * its value on hover. Its value sits in a button stretched over the row, so
 * the keyboard reaches it and the click handler stays on the row.
 */
export function KeyValue(props: {
  k: string;
  v: JSX.Element;
  /** 24 px rows keyed by code, for long lists such as packages. */
  dense?: boolean;
  copyable?: boolean;
  title?: string | undefined;
  /** Announced politely after a click, such as "Copied". Empty reads nothing. */
  status?: string | undefined;
  onClick?: (() => void) | undefined;
  class?: string | undefined;
  testId?: string;
}): JSX.Element {
  const valueId = createUniqueId();
  return (
    <div
      onClick={() => {
        props.onClick?.();
      }}
      title={props.title}
      class={[s['kv'], props.class]}
      data-copyable={props.copyable === true ? '' : undefined}
      data-dense={props.dense === true ? '' : undefined}
      data-testid={props.testId}
    >
      <span class={s['key']}>{props.k}</span>
      {props.copyable === true ? (
        <button type="button" class={s['copy']} aria-label={`Copy ${props.k}`} aria-describedby={valueId}>
          <code id={valueId} class={s['value']}>
            {props.v}
          </code>
        </button>
      ) : (
        <code class={s['value']}>{props.v}</code>
      )}
      {props.copyable === true ? (
        <span role="status" class={s['srOnly']}>
          {props.status}
        </span>
      ) : undefined}
    </div>
  );
}

/** The info glyph that leads a Callout. */
export function InfoIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4m0-4h.01" />
    </svg>
  );
}

/** Supporting information in a well, led by an optional small icon. */
export function Callout(props: {
  icon?: JSX.Element;
  class?: string | undefined;
  testId?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class={[s['well'], s['callout'], props.class]} data-layout="plain" data-testid={props.testId}>
      {props.icon}
      <p class={s['calloutText']}>{props.children}</p>
    </div>
  );
}
