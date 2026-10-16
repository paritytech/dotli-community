// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, onTestFinished } from 'vitest';

import type { ChainLifecycle } from '@parity/truapi-provider';
import { getActiveServicesConfig } from '@dotli/config';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { bindLogSink, type LogLevel } from '@dotli/shared';

import {
  createChainSyncReporter,
  type ChainSyncReporter,
  type ChainSyncTap,
  type ParsedRpcMessage,
} from './chain-sync.js';

// History and opt-ins belong to the reporter, so each test builds its own.
let reporter: ChainSyncReporter;

beforeEach(() => {
  reporter = createChainSyncReporter({ askPeers: true });
});

type Lifecycle = ChainLifecycle;

/**
 * Stands in for a truapi-provider connection. `deliver` plays a response through the tap as `./provider`
 * does, and whatever the tap does not claim would have reached polkadot-api.
 */
interface Pipe {
  tap: ChainSyncTap;
  sent: string[];
  forwarded: string[];
  closed(): boolean;
  push(...states: Lifecycle[]): Promise<void>;
  deliver(raw: string): boolean;
}

function openPipe(chain: 'relay' | 'assethub', from: ChainSyncReporter = reporter): Pipe | null {
  const sent: string[] = [];
  const forwarded: string[] = [];
  const queued: (Lifecycle | undefined)[] = [];
  let waiting: ((state: Lifecycle | undefined) => void) | null = null;
  // The tap asks for its next state only after it has applied the one it was handed.
  let asked: (() => void) | null = null;
  let closed = false;
  const offer = (state: Lifecycle | undefined): void => {
    if (waiting === null) {
      queued.push(state);
      return;
    }
    const resolve = waiting;
    waiting = null;
    resolve(state);
  };
  const tap = from.attachChainSync(
    chain,
    raw => sent.push(raw),
    () => ({
      next: () => {
        asked?.();
        asked = null;
        return queued.length > 0
          ? Promise.resolve(queued.shift())
          : new Promise(resolve => {
              waiting = resolve;
            });
      },
      close: () => {
        closed = true;
        offer(undefined);
      },
    }),
  );
  if (tap === null) {
    return null;
  }
  return {
    tap,
    sent,
    forwarded,
    closed: () => closed,
    async push(...states: Lifecycle[]): Promise<void> {
      for (const state of states) {
        const applied = new Promise<void>(resolve => {
          asked = resolve;
        });
        offer(state);
        await applied;
      }
    },
    deliver(raw: string): boolean {
      const claimed = tap.intercept(JSON.parse(raw) as ParsedRpcMessage);
      if (!claimed) {
        forwarded.push(raw);
      }
      return claimed;
    },
  };
}

/** Open a pipe that the test has already opted into reporting. */
function requirePipe(chain: 'relay' | 'assethub', from: ChainSyncReporter = reporter): Pipe {
  const pipe = openPipe(chain, from);
  if (pipe === null) {
    throw new Error(`${chain} was not opted into sync reporting`);
  }
  return pipe;
}

/** The whole chain state, as the watch reports it every time. */
function state(phase: Lifecycle['phase'], peers: number, health: Lifecycle['health'] = { kind: 'ok' }): Lifecycle {
  return { phase, peers, health };
}

const CONNECTING = { kind: 'connecting' } as const;
const READY = { kind: 'ready' } as const;
const syncing = (at: number, target: number) => ({ kind: 'syncing', at, target }) as const;
const OK = { kind: 'ok' } as const;
const stalled = (reason: 'noPeers' | 'noProgress') => ({ kind: 'stalled', reason }) as const;

