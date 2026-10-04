// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

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

export function KeyValue(props: {
  k: JSX.Element;
  v: JSX.Element;
  /** Package names and other code keys. */
  monoKey?: boolean;
  /** 24 px rows, for long lists such as packages. */
  dense?: boolean;
  class?: string | undefined;
  testId?: string;
}): JSX.Element {
  return (
    <div
      class={[s['kv'], props.class]}
      data-mono-key={props.monoKey === true ? '' : undefined}
      data-dense={props.dense === true ? '' : undefined}
      data-testid={props.testId}
    >
      <span class={s['key']}>{props.k}</span>
      <span class={s['value']}>{props.v}</span>
    </div>
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
