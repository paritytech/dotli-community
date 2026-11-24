// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { textStyle } from './customStyles.js';
import type { KindValue } from './types.js';
import s from './TextNode.module.css';

/** A product's text, in its typography style and colour token, or else the message's own type. */
export function TextNode(props: { value: KindValue<'Text'>; children?: JSX.Element }): JSX.Element {
  return (
    <span
      class={s['text']}
      data-testid="chat-custom-text"
      style={textStyle(props.value.props.style, props.value.props.color, props.value.modifiers)}
    >
      {props.children}
    </span>
  );
}
