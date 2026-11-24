// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './MaterialsNode.module.css';

/** A product's materials node. The host has no materials renderer yet, so the children draw without the layers. */
export function MaterialsNode(props: { children?: JSX.Element }): JSX.Element {
  return (
    <div class={s['materials']} data-testid="chat-custom-materials">
      {props.children}
    </div>
  );
}
