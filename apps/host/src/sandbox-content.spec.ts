// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { BlockOrigin } from '@dotli/bitswap';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { startSandboxContent, type SandboxContentDeps } from './sandbox-content.js';

function setup(cached: boolean): {
  deps: SandboxContentDeps;
  serve: (from: BlockOrigin) => void;
  sandboxDone: () => void;
  runIdle: () => void;
  debug: DotliDebugEvent[];
} {
  const debug: DotliDebugEvent[] = [];
  const done: (() => void)[] = [];
  const idle: (() => void)[] = [];
  const served = new Set<(from: BlockOrigin) => void>();
  const deps: SandboxContentDeps = {
    relay: {
      onServed: listener => {
        served.add(listener);
        return () => {
          served.delete(listener);
        };
      },
    },
    cached,
    onSandboxDone: callback => {
      done.push(callback);
    },
    prune: vi.fn(),
    idle: callback => {
      idle.push(callback);
    },
    emit: event => {
      debug.push(event);
    },
    flowId: 'boot-1',
  };
  startSandboxContent(deps);
  return {
    deps,
    serve: from => {
      for (const listener of served) {
        listener(from);
      }
    },
    sandboxDone: () => {
      for (const callback of done.splice(0)) {
        callback();
      }
    },
    runIdle: () => {
      for (const callback of idle.splice(0)) {
        callback();
      }
    },
    debug,
  };
}

describe('startSandboxContent', () => {
  it('As a developer, I see where the blocks came from once the sandbox is done, and the cache is trimmed when idle', () => {
    // Given
    const { deps, serve, sandboxDone, runIdle, debug } = setup(true);
    serve('cache');
    serve('cache');
    serve('network');

    // When
    sandboxDone();
    runIdle();

    // Then
    expect(debug.map(event => event.payload)).toEqual([{ hits: 2, misses: 1 }]);
    expect(deps.prune).toHaveBeenCalledTimes(1);
  });

  it('As a developer on an app that needed no blocks, I see no block count and the cache is left alone', () => {
    // Given
    const { deps, sandboxDone, runIdle, debug } = setup(true);

    // When
    sandboxDone();
    runIdle();

    // Then
    expect(debug).toEqual([]);
    expect(deps.prune).not.toHaveBeenCalled();
  });

  it('As a visitor with the archive cache turned off, I get every block from the network and nothing is counted', () => {
    // Given
    const { serve, sandboxDone, runIdle, debug, deps } = setup(false);
    serve('network');

    // When
    sandboxDone();
    runIdle();

    // Then
    expect(debug).toEqual([]);
    expect(deps.prune).not.toHaveBeenCalled();
  });

  it('As the operator, I see one block cache read per load, a hit only when no block came from the network', () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const fromCache = setup(true);
    const mixed = setup(true);
    fromCache.serve('cache');
    mixed.serve('cache');
    mixed.serve('network');

    // When
    fromCache.sandboxDone();
    mixed.sandboxDone();

    // Then
    expect(metrics.counted('cache.read')).toEqual([
      expect.objectContaining({ outcome: 'hit', surface: 'block_cache' }),
      expect.objectContaining({ outcome: 'miss', surface: 'block_cache' }),
    ]);
  });
});
