// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { modifierStyle } from './customStyles.js';
import type { KindValue } from './types.js';
import s from './SpacerNode.module.css';

/** A product's spacer, which takes the free space of the row or column around it. */
export function SpacerNode(props: { value: KindValue<'Spacer'> }): JSX.Element {
  return <div class={s['spacer']} data-testid="chat-custom-spacer" style={modifierStyle(props.value.modifiers)} />;
}
