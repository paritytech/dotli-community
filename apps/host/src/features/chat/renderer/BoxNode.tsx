// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { boxStyle } from './customStyles.js';
import type { KindValue } from './types.js';
import s from './BoxNode.module.css';

/** A product's box, which stacks its children in one cell at its content alignment. */
export function BoxNode(props: { value: KindValue<'Box'>; children?: JSX.Element }): JSX.Element {
  return (
    <div
      class={s['box']}
      data-testid="chat-custom-box"
      style={boxStyle(props.value.props.contentAlignment, props.value.modifiers)}
    >
      {props.children}
    </div>
  );
}

/** The cell a box puts one child in, so every child overlays the others in the box's one cell. */
export function BoxCell(props: { children?: JSX.Element }): JSX.Element {
  return <div class={s['cell']}>{props.children}</div>;
}
