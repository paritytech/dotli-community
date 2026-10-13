// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A hydrated island's own error boundary. Code that never loaded never reaches it, so page start reports that.

import { createEffect, Errored } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';

/** Reports a failure inside once, under `root`, and renders nothing in its place. `onBroken` stands in for the island. */
export function IslandBoundary(props: { root: string; onBroken?: () => void; children: JSX.Element }): JSX.Element {
  return (
    <Errored fallback={err => <Broken root={props.root} error={err()} onBroken={props.onBroken} />}>
      {props.children}
    </Errored>
  );
}

function Broken(props: { root: string; error: unknown; onBroken: (() => void) | undefined }): JSX.Element {
  createEffect(
    () => props.error,
    error => {
      captureException(error, { flow: 'ui', step: 'root_render', tags: { root: props.root } });
      props.onBroken?.();
    },
  );
  return null;
}
