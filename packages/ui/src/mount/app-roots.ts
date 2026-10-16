// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whatever replaces a root disposes it through here rather than removing its nodes, so its timers and
// listeners stop. Solid-free because the host and sandbox startup paths register and dispose roots.
import { captureException } from '@dotli/metrics';

const disposers = new Map<string, () => void>();

/** The returned disposer runs `dispose` once and drops the root unless another has taken the name since. */
export function registerAppRoot(name: string, dispose: () => void): () => void {
  disposeAppRoot(name);
  // Again, for a root the old disposer registered under this name on its way out, which would
  // otherwise be overwritten below undisposed.
  disposeAppRoot(name);
  let done = false;
  const disposeThis = (): void => {
    if (disposers.get(name) === disposeThis) {
      disposers.delete(name);
    }
    if (!done) {
      done = true;
      dispose();
    }
  };
  disposers.set(name, disposeThis);
  return disposeThis;
}

/** Never throws, so an error page replacing a root with a failing disposer still renders. */
export function disposeAppRoot(name: string): void {
  try {
    disposers.get(name)?.();
  } catch (err) {
    captureException(err, {
      flow: 'ui',
      step: 'root_dispose',
      tags: { root: name, kind: 'app_root_dispose_error' },
    });
  }
}

export function disposeAppRoots(): void {
  disposeAppRoot('page');
  disposeAppRoot('loading');
}
