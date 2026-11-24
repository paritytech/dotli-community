// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { columnStyle } from './customStyles.js';
import type { KindValue } from './types.js';
import s from './ColumnNode.module.css';

/** A product's column, which places its children top to bottom by its alignment and arrangement. */
export function ColumnNode(props: { value: KindValue<'Column'>; children?: JSX.Element }): JSX.Element {
  return (
    <div
      class={s['column']}
      data-testid="chat-custom-column"
      style={columnStyle(
        props.value.props.horizontalAlignment,
        props.value.props.verticalArrangement,
        props.value.modifiers,
      )}
    >
      {props.children}
    </div>
  );
}