describe('Light client sync reporting works', () => {
  it('As a user waiting for a domain, the shell learns when the first peer arrives and when the chain is ready', async () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    const seen: unknown[] = [];
    reporter.onChainSync(event => seen.push(event));

    // When
    await pipe.push(state(CONNECTING, 0), state(READY, 2));

    // Then
    expect(seen).toEqual([
      { chain: 'relay', kind: 'peers', peers: 0, isSyncing: true },
      { chain: 'relay', kind: 'connecting' },
      { chain: 'relay', kind: 'firstPeer' },
      { chain: 'relay', kind: 'peers', peers: 2, isSyncing: false },
      { chain: 'relay', kind: 'bootstrapComplete' },
    ]);
  });

  it('As a user on a chain with real catching up to do, the shell learns how far along the warp is', async () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    const seen: unknown[] = [];
    reporter.onChainSync(event => seen.push(event));

    // When
    await pipe.push(state(syncing(20, 100), 3), state(syncing(75, 100), 3));

    // Then
    expect(seen).toEqual([
      { chain: 'relay', kind: 'firstPeer' },
      { chain: 'relay', kind: 'peers', peers: 3, isSyncing: true },
      { chain: 'relay', kind: 'warpSyncProgress', at: 20, target: 100 },
      { chain: 'relay', kind: 'warpSyncProgress', at: 75, target: 100 },
    ]);
  });

  it('As a user whose relay finishes warping, the shell learns where the warp landed before the chain reports ready', async () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    const seen: unknown[] = [];
    reporter.onChainSync(event => seen.push(event));

    // When
    await pipe.push(state(syncing(980, 1000), 3), state(READY, 3));

    // Then
    expect(seen).toEqual([
      { chain: 'relay', kind: 'firstPeer' },
      { chain: 'relay', kind: 'peers', peers: 3, isSyncing: true },
      { chain: 'relay', kind: 'warpSyncProgress', at: 980, target: 1000 },
      { chain: 'relay', kind: 'warpSyncFinished', finalized: 980 },
      { chain: 'relay', kind: 'bootstrapComplete' },
    ]);
  });

  it('As a user on a chain that never warped, the shell reports no warp milestones at all', async () => {
    // Given
    reporter.enableSyncReporting(['assethub']);
    const pipe = requirePipe('assethub');
    const seen: unknown[] = [];
    reporter.onChainSync(event => seen.push(event));

    // When
    await pipe.push(state(CONNECTING, 0), state(READY, 1));

    // Then
    expect(seen).toEqual([
      { chain: 'assethub', kind: 'peers', peers: 0, isSyncing: true },
      { chain: 'assethub', kind: 'connecting' },
      { chain: 'assethub', kind: 'firstPeer' },
      { chain: 'assethub', kind: 'peers', peers: 1, isSyncing: false },
      { chain: 'assethub', kind: 'bootstrapComplete' },
    ]);
  });

  it('As a user whose connection drops mid-sync, the shell learns why it stalled and when it recovered', async () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    const seen: unknown[] = [];
    reporter.onChainSync(event => seen.push(event));

    // When
    await pipe.push(
      state(syncing(10, 50), 1, OK),
      state(syncing(10, 50), 0, stalled('noPeers')),
      state(syncing(10, 50), 2, OK),
    );

    // Then
    expect(seen).toEqual([
      { chain: 'relay', kind: 'firstPeer' },
      { chain: 'relay', kind: 'peers', peers: 1, isSyncing: true },
      { chain: 'relay', kind: 'warpSyncProgress', at: 10, target: 50 },
      { chain: 'relay', kind: 'peers', peers: 0, isSyncing: true },
      { chain: 'relay', kind: 'warpSyncProgress', at: 10, target: 50 },
      { chain: 'relay', kind: 'stalled', reason: 'noPeers' },
      { chain: 'relay', kind: 'peers', peers: 2, isSyncing: true },
      { chain: 'relay', kind: 'warpSyncProgress', at: 10, target: 50 },
      { chain: 'relay', kind: 'recovered', reason: 'noPeers' },
    ]);
  });

  it('As a user whose stall changes cause, I am told the new reason rather than the old one', async () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    const seen: unknown[] = [];
    reporter.onChainSync(event => seen.push(event));

    // When
    await pipe.push(state(syncing(10, 50), 0, stalled('noPeers')), state(syncing(10, 50), 1, stalled('noProgress')));

    // Then
    expect(seen.filter(e => (e as { kind: string }).kind === 'stalled')).toEqual([
      { chain: 'relay', kind: 'stalled', reason: 'noPeers' },
      { chain: 'relay', kind: 'stalled', reason: 'noProgress' },
    ]);
  });

  it('As a user with a steady connection, the peer count only changes when the number really changes', async () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    const seen: unknown[] = [];
    reporter.onChainSync(event => seen.push(event));

    // When
    await pipe.push(
      state(CONNECTING, 2),
      state(CONNECTING, 2, stalled('noProgress')),
      state(CONNECTING, 5, stalled('noProgress')),
    );

    // Then
    expect(seen.filter(e => (e as { kind: string }).kind === 'peers')).toEqual([
      { chain: 'relay', kind: 'peers', peers: 2, isSyncing: true },
      { chain: 'relay', kind: 'peers', peers: 5, isSyncing: true },
    ]);
  });

  it('As a user opening the loading screen late, I see the newest sync state rather than a replay of every step', async () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    await pipe.push(state(CONNECTING, 0), state(syncing(1, 4), 1), state(READY, 4));

    // When
    const seen: unknown[] = [];
    reporter.onChainSync(event => seen.push(event));

    // Then
    expect(seen).toEqual([
      { chain: 'relay', kind: 'peers', peers: 4, isSyncing: false },
      { chain: 'relay', kind: 'connecting' },
      { chain: 'relay', kind: 'firstPeer' },
      { chain: 'relay', kind: 'warpSyncProgress', at: 1, target: 4 },
      { chain: 'relay', kind: 'warpSyncFinished', finalized: 1 },
      { chain: 'relay', kind: 'bootstrapComplete' },
    ]);
  });

  it('As a user whose sync recovered before I looked, I am not told it is still stalled', async () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    await pipe.push(state(syncing(10, 50), 0, stalled('noProgress')), state(syncing(10, 50), 2, OK));

    // When
    const seen: unknown[] = [];
    reporter.onChainSync(event => seen.push(event));

    // Then
    expect(seen).toContainEqual({
      chain: 'relay',
      kind: 'recovered',
      reason: 'noProgress',
    });
    expect(seen).not.toContainEqual(expect.objectContaining({ kind: 'stalled' }));
  });

  it('As a maintainer, the peers a chain held when it came up are recorded once', async () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    const details: unknown[] = [];
    reporter.onChainDetail(detail => details.push(detail));

    // When
    await pipe.push(state(READY, 1), state(syncing(5, 9), 1), state(READY, 1));
    const claimed = pipe.deliver(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '__dotli_peers__:relay',
        result: [{ peerId: '12D3KooW', roles: 'FULL', bestNumber: 9 }],
      }),
    );

    // Then
    expect(pipe.sent.filter(raw => raw.includes('system_peers'))).toHaveLength(1);
    expect(claimed).toBe(true);
    expect(details).toEqual([
      {
        chain: 'relay',
        peers: [{ peerId: '12D3KooW', roles: 'FULL', bestNumber: 9 }],
      },
    ]);
  });

  it('As a user on a build without metrics, the chain is never asked for its peers', async () => {
    // Given
    const quiet = createChainSyncReporter({ askPeers: false });
    quiet.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay', quiet);

    // When
    await pipe.push(state(READY, 1));

    // Then
    expect(pipe.sent).toEqual([]);
  });

  it('As a user loading an app, the sync questions the shell asks never reach the chain traffic of the app', async () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    const appResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: '1-42',
      result: '0x00',
    });

    // When
    await pipe.push(state(READY, 1));
    pipe.deliver(appResponse);

    // Then
    expect(pipe.forwarded).toEqual([appResponse]);
  });

  it('As a user leaving the page, stopping the tap closes the lifecycle watch', () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');

    // When
    pipe.tap.stop();

    // Then
    expect(pipe.closed()).toBe(true);
  });
});

