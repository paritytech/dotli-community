// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's root, which tears itself down once on a render error rather than stay frozen with its timers running.

import { createComponent, Errored } from 'solid-js';
import { render, type JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';

/**
 * Render `view` into `container`, returning a dispose that also removes the container and may run more than once.
 *
 * A throwing view renders nothing and is reported tagged with `name`. Solid may re-invoke the fallback, but a broken
 * root is handled once: it is disposed a microtask later, since a root cannot dispose inside its own boundary, and
 * then `onBroken` runs.
 */
export function mountRoot(
  name: string,
  container: HTMLElement,
  view: () => JSX.Element,
  onBroken: () => void,
): () => void {
  let broken = false;
  let disposed = false;
  const disposeView = render(
    () =>
      createComponent(Errored, {
        fallback: (err: () => unknown) => {
          if (!broken) {
            broken = true;
            captureException(err(), { flow: 'ui', step: 'root_render', tags: { root: name } });
            queueMicrotask(() => {
              dispose();
              onBroken();
            });
          }
          return null;
        },
        get children() {
          return view();
        },
      }),
    container,
  );
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    disposeView();
    container.remove();
  };
  return dispose;
}
