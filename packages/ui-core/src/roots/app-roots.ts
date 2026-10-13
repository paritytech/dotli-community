// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whatever replaces a root disposes it through here rather than removing its nodes, so its timers and
// listeners stop.
import type { ReportFailure } from '../report.js';

interface AppRoot {
  dispose: () => void;
  /** Whoever registered the root says where a throw from its disposer goes. */
  report: ReportFailure;
  content: boolean;
}

export interface AppRootOptions {
  /** The root renders the page's own content, which a full-page screen replaces. */
  content?: boolean;
}

const roots = new Map<string, AppRoot>();

/** The returned disposer runs `dispose` once and drops the root unless another has taken the name since. */
export function registerAppRoot(
  name: string,
  dispose: () => void,
  report: ReportFailure,
  options: AppRootOptions = {},
): () => void {
  disposeAppRoot(name);
  // Again, for a root the old disposer registered under this name on its way out, which would
  // otherwise be overwritten below undisposed.
  disposeAppRoot(name);
  let done = false;
  const disposeThis = (): void => {
    if (roots.get(name)?.dispose === disposeThis) {
      roots.delete(name);
    }
    if (!done) {
      done = true;
      dispose();
    }
  };
  roots.set(name, { dispose: disposeThis, report, content: options.content === true });
  return disposeThis;
}

/** Never throws, so an error page replacing a root with a failing disposer still renders. */
export function disposeAppRoot(name: string): void {
  const root = roots.get(name);
  try {
    root?.dispose();
  } catch (err) {
    root?.report(err, {
      flow: 'ui',
      step: 'root_dispose',
      tags: { root: name, kind: 'app_root_dispose_error' },
    });
  }
}

/** Disposes every content root, as a full-page screen takes the page over. Newest first, as a later root may build on an earlier one. */
export function disposeContentRoots(): void {
  for (const [name, root] of [...roots].reverse()) {
    if (root.content) {
      disposeAppRoot(name);
    }
  }
}