describe('Light client sync reporting is opt-in', () => {
  it('As a user, chains my loading screen never shows are not watched', () => {
    // Given
    reporter.enableSyncReporting(['assethub']);

    // When
    const pipe = openPipe('relay');

    // Then
    expect(pipe).toBeNull();
  });

  it('As a user on a shell with no loading screen to feed, no chain is watched at all', () => {
    // Given
    const pipe = openPipe('relay');

    // Then
    expect(pipe).toBeNull();
  });

  it('As a user, a chain that refuses a lifecycle watch still passes its traffic through', () => {
    // Given
    reporter.enableSyncReporting(['relay']);
    const tap = reporter.attachChainSync(
      'relay',
      () => undefined,
      () => {
        throw new Error('chain is not connected');
      },
    );
    const appResponse = { jsonrpc: '2.0', id: '1-1', result: '0x00' };

    // Then
    expect(tap?.intercept(appResponse)).toBe(false);
  });
});

/** Every line the logger hands its sink, until the test ends. `next` resolves on the next one. */
function recordLogLines(): {
  lines: { level: LogLevel; message: string; attrs: Record<string, unknown> | undefined }[];
  next: () => Promise<void>;
} {
  const lines: { level: LogLevel; message: string; attrs: Record<string, unknown> | undefined }[] = [];
  let heard: (() => void) | null = null;
  onTestFinished(
    bindLogSink({
      emit: (level, message, attrs) => {
        lines.push({ level, message, attrs });
        heard?.();
      },
    }),
  );
  return {
    lines,
    next: () =>
      new Promise(resolve => {
        heard = resolve;
      }),
  };
}

