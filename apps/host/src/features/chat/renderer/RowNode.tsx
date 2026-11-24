// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { rowStyle } from './customStyles.js';
import type { KindValue } from './types.js';
import s from './RowNode.module.css';

/** A product's row, which places its children side by side by its arrangement and alignment. */
export function RowNode(props: { value: KindValue<'Row'>; children?: JSX.Element }): JSX.Element {
  return (
    <div
      class={s['row']}
      data-testid="chat-custom-row"
      style={rowStyle(
        props.value.props.horizontalArrangement,
        props.value.props.verticalAlignment,
        props.value.modifiers,
      )}
    >
      {props.children}
    </div>
  );
}
