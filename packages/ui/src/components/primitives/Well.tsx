// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Well.module.css';

/**
 * `plain` padded content, `list` text rows, `controls` rows ending in a control (right inset matches
 * its vertical inset), `flush` full-bleed menu rows.
 */
export type WellLayout = 'plain' | 'list' | 'controls' | 'flush';

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

/** A row whose label takes the space while the trailing control keeps its size. */
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
