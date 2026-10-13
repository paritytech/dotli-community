// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { getActiveServicesConfig, SITE_ID, configureModeStorage } from '@dotli/config';
import { memoryModeStorage } from '@dotli/config/testing';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { SHARED_CORE_SESSION_KEY } from './auth-storage.js';
import type { RemoteChainHalt } from '@dotli/chains';
import { createProtocolClient, type ProtocolStatus, type SharedStoreStatus } from './client.js';
import { PROTOCOL_ERRORS } from './errors.js';
import { createProtocolFrame } from './frame.js';
import type { ProtocolEnvelope, ProtocolRequestEnvelope } from './messages.js';
import { createFrameDom, createFrameHost, FRAME_CONFIG, type FrameHost } from './testing/frame-host.js';

// Settings come from a memory store, not Node's localStorage, and the previous store is put back after each test.
beforeEach(() => configureModeStorage(memoryModeStorage()));

describe('createProtocolFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('As a dotli integrator, I hear only what the current frame sends from its origin', async () => {
    // Given
    const dom = createFrameDom();
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    const heard: ProtocolEnvelope['kind'][] = [];
    frame.onEnvelope(envelope => heard.push(envelope.kind));
    void frame.whenUp('listening');
    await vi.advanceTimersByTimeAsync(0);
    const stranger = dom.stranger();

    // When
    dom.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    dom.deliver({ namespace: 'dotli:protocol', kind: 'ready' }, stranger);
    dom.deliver({ namespace: 'dotli:protocol', kind: 'ready' }, dom.iframe(), 'https://evil.example');

    // Then
    expect(heard).toEqual(['listening']);
    expect(frame.getStatus()).toBe('listening');
  });

  it('As a dotli integrator, I wait for a listening frame without waiting for its light client', async () => {
    // Given
    const dom = createFrameDom();
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    const settled: string[] = [];
    void frame.whenUp('listening').then(() => settled.push('listening'));
    void frame.whenUp('ready').then(() => settled.push('ready'));
    await vi.advanceTimersByTimeAsync(0);

    // When
    dom.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    await vi.advanceTimersByTimeAsync(0);
    const afterListening = [...settled];
    dom.deliver({ namespace: 'dotli:protocol', kind: 'ready' });
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(afterListening).toEqual(['listening']);
    expect(settled).toEqual(['listening', 'ready']);
  });

  it('As a dotli integrator, I hear why a frame was dropped once its status says it is down', async () => {
    // Given
    const dom = createFrameDom();
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenUp('ready').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    dom.deliver({ namespace: 'dotli:protocol', kind: 'ready' });
    const lost: { message: string; status: ProtocolStatus }[] = [];
    frame.onLost(error => lost.push({ message: error.message, status: frame.getStatus() }));

    // When
    dom.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });

    // Then
    expect(lost).toEqual([{ message: 'Fatal: boom', status: 'failed' }]);
  });

  it('As a dotli integrator, I post with no frame and it fails at once', () => {
    // Given
    const frame = createProtocolFrame(createFrameDom().deps);
    frame.configure(FRAME_CONFIG);

    // When
    const post = (): void => {
      frame.post({ namespace: 'dotli:protocol', kind: 'request' });
    };

    // Then
    expect(post).toThrow(PROTOCOL_ERRORS.FRAME_UNAVAILABLE);
  });

  it('As a dotli integrator, I wait on a frame before it is configured, and it boots and answers once configured', async () => {
    // Given
    const dom = createFrameDom();
    const frame = createProtocolFrame(dom.deps);
    const up = frame.whenUp('listening');
    await vi.advanceTimersByTimeAsync(0);
    const framesBeforeConfig = dom.frames();

    // When
    frame.configure(FRAME_CONFIG);
    await vi.advanceTimersByTimeAsync(0);
    dom.deliver({ namespace: 'dotli:protocol', kind: 'listening' });

    // Then
    expect(framesBeforeConfig).toBe(0);
    await expect(up).resolves.toBeUndefined();
    expect(dom.frames()).toBe(1);
  });

  it('As a dotli user whose frame dies in the turn it starts listening, I get a rebuild after the first wait, not after the ready timeout', async () => {
    // Given: the keeper's ready wait begins on a frame already lost.
    const dom = createFrameDom();
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenUp('ready').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    // When
    dom.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    dom.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await vi.advanceTimersByTimeAsync(2_000);

    // Then
    expect(dom.frames()).toBe(1);
    expect(frame.getStatus()).toBe('booting');
  });

  it('As a dotli integrator, I lose a frame that fails the moment it is mounted and it leaves no load timer behind', async () => {
    // Given a page where the frame fails as it is mounted
    const dom = createFrameDom();
    const mount = dom.deps.document.body;
    const append = mount.appendChild.bind(mount);
    mount.appendChild = <T extends Node>(node: T): T => {
      append(node);
      node.dispatchEvent(new Event('error'));
      return node;
    };
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);

    // When
    const up = frame.whenUp('listening').then(
      () => null,
      (err: unknown) => err as Error,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Then the wait fails, and only the rebuild's wait is pending
    expect((await up)?.message).toContain(PROTOCOL_ERRORS.HOST_FRAME_LOAD_FAILED);
    expect(frame.getStatus()).toBe('failed');
    expect(vi.getTimerCount()).toBe(1);
  });
});

