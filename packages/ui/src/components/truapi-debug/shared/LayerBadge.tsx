// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './LayerBadge.module.css';

/** The part of dotli a system event came from, such as boot or bridge, each in its own colour. */
export function LayerBadge(props: { layer: string; title?: string | undefined }): JSX.Element {
  return (
    <span class={s['layer']} data-testid="td-layer-badge" data-layer={props.layer} title={props.title}>
      {props.layer}
    </span>
  );
}
