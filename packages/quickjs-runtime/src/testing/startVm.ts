// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createManualTimers } from '@dotli/shared/testing';
import { onTestFinished } from 'vitest';

import { createQuickJsVm } from '../createQuickJsVm.js';
import type { ConsoleLevel } from '../installConsole.js';

type Params = {
  entrypoint?: string;
};

type Logged = {
  level: ConsoleLevel;
  message: string;
};

/**
 * A VM over `sources`, on Node's WebCrypto and manual timers, that records what it posts, logs and reports. It is
 * disposed when the test finishes.
 */
export async function startVm(sources: Record<string, string>, { entrypoint = 'main.js' }: Params = {}) {
  const encoder = new TextEncoder();
  const files = new Map(Object.entries(sources).map(([path, source]) => [path, encoder.encode(source)]));
  const errors: Error[] = [];
  const logs: Logged[] = [];
  const frames: Uint8Array[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const timers = createManualTimers();
  const vm = await createQuickJsVm({
    files,
    entrypoint,
    crypto: globalThis.crypto,
    timers,
    onError: error => errors.push(error),
    onConsole(level, message) {
      logs.push({ level, message });
      for (const waiter of waiters.filter(w => logs.length >= w.count)) {
        waiter.resolve();
      }
    },
  });
  onTestFinished(() => vm.dispose());
  vm.wire.subscribe(frame => frames.push(frame));

  return { vm, frames, errors, logs, timers, untilLogged, readMessages };

  /** Resolves once the VM has logged `count` messages in all. */
  function untilLogged(count: number): Promise<void> {
    return new Promise(resolve => {
      if (logs.length >= count) {
        resolve();
        return;
      }
      waiters.push({ count, resolve });
    });
  }

  /** The messages the VM logged, without their levels. */
  function readMessages(): string[] {
    return logs.map(logged => logged.message);
  }
}
