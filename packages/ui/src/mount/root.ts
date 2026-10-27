// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createComponent } from 'solid-js';
import { render, type JSX } from '@solidjs/web';
import { RootBoundary } from './rootBoundary.js';

type Params = {
  /** The root's name, which a broken root is reported under. */
  name: string;
  /** The element the view renders into. */
  container: HTMLElement;
  /** Builds what the root renders. */
  view: () => JSX.Element;
  /** The container goes with the root, for one the caller made for it. */
  removeContainer?: boolean | undefined;
  /** Runs once the broken root is disposed. */
  onBroken?: (() => void) | undefined;
};

/**
 * Renders `view` into `container` inside a root boundary, so a view that throws renders nothing and other roots keep
 * working. A broken root is reported once under `name` and disposed a microtask later, since a root cannot dispose
 * inside its own boundary. The returned disposer may run more than once. A view that throws never makes it throw.
 */
export function mountRoot({ name, container, view, removeContainer = false, onBroken }: Params): () => void {
  let disposed = false;
  const disposeView = render(
    () =>
      createComponent(RootBoundary, {
        root: name,
        onBroken: () => {
          dispose();
          onBroken?.();
        },
        get children() {
          return view();
        },
      }),
    container,
  );

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    disposeView();
    if (removeContainer) {
      container.remove();
    }
  }

  return dispose;
}
