// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Errored, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';

export type RootBoundaryProps = {
  /** Tags the report, such as `island:AuthModal` or `popover:<id>`. */
  root: string;
  /** Stands in for what broke. Runs once, a microtask after the failure, so it may write stores or dispose the root. */
  onBroken?: (() => void) | undefined;
  children: JSX.Element;
};

/**
 * Renders `children`, or nothing once they throw. The failure is reported once under `root`, since Solid may run the
 * fallback again, and other roots keep working.
 */
export function RootBoundary(props: RootBoundaryProps): JSX.Element {
  let broken = false;
  return (
    <Errored
      fallback={err => {
        if (!broken) {
          broken = true;
          const root = untrack(() => props.root);
          const onBroken = untrack(() => props.onBroken);
          captureException(err(), { flow: 'ui', step: 'root_render', tags: { root } });
          queueMicrotask(() => {
            onBroken?.();
          });
        }
        return null;
      }}
    >
      {props.children}
    </Errored>
  );
}
