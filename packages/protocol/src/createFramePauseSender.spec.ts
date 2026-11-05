// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { recordCaptures } from '@dotli/metrics/testing';
import { createManualTimers, type ManualTimers } from '@dotli/shared/testing';
import { denied, err, ok } from '@dotli/transport';
import { createFramePauseSender } from './createFramePauseSender.js';
import { createFrameRpc } from './createFrameRpc.js';
import { createFakeFrame } from './createProtocolFrame.fake.js';
import type { ProtocolStatus } from './frameTypes.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';

const { frame } = protocolSchema.sections;

type PauseServer = {
  /** Sets up each frame as it is built. */
  serve: (serving: ProtocolTransport) => void;
  /** What each built frame was told, in build order. */
  frames: boolean[][];
};

/** A frame app that records each pause it is told, per frame, and answers it, or refuses it when `refuse` is set. */
function createPauseServer({ refuse = false }: { refuse?: boolean } = {}): PauseServer {
  const frames: boolean[][] = [];
  return {
    frames,
    serve: serving => {
      const told: boolean[] = [];
      frames.push(told);
      serving.handleRequest(frame.pause, ({ paused }) => {
        told.push(paused);
        return refuse ? err(denied()) : ok();
      });
    },
  };
}

describe('createFramePauseSender', () => {
  let timers: ManualTimers;

  function settle(): Promise<void> {
    return timers.advance(0);
  }

  function createSender(server: PauseServer, status: ProtocolStatus = 'ready') {
    const fake = createFakeFrame({ serve: server.serve, status, timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    return { fake, sender: createFramePauseSender({ frame: fake.frame, rpc }) };
  }

  beforeEach(() => {
    timers = createManualTimers();
  });

  it('As a hidden host page, I tell my ready frame to pause and to resume', async () => {
    // Given
    const server = createPauseServer();
    const { sender } = createSender(server);

    // When
    sender.setPaused(true);
    await settle();
    sender.setPaused(false);
    await settle();

    // Then
    expect(server.frames).toEqual([[true, false]]);
  });

  it('As a host page whose frame is rebuilt while paused, I tell the new frame to pause once it is ready', async () => {
    // Given a paused host whose first frame heard it
    const server = createPauseServer();
    const { fake, sender } = createSender(server);
    sender.setPaused(true);
    await settle();

    // When
    fake.lose(new Error('gone'));
    fake.setStatus('booting');
    fake.setStatus('ready');
    await settle();

    // Then
    expect(server.frames).toEqual([[true], [true]]);
  });

  it('As a host page, I never boot a frame to say I pause', async () => {
    // Given
    const server = createPauseServer();
    const { fake, sender } = createSender(server, 'idle');

    // When
    sender.setPaused(true);
    await settle();

    // Then
    expect(server.frames).toEqual([]);
    expect(fake.countBuilds()).toBe(0);
  });

  it('As a dotli maintainer, I see a pause the ready frame refused captured', async () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const server = createPauseServer({ refuse: true });
    const { sender } = createSender(server);

    // When
    sender.setPaused(true);
    await settle();

    // Then
    expect(server.frames).toEqual([[true]]);
    expect(captured).toEqual([{ flow: 'protocol', step: 'frame_pause', tags: undefined }]);
  });

  it('As a dotli maintainer, I see a pause that failed on a frame no longer ready go uncaptured', async () => {
    // Given a ready frame that refuses the pause
    const captured = recordCaptures({ onFinished: onTestFinished });
    const server = createPauseServer({ refuse: true });
    const { fake, sender } = createSender(server);

    // When the pause is sent and the frame goes down before the refusal is heard
    sender.setPaused(true);
    fake.lose(new Error('gone'));
    await settle();

    // Then nothing was captured
    expect(captured).toEqual([]);
  });

  it('As a host page whose frame is down, I resume and the next ready frame is told nothing', async () => {
    // Given a paused host whose frame went down
    const server = createPauseServer();
    const { fake, sender } = createSender(server);
    sender.setPaused(true);
    await settle();
    fake.lose(new Error('gone'));
    fake.setStatus('booting');

    // When the host resumes while the frame is down, and the next frame is ready
    sender.setPaused(false);
    fake.setStatus('ready');
    await settle();

    // Then the new frame was never told to pause
    expect(server.frames).toEqual([[true], []]);
  });

  it('As a hidden host page, I pause and resume with no settle between and my ready frame hears both in order', async () => {
    // Given
    const server = createPauseServer();
    const { sender } = createSender(server);

    // When
    sender.setPaused(true);
    sender.setPaused(false);
    await settle();

    // Then
    expect(server.frames).toEqual([[true, false]]);
  });
});