describe('An expected lifecycle watch state is a breadcrumb', () => {
  it('As a maintainer, I watch a chain that refuses a lifecycle watch and see a flow event, not a warning', () => {
    // Given sync reporting on the relay chain
    const log = recordLogLines();
    reporter.enableSyncReporting(['relay']);

    // When the chain refuses the watch
    reporter.attachChainSync(
      'relay',
      () => undefined,
      () => {
        throw new Error('chain is not connected');
      },
    );

    // Then the loading screen's fallback is recorded as progress, not as a failure
    expect(log.lines).toEqual([
      {
        level: 'info',
        message: 'Chain lifecycle watch unavailable',
        attrs: { flow: 'protocol', chain: 'relay', reason: 'chain is not connected' },
      },
    ]);
  });

  it('As a maintainer, I watch a lifecycle watch end in an error and see a flow event, not a warning', async () => {
    // Given sync reporting on the relay chain, and a watch whose stream fails
    const log = recordLogLines();
    const logged = log.next();
    reporter.enableSyncReporting(['relay']);

    // When the chain attaches and its watch fails
    reporter.attachChainSync(
      'relay',
      () => undefined,
      () => ({
        next: () => Promise.reject(new Error('chain removed')),
        close: () => undefined,
      }),
    );
    await logged;

    // Then the failure is recorded as progress, not as a warning
    expect(log.lines).toEqual([
      {
        level: 'info',
        message: 'Chain lifecycle watch ended',
        attrs: { flow: 'protocol', chain: 'relay', reason: 'chain removed' },
      },
    ]);
  });
});

describe('Chain detail reporting works', () => {
  it('As a maintainer, a second connection to the same chain cannot rewrite a warm start as cold', () => {
    // Given
    const genesis = getActiveServicesConfig().bulletin.genesis;
    const seen: unknown[] = [];
    reporter.onChainDetail(detail => seen.push(detail));

    // When
    reporter.reportDbCache(genesis, true);
    reporter.reportDbCache(genesis, false);

    // Then
    expect(seen).toEqual([{ chain: 'bulletin', dbCache: 'hit' }]);
  });

  it('As a maintainer, a panel opened late still shows the warm start rather than the later miss', () => {
    // Given
    const genesis = getActiveServicesConfig().bulletin.genesis;
    reporter.reportDbCache(genesis, true);
    reporter.reportDbCache(genesis, false);

    // When
    const seen: unknown[] = [];
    reporter.onChainDetail(detail => seen.push(detail));

    // Then
    expect(seen).toEqual([{ chain: 'bulletin', dbCache: 'hit' }]);
  });
});

interface ListenerReports {
  captured: { step: string; tags: Record<string, string> | undefined }[];
  errors: string[];
  metrics: RecordingSentry;
}

/** Record the captures, error lines and metrics a throwing listener leaves, until the test ends. */
function recordListenerReports(): ListenerReports {
  const captured: ListenerReports['captured'] = [];
  const errors: string[] = [];
  onTestFinished(
    bindCaptureSink({
      exception: (_err, ctx) => captured.push({ step: ctx.step, tags: ctx.tags }),
      expected: () => undefined,
    }),
  );
  onTestFinished(
    bindLogSink({
      emit: (level: LogLevel, message: string) => {
        if (level === 'error') {
          errors.push(message);
        }
      },
    }),
  );
  return { captured, errors, metrics: bindRecordingSentry({ onFinished: onTestFinished }) };
}

