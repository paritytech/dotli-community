// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createListenerSet } from '@dotli/shared';
import type { BlockOrigin } from '@dotli/bitswap';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { startSandboxContent, type SandboxContentParams } from './startSandboxContent.js';
import { rethrow } from './testing/rethrow.js';
import type { SandboxLoadReport } from './watchSandboxLoad.js';

/** The sandbox content of one load, and the page events a case drives it with. */
type ContentStand = {
  params: SandboxContentParams;
  /** Serves a block to the sandbox from `from`. */
  serve: (from: BlockOrigin) => void;
  /** Tells the content the sandbox is done. */
  finishSandbox: () => void;
  /** Runs the work the content left for an idle moment. */
  runIdle: () => void;
  /** The debug events the content sent, in order. */
  debug: DotliDebugEvent[];
  /** How many listeners the sandbox's outcome still has. */
  outcomeListeners: () => number;
};

type Params = {
  /** Whether the archive cache is on. */
  cached: boolean;
  /** What the debug panel throws on each event, when it breaks. */
  emitError?: Error;
  /** Hears an error an outcome listener threw, as the subscription's owner does. */
  onListenerError?: (error: unknown) => void;
  /** Whether the sandbox's outcome came before the content started. */
  outcomeCame?: boolean;
};

/** The wall clock's reading on the page, which only the fake clock gives. */
const DONE_AT = 1_700_000_000_000;

describe('startSandboxContent', () => {
  it('As a developer, I see where the blocks came from once the sandbox is done, and the cache is trimmed when idle', () => {
    // Given
    const { params, serve, finishSandbox, runIdle, debug } = startContent({ cached: true });
    serve('cache');
    serve('cache');
    serve('network');

    // When
    finishSandbox();
    runIdle();

    // Then
    expect(debug.map(event => event.payload)).toEqual([{ hits: 2, misses: 1 }]);
    expect(params.prune).toHaveBeenCalledTimes(1);
  });

  it("As a developer, I finish the sandbox's load and the block count is stamped with that moment", () => {
    // Given
    const { serve, finishSandbox, debug } = startContent({ cached: true });
    serve('cache');

    // When
    finishSandbox();

    // Then
    expect(debug.map(event => event.timestamp)).toEqual([DONE_AT]);
  });

  it('As a developer on an app that needed no blocks, I see no block count and the cache is left alone', () => {
    // Given
    const { params, finishSandbox, runIdle, debug } = startContent({ cached: true });

    // When
    finishSandbox();
    runIdle();

    // Then
    expect(debug).toEqual([]);
    expect(params.prune).not.toHaveBeenCalled();
  });

  it('As a visitor with the archive cache turned off, I get every block from the network and nothing is counted', () => {
    // Given
    const { serve, finishSandbox, runIdle, debug, params } = startContent({ cached: false });
    serve('network');

    // When
    finishSandbox();
    runIdle();

    // Then
    expect(debug).toEqual([]);
    expect(params.prune).not.toHaveBeenCalled();
  });

  it('As an operator, I watch two loads finish and see one block cache read each, a hit only when no block came from the network', () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const fromCache = startContent({ cached: true });
    const mixed = startContent({ cached: true });
    fromCache.serve('cache');
    mixed.serve('cache');
    mixed.serve('network');

    // When
    fromCache.finishSandbox();
    mixed.finishSandbox();

    // Then
    expect(metrics.counted('cache.read')).toEqual([
      expect.objectContaining({ outcome: 'hit', surface: 'block_cache' }),
      expect.objectContaining({ outcome: 'miss', surface: 'block_cache' }),
    ]);
  });

  it("As an operator, I see a block count that threw once the sandbox was done reach the outcome subscription's owner", () => {
    // Given a debug panel that throws on each event
    const broken = new TypeError('debug panel broke');
    const heardErrors: unknown[] = [];
    const { serve, finishSandbox, runIdle, params } = startContent({
      cached: true,
      emitError: broken,
      onListenerError: error => heardErrors.push(error),
    });
    serve('cache');

    // When the sandbox is done and the page goes idle
    finishSandbox();
    runIdle();

    // Then the owner heard the throw and the cache is left alone
    expect(heardErrors).toEqual([broken]);
    expect(params.prune).not.toHaveBeenCalled();
  });

  it('As a developer, I see a second outcome of the sandbox add no second block count', () => {
    // Given
    const { serve, finishSandbox, debug } = startContent({ cached: true });
    serve('cache');
    finishSandbox();

    // When
    finishSandbox();

    // Then
    expect(debug).toHaveLength(1);
  });

  it('As a developer, I open a page whose sandbox was done already and its outcome is heard at once, with no subscription left and no block counted later', () => {
    // Given the outcome came before the content started
    const { serve, finishSandbox, outcomeListeners, debug } = startContent({ cached: true, outcomeCame: true });

    // When a block is served and a second outcome comes
    serve('cache');
    finishSandbox();

    // Then nothing was counted and the outcome has no listener left
    expect(debug).toEqual([]);
    expect(outcomeListeners()).toBe(0);
  });
});

/** Starts the sandbox content of one load over recording fakes, with the archive cache on when `cached`. */
function startContent({ cached, emitError, onListenerError, outcomeCame = false }: Params): ContentStand {
  const debug: DotliDebugEvent[] = [];
  const outcomes = createListenerSet<SandboxLoadReport>({ onListenerError: onListenerError ?? rethrow });
  let latest: SandboxLoadReport | null = outcomeCame ? { outcome: 'loaded', failedStep: undefined } : null;
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
    subscribeOutcomes(listener) {
      if (latest !== null) {
        outcomes.deliver(listener, latest);
      }
      return outcomes.subscribe(listener);
    },
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
    finishSandbox() {
      latest = { outcome: 'loaded', failedStep: undefined };
      outcomes.emit(latest);
    },
    runIdle() {
      for (const callback of idle.splice(0)) {
        callback();
      }
    },
    outcomeListeners: () => outcomes.size,
    debug,
  };
}
