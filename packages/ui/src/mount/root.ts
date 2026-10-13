// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createComponent, Errored } from 'solid-js';
import { render, type JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';

export interface MountRootOptions {
  /** The container goes with the root, for one the caller made for it. */
  removeContainer?: boolean;
}

/**
 * Renders `view` into `container` inside an error boundary, so a view that throws renders nothing and other roots keep
 * working. A broken root is reported once under `name` and disposed a microtask later, since a root cannot dispose
 * inside its own boundary. The returned disposer may run more than once.
 */
export function mountRoot(
  name: string,
  container: HTMLElement,
  view: () => JSX.Element,
  options: MountRootOptions = {},
): () => void {
  let broken = false;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    disposeView();
    if (options.removeContainer === true) {
      container.remove();
    }
  };
  const disposeView = render(
    () =>
      createComponent(Errored, {
        fallback: (err: () => unknown) => {
          if (!broken) {
            broken = true;
            captureException(err(), { flow: 'ui', step: 'root_render', tags: { root: name } });
            queueMicrotask(dispose);
          }
          return null;
        },
        get children() {
          return view();
        },
      }),
    container,
  );
  return dispose;
}