describe('A throwing chain sync listener is reported', () => {
  it('As a user on the loading screen, a sync listener that throws is reported and the next listener still hears the event', async () => {
    // Given a listener that throws on every event, and one after it
    const reports = recordListenerReports();
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    reporter.onChainSync(() => {
      throw new TypeError('listener broke');
    });
    const seen: unknown[] = [];
    reporter.onChainSync(event => seen.push(event));

    // When the chain connects
    await pipe.push(state(CONNECTING, 0));

    // Then the later listener heard both events and each throw was reported once
    expect(seen).toEqual([
      { chain: 'relay', kind: 'peers', peers: 0, isSyncing: true },
      { chain: 'relay', kind: 'connecting' },
    ]);
    expect(reports.captured).toEqual([
      { step: 'listener', tags: { owner: 'chain_sync.sync' } },
      { step: 'listener', tags: { owner: 'chain_sync.sync' } },
    ]);
    expect(reports.errors).toHaveLength(2);
    expect(reports.metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'chain_sync.sync' },
      { outcome: 'error', reason: 'TypeError', owner: 'chain_sync.sync' },
    ]);
  });

  it('As a maintainer, a detail listener that throws is reported and the next listener still gets the fact', () => {
    // Given a detail listener that throws, and one after it
    const reports = recordListenerReports();
    reporter.onChainDetail(() => {
      throw new RangeError('listener broke');
    });
    const seen: unknown[] = [];
    reporter.onChainDetail(detail => seen.push(detail));

    // When the database cache result arrives
    reporter.reportDbCache(getActiveServicesConfig().bulletin.genesis, true);

    // Then the later listener got it and the throw was reported
    expect(seen).toEqual([{ chain: 'bulletin', dbCache: 'hit' }]);
    expect(reports.captured).toEqual([{ step: 'listener', tags: { owner: 'chain_sync.detail' } }]);
    expect(reports.errors).toHaveLength(1);
    expect(reports.metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'RangeError', owner: 'chain_sync.detail' },
    ]);
  });

  it('As a listener that subscribes while a fact is delivered, I hear that fact once, as the replay', () => {
    // Given a listener that subscribes a second one when it hears the first fact
    const seen: unknown[] = [];
    let attached = false;
    reporter.onChainDetail(() => {
      if (!attached) {
        attached = true;
        reporter.onChainDetail(detail => seen.push(detail));
      }
    });

    // When the database cache result arrives
    reporter.reportDbCache(getActiveServicesConfig().bulletin.genesis, true);

    // Then the late listener heard it once
    expect(seen).toEqual([{ chain: 'bulletin', dbCache: 'hit' }]);
  });

  it('As a late subscriber that throws during the replay, I am reported, the rest of the replay still runs and I stay subscribed', async () => {
    // Given a chain that reported sync events and a database result before anyone listened
    const reports = recordListenerReports();
    reporter.enableSyncReporting(['relay']);
    const pipe = requirePipe('relay');
    await pipe.push(state(CONNECTING, 0));
    reporter.reportDbCache(getActiveServicesConfig().bulletin.genesis, false);

    // When listeners that throw on every call attach late
    const syncCalls: string[] = [];
    reporter.onChainSync(event => {
      syncCalls.push(event.kind);
      throw new Error('listener broke');
    });
    const detailCalls: unknown[] = [];
    reporter.onChainDetail(detail => {
      detailCalls.push(detail);
      throw new Error('listener broke');
    });
    await pipe.push(state(READY, 1));

    // Then each replayed and live call reached them and each throw was reported
    expect(syncCalls).toEqual(['peers', 'connecting', 'firstPeer', 'peers', 'bootstrapComplete']);
    expect(detailCalls).toEqual([{ chain: 'bulletin', dbCache: 'miss' }]);
    expect(reports.captured.map(({ tags }) => tags?.['owner'])).toEqual([
      'chain_sync.sync',
      'chain_sync.sync',
      'chain_sync.detail',
      'chain_sync.sync',
      'chain_sync.sync',
      'chain_sync.sync',
    ]);
    expect(reports.metrics.counted('listener.delivery')).toHaveLength(6);
  });
});
