// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { RootBoundary } from '../../mount/rootBoundary.js';
import type { Anchored } from './createAnchored.js';

/**
 * Renders nothing until the first opening, so never in the server's render. A surface that throws is reported and
 * closed.
 */
export function SurfaceSlot(props: { state: Anchored; children: JSX.Element }): JSX.Element {
  return (
    <Show when={props.state.mounted()}>
      <RootBoundary root={`popover:${props.state.id}`} onBroken={props.state.fail}>
        {props.children}
      </RootBoundary>
    </Show>
  );
}
