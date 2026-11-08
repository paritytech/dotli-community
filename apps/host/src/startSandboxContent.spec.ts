// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDeferred } from '@dotli/shared';
import type { BlockOrigin } from '@dotli/bitswap';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { startSandboxContent, type SandboxContentParams } from './startSandboxContent.js';

/** The sandbox content of one load, and the page events a case drives it with. */
type ContentStand = {
  params: SandboxContentParams;
  /** Serves a block to the sandbox from `from`. */
  serve: (from: BlockOrigin) => void;
  /** Tells the content the sandbox is done, and waits for it to take the outcome. */
  finishSandbox: () => Promise<void>;
  /** Runs the work the content left for an idle moment. */
  runIdle: () => void;
  /** The debug events the content sent, in order. */
  debug: DotliDebugEvent[];
};

type Params = {
  /** Whether the archive cache is on. */
  cached: boolean;
  /** What the debug panel throws on each event, when it breaks. */
  emitError?: Error;
};

/** The wall clock's reading on the page, which only the fake clock gives. */
const DONE_AT = 1_700_000_000_000;

describe('startSandboxContent', () => {
  it('As a developer, I see where the blocks came from once the sandbox is done, and the cache is trimmed when idle', async () => {
    // Given
    const { params, serve, finishSandbox, runIdle, debug } = startContent({ cached: true });
    serve('cache');
    serve('cache');
    serve('network');

    // When
    await finishSandbox();
    runIdle();

    // Then
    expect(debug.map(event => event.payload)).toEqual([{ hits: 2, misses: 1 }]);
    expect(params.prune).toHaveBeenCalledTimes(1);
  });

  it("As a developer, I finish the sandbox's load and the block count is stamped with that moment", async () => {
    // Given
    const { serve, finishSandbox, debug } = startContent({ cached: true });
    serve('cache');

    // When
    await finishSandbox();

    // Then
    expect(debug.map(event => event.timestamp)).toEqual([DONE_AT]);
  });

  it('As a developer on an app that needed no blocks, I see no block count and the cache is left alone', async () => {
    // Given
    const { params, finishSandbox, runIdle, debug } = startContent({ cached: true });

    // When
    await finishSandbox();
    runIdle();

    // Then
    expect(debug).toEqual([]);
    expect(params.prune).not.toHaveBeenCalled();
  });

  it('As a visitor with the archive cache turned off, I get every block from the network and nothing is counted', async () => {
    // Given
    const { serve, finishSandbox, runIdle, debug, params } = startContent({ cached: false });
    serve('network');

    // When
    await finishSandbox();
    runIdle();

    // Then
    expect(debug).toEqual([]);
    expect(params.prune).not.toHaveBeenCalled();
  });

  it('As an operator, I watch two loads finish and see one block cache read each, a hit only when no block came from the network', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const fromCache = startContent({ cached: true });
    const mixed = startContent({ cached: true });
    fromCache.serve('cache');
    mixed.serve('cache');
    mixed.serve('network');

    // When
    await fromCache.finishSandbox();
    await mixed.finishSandbox();

    // Then
    expect(metrics.counted('cache.read')).toEqual([
      expect.objectContaining({ outcome: 'hit', surface: 'block_cache' }),
      expect.objectContaining({ outcome: 'miss', surface: 'block_cache' }),
    ]);
  });

  it('As an operator, I see a block count that threw once the sandbox was done reported as a defect of its content', async () => {
    // Given a debug panel that throws on each event
    const reports = recordReports({ onFinished: onTestFinished });
    const broken = new TypeError('debug panel broke');
    const { serve, finishSandbox, runIdle, params } = startContent({ cached: true, emitError: broken });
    serve('cache');

    // When the sandbox is done and the page goes idle
    await finishSandbox();
    runIdle();

    // Then the throw reaches the reporter and the cache is left alone
    await expect
      .poll(() => reports.exceptions)
      .toEqual([{ step: 'listener', error: broken, tags: { owner: 'sandbox_content.outcome' } }]);
    expect(params.prune).not.toHaveBeenCalled();
  });
});

/** Starts the sandbox content of one load over recording fakes, with the archive cache on when `cached`. */
function startContent({ cached, emitError }: Params): ContentStand {
  const debug: DotliDebugEvent[] = [];
  const done = createDeferred<undefined>();
  const idle: (() => void)[] = [];
  const served = new Set<(from: BlockOrigin) => void>();
  const params: SandboxContentParams = {
    relay: {
      onServed(listener) {
        served.add(listener);
        return () => {
          served.delete(listener);
        };
      },
    },
    cached,
    outcome: done.promise,
    prune: vi.fn(),
    runWhenIdle(callback) {
      idle.push(callback);
    },
    emit(event) {
      if (emitError !== undefined) {
        throw emitError;
      }
      debug.push(event);
    },
    flowId: 'boot-1',
    timers: { now: () => DONE_AT },
  };
  startSandboxContent(params);
  return {
    params,
    serve(from) {
      for (const listener of served) {
        listener(from);
      }
    },
    async finishSandbox() {
      done.resolve(undefined);
      await done.promise;
    },
    runIdle() {
      for (const callback of idle.splice(0)) {
        callback();
      }
    },
    debug,
  };
}
