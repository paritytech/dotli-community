// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createComponent, Errored } from 'solid-js';
import { render, type JSX } from '@solidjs/web';
import { ReporterContext } from '../components/reporter-context.js';
import { disposeAppRoot, registerAppRoot, type Reporter } from '@dotli/ui-core';

export interface MountRootOptions {
  /** Takes the root's render and disposal failures, and the surfaces inside it report through it too. */
  report: Reporter;
  /** Runs inside the error boundary on the first render error, while the view's nodes are still in place. */
  onError?: () => void;
  /** Runs after the broken root is disposed, a microtask later since a root cannot dispose inside its own boundary. */
  onBroken?: () => void;
  removeContainer?: boolean;
  /** The root is the page's own content, which a full-page screen takes down. */
  content?: boolean;
}

/**
 * A throwing view renders nothing, so other roots keep working, and the owner recovers in `onBroken`.
 * Solid may re-invoke the fallback, but a broken root is handled once. The disposer may run more than once.
 */
export function mountRoot(
  name: string,
  container: HTMLElement,
  view: () => JSX.Element,
  options: MountRootOptions,
): () => void {
  const { report } = options;
  disposeAppRoot(name);
  let broken = false;
  const disposeView = render(
    () =>
      createComponent(Errored, {
        fallback: (err: () => unknown) => {
          if (!broken) {
            broken = true;
            report.failure(err(), { flow: 'ui', step: 'root_render', tags: { root: name } });
            options.onError?.();
            queueMicrotask(() => {
              dispose();
              options.onBroken?.();
            });
          }
          return null;
        },
        get children() {
          return createComponent(ReporterContext, {
            value: report,
            get children() {
              return view();
            },
          });
        },
      }),
    container,
  );
  const dispose = registerAppRoot(
    name,
    () => {
      disposeView();
      if (options.removeContainer === true) {
        container.remove();
      }
    },
    report.failure,
    { content: options.content === true },
  );
  return dispose;
}