const READY_TIMEOUT_MS = 240_000;

describe('protocol status', () => {
  let host: FrameHost;

  beforeEach(() => {
    vi.useFakeTimers();
    host = createFrameHost();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Records what the frame posts and lets it say `kinds` in turn. */
  async function frameSays(...kinds: ('listening' | 'ready')[]): Promise<ProtocolRequestEnvelope[]> {
    await vi.advanceTimersByTimeAsync(0);
    const frameWindow = host.iframe().contentWindow;
    if (frameWindow === null) {
      throw new Error('protocol iframe has no window');
    }
    const posted: ProtocolRequestEnvelope[] = [];
    vi.spyOn(frameWindow, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as ProtocolRequestEnvelope);
    });
    for (const kind of kinds) {
      host.deliver({ namespace: 'dotli:protocol', kind });
    }
    await vi.advanceTimersByTimeAsync(0);
    return posted;
  }

  function settledWith(promise: Promise<unknown>): { outcome: string | null } {
    const result = { outcome: null as string | null };
    promise.then(
      () => {
        result.outcome = 'resolved';
      },
      (err: unknown) => {
        result.outcome = err instanceof Error ? err.message : String(err);
      },
    );
    return result;
  }

  it('As a dotli integrator, I follow the protocol status from idle to ready, and subscribing starts no frame', async () => {
    // Given
    const statuses: ProtocolStatus[] = [];
    host.client.subscribeProtocolStatus(status => statuses.push(status));
    await vi.advanceTimersByTimeAsync(0);
    const framesBeforeAsking = host.frames();

    // When
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(statuses).toEqual(['booting', 'listening', 'ready']);
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As a dotli user whose protocol frame fails its init, I see it reported failed and then rebuilt', async () => {
    // Given
    void host.client.ensureProtocolFrame().catch(() => undefined);
    await frameSays('listening');
    const dead = host.iframe();

    // When
    host.deliver({ namespace: 'dotli:protocol', kind: 'init-failed', message: 'no SharedWorker' });
    const statusAfterFailure = host.client.getProtocolStatus();
    await vi.advanceTimersByTimeAsync(2_000);
    await frameSays('listening', 'ready');

    // Then
    expect(statusAfterFailure).toBe('failed');
    expect(dead.isConnected).toBe(false);
    expect(host.iframe()).not.toBe(dead);
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As a dotli user, I make a request while the protocol frame is down and it fails at once with why it went down', async () => {
    // Given
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');
    host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });

    // When
    const read = settledWith(host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY));
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(read.outcome).toBe('Fatal: boom');
    expect(host.frames()).toBe(0);
  });

  it('As a dotli user, I make a request while the protocol frame boots and it waits, then fails as soon as that boot fails', async () => {
    // Given
    const warmup = settledWith(host.client.warmupProtocol());
    await frameSays('listening');
    const waitingWhileBooting = warmup.outcome;

    // When
    host.deliver({ namespace: 'dotli:protocol', kind: 'init-failed', message: 'bad network' });
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(waitingWhileBooting).toBeNull();
    expect(warmup.outcome).toBe('Init failed: bad network');
  });

  it('As a returning user whose protocol frame never reports ready, I get a rebuilt frame and my shared store back', async () => {
    // Given
    const statuses: SharedStoreStatus[] = [];
    host.client.subscribeSharedStoreStatus(status => statuses.push(status));
    const warmup = settledWith(host.client.warmupProtocol());
    await frameSays('listening');
    const dead = host.iframe();

    // When
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(2_000);
    await frameSays('listening');

    // Then
    expect(warmup.outcome).toBe(PROTOCOL_ERRORS.FRAME_READY_TIMEOUT);
    expect(dead.isConnected).toBe(false);
    expect(statuses).toEqual(['available', 'unavailable', 'available']);
  });

  it('As a dotli user whose light client dies soon after each rebuild, I wait longer before each new frame', async () => {
    // Given: a frame that comes up and dies at once.
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');
    const rebuildsAfter: number[] = [];

    // When: each rebuild comes up and dies at once too.
    for (let i = 0; i < 3; i++) {
      host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
      let waited = 0;
      while (host.frames() === 0 && waited < 60_000) {
        await vi.advanceTimersByTimeAsync(1_000);
        waited += 1_000;
      }
      expect(host.frames()).toBe(1);
      rebuildsAfter.push(waited);
      await frameSays('listening', 'ready');
    }

    // Then
    expect(rebuildsAfter).toEqual([2_000, 4_000, 8_000]);
  });

  it('As a dotli user whose protocol frame stayed up past 30 s, I get its rebuild after 2 s again', async () => {
    // Given: two quick deaths grew the wait, then a frame stayed up 30 s.
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');
    host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await vi.advanceTimersByTimeAsync(2_000);
    await frameSays('listening', 'ready');
    host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await vi.advanceTimersByTimeAsync(4_000);
    await frameSays('listening', 'ready');
    await vi.advanceTimersByTimeAsync(30_000);

    // When
    host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await vi.advanceTimersByTimeAsync(1_999);
    const framesBeforeWait = host.frames();
    await vi.advanceTimersByTimeAsync(1);

    // Then
    expect(framesBeforeWait).toBe(0);
    expect(host.frames()).toBe(1);
  });

  it('As a returning user, I change the frame config during my session and see the shared store down, then available', async () => {
    // Given
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');
    const statuses: SharedStoreStatus[] = [];
    host.client.subscribeSharedStoreStatus(status => statuses.push(status));

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });
    await frameSays('listening');

    // Then
    expect(statuses).toEqual(['unavailable', 'available']);
  });

  it('As a dotli integrator, I change the frame config and the chain connections of the dropped frame halt', async () => {
    // Given
    const provider = host.client.createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    provider(() => undefined, onHalt);
    const posted = await frameSays('listening', 'ready');
    const connect = posted.find(envelope => envelope.method === 'chainConnect');
    if (connect === undefined) {
      throw new Error('no chainConnect posted');
    }
    host.deliver({ namespace: 'dotli:protocol', kind: 'response', id: connect.id, ok: true, result: true });
    await vi.advanceTimersByTimeAsync(0);

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });

    // Then
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith('frame');
  });

  it('As a dotli user, I change the frame config and a late fatal from the dropped frame does not fail the rebuild', async () => {
    // Given: the dropped frame's fatal lands while the client has no frame.
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');
    const dead = host.iframe();
    host.client.subscribeProtocolStatus(next => {
      if (next === 'idle') {
        host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'late' }, dead);
      }
    });

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });
    const read = settledWith(host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY));
    await frameSays('listening');
    const posted = await frameSays();

    // Then
    expect(host.client.getProtocolStatus()).toBe('listening');
    expect(read.outcome).toBeNull();
    expect(posted).toEqual([]);
  });

  it('As a dotli integrator, I request from a status listener after a config change and see the statuses in order', async () => {
    // Given
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');
    const heard: ProtocolStatus[][] = [[], []];
    let request: Promise<void> | null = null;
    host.client.subscribeProtocolStatus(next => {
      heard[0]?.push(next);
      if (next === 'idle' && request === null) {
        request = host.client.ensureProtocolFrame();
      }
    });
    host.client.subscribeProtocolStatus(next => heard[1]?.push(next));

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });
    const framesAfterChange = host.frames();
    await frameSays('listening', 'ready');

    // Then
    expect(framesAfterChange).toBe(1);
    expect(heard[0]).toEqual(['idle', 'booting', 'listening', 'ready']);
    expect(heard[1]).toEqual(['idle', 'booting', 'listening', 'ready']);
    await expect(request).resolves.toBeUndefined();
  });

  it('As a dotli integrator, I request from an idle listener during a config change and the frame keeps one keeper', async () => {
    // Given: a second keeper would wait behind the first and rebuild the next lost frame at once.
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');
    host.client.subscribeProtocolStatus(next => {
      if (next === 'idle') {
        void host.client.ensureProtocolFrame().catch(() => undefined);
      }
    });
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });
    await frameSays('listening', 'ready');

    // When
    host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await vi.advanceTimersByTimeAsync(1_999);
    const framesBeforeWait = host.frames();
    await vi.advanceTimersByTimeAsync(1);

    // Then
    expect(framesBeforeWait).toBe(0);
    expect(host.frames()).toBe(1);
  });

  it('As a dotli user whose frame cannot be built, I see the real error and one keeper retries', async () => {
    // Given
    let builds = 0;
    const dom = createFrameDom();
    const failing = createProtocolClient({
      ...dom.deps,
      document: {
        createElement: () => {
          builds += 1;
          throw new Error('no iframe here');
        },
        body: dom.deps.document.body,
      },
    });
    failing.configureProtocolFrame(FRAME_CONFIG);

    // When
    const first = settledWith(failing.ensureProtocolFrame());
    const second = settledWith(failing.ensureProtocolFrame());
    await vi.advanceTimersByTimeAsync(0);
    const buildsAfterFirstAttempt = builds;
    await vi.advanceTimersByTimeAsync(2_000);

    // Then
    expect(first.outcome).toBe('no iframe here');
    expect(second.outcome).toBe('no iframe here');
    expect(buildsAfterFirstAttempt).toBe(1);
    expect(builds).toBe(2);
  });

  it('As a dotli user, I change the config during the wait before a rebuild and get a frame at once, and the dropped wait leaves no second rebuild', async () => {
    // Given: a retry left over from the dropped wait would rebuild the next lost frame at once.
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');
    host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await vi.advanceTimersByTimeAsync(1_000);

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });
    const mode = new URL(host.iframe().src).searchParams.get('mode');
    await frameSays('listening', 'ready');
    host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await vi.advanceTimersByTimeAsync(1_999);
    const framesBeforeWait = host.frames();
    await vi.advanceTimersByTimeAsync(1);

    // Then
    expect(mode).toBe('rpc');
    expect(framesBeforeWait).toBe(0);
    expect(host.frames()).toBe(1);
  });

  it('As a dotli integrator, I change the config and request from a failed listener and the request resolves', async () => {
    // Given
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');
    let request: Promise<void> | null = null;
    host.client.subscribeProtocolStatus(next => {
      if (next === 'failed' && request === null) {
        host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });
        request = host.client.ensureProtocolFrame();
      }
    });

    // When
    host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await frameSays('listening', 'ready');

    // Then
    await expect(request).resolves.toBeUndefined();
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As a dotli integrator, I change the config from a booting listener and one frame is kept, built with the new config', async () => {
    // Given
    let changes = 0;
    host.client.subscribeProtocolStatus(next => {
      if (next === 'booting' && changes === 0) {
        changes += 1;
        host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });
      }
    });

    // When
    void host.client.ensureProtocolFrame().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const framesAfterChange = host.frames();
    const mode = new URL(host.iframe().src).searchParams.get('mode');
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');

    // Then
    expect(framesAfterChange).toBe(1);
    expect(mode).toBe('rpc');
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As a dotli integrator, a status listener that throws is reported and counted, and the next listener still hears the change', async () => {
    // Given a first listener that throws on every change, and a reporting pipeline that records captures and counts
    const captures: { step: string; tags: Record<string, string> | undefined }[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: (_err, ctx) => {
          captures.push({ step: ctx.step, tags: ctx.tags });
        },
        expected: () => undefined,
      }),
    );
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    host.client.subscribeProtocolStatus(() => {
      throw new Error('listener broke');
    });
    const heard: ProtocolStatus[] = [];
    host.client.subscribeProtocolStatus(next => heard.push(next));

    // When
    void host.client.ensureProtocolFrame();
    await frameSays('listening');

    // Then the next listener heard each change, and each throw was captured once and counted once
    expect(heard).toEqual(['booting', 'listening']);
    expect(captures).toEqual([
      { step: 'frame_status_listener', tags: { status: 'booting' } },
      { step: 'frame_status_listener', tags: { status: 'listening' } },
    ]);
    expect(metrics.counted('protocol.status_listener')).toEqual([
      { outcome: 'error', reason: 'Error' },
      { outcome: 'error', reason: 'Error' },
    ]);
  });

  it('As a dotli integrator, I unsubscribe a listener from another listener and it hears nothing after that', async () => {
    // Given
    void host.client.ensureProtocolFrame();
    await frameSays('listening', 'ready');
    const heard: ProtocolStatus[] = [];
    let unsubscribe: (() => void) | null = null;
    host.client.subscribeProtocolStatus(next => {
      if (next === 'failed') {
        host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });
        unsubscribe?.();
      }
    });
    unsubscribe = host.client.subscribeProtocolStatus(next => heard.push(next));

    // When
    host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(heard).toEqual(['failed']);
  });
});
