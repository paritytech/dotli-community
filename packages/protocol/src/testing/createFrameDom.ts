// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One protocol frame or client per test, on its own message target and mount, so one left behind by an earlier test
// hears nothing and builds nothing a later test sees. The iframe is a fake with only what the frame touches, so the
// frame's lifecycle runs under Node, and a test answers the host through a real transport on its window.

import type { ManualTimers } from '@dotli/shared/testing';
import { _void } from 'scale-ts';
import {
  createTransport,
  createWindowProvider,
  defineSchema,
  type MessageTarget,
  type WindowMessage,
} from '@dotli/transport';
import { recordMessage } from '@dotli/transport/testing';
import { createFrameStatus, type FrameStatus } from '../createFrameStatus.js';
import type { ProtocolFrameParams, ProtocolFrameTimeouts } from '../frameTypes.js';
import { protocolSchema, type ProtocolTransport } from '../schema.js';
import { FRAME_ORIGIN, HOST_ORIGIN } from './constants.js';
import { createMount } from './createMount.js';
import { FakeIframe } from './fakeIframe.js';
import type { Listener, MountEvent } from './types.js';

export type FrameDom = ReturnType<typeof createFrameDom>;

type Params = {
  /** Overrides of the frame's lifecycle timeouts. */
  timeouts?: Partial<ProtocolFrameTimeouts> | undefined;
  /** `'error'` makes each protocol iframe fail as it mounts, and null leaves its `load` to the test. */
  mount?: MountEvent;
  /** What the frame waits on. */
  timers: ManualTimers;
};

type DeliverRawParams = {
  /** The iframe whose window sends it. The current one by default. */
  from?: FakeIframe;
  /** The origin it comes from. The frame's by default. */
  origin?: string;
};

type ServedFrame = { serving: ProtocolTransport; status: FrameStatus | null };

// The host posts its handshake again this often until it is answered.
const HANDSHAKE_RETRY_MS = 50;

/** A frame of a later release, whose wire the host cannot speak. */
const newerSchema = defineSchema({ version: 255, hello: _void, sections: {} });

/** A frame's document and window on a fake mount, with what a spec answers the host through. */
export function createFrameDom({ timeouts, mount: fires = 'load', timers }: Params) {
  const listeners = new Set<Listener>();
  const messages: MessageTarget = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const mount = createMount({ fires });
  const elsewhere = createMount({ fires: 'load' });
  const served = new Map<FakeIframe, ServedFrame>();

  function deliverToHost(event: WindowMessage): void {
    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  function getIframe(): FakeIframe {
    const [found] = mount.iframes;
    if (found === undefined) {
      throw new Error('missing protocol iframe');
    }
    return found;
  }

  function openProvider(target: FakeIframe) {
    const window = target.window;
    return createWindowProvider({ listen: window, peer: () => window.parent, origin: HOST_ORIGIN });
  }

  function getServed(target: FakeIframe): ServedFrame {
    const known = served.get(target);
    if (known !== undefined) {
      return known;
    }
    const serving = createTransport({
      schema: protocolSchema,
      provider: openProvider(target),
      handshake: 'respond',
      hello: { resolutionId: null },
    });
    // A frame app always serves the client's feeds, and these frames have nothing to report on them.
    serving.handleSubscription(protocolSchema.sections.frame.telemetry, () => () => undefined);
    serving.handleSubscription(protocolSchema.sections.storage.authChanges, () => () => undefined);
    const entry: ServedFrame = { serving, status: null };
    served.set(target, entry);
    return entry;
  }

  function getFrameStatus(target: FakeIframe = getIframe()): FrameStatus {
    const entry = getServed(target);
    entry.status ??= serveFrameStatus(entry.serving);
    return entry.status;
  }

  function retryHandshake(): Promise<void> {
    return timers.advance(HANDSHAKE_RETRY_MS);
  }

  const params: ProtocolFrameParams<FakeIframe> = {
    origin: FRAME_ORIGIN,
    document: {
      createElement: () => new FakeIframe(deliverToHost),
      body: mount,
    },
    window: messages,
    timeouts,
    timers,
  };

  return {
    /** What a frame or client is built on. */
    params,
    /** The mounted iframe. Throws when there is none. */
    getIframe,
    /** How many iframes are mounted now. */
    countFrames: () => mount.iframes.size,
    /** Mounts an iframe elsewhere on the page, which is not the protocol frame, and returns it. */
    mountStranger: () => elsewhere.appendChild(new FakeIframe(deliverToHost)),
    /**
     * A transport on `target`'s window (the current iframe's by default), which accepts the host's handshake, so a
     * spec answers the host as the frame app would. The same iframe gives the same transport.
     */
    serve: (target: FakeIframe = getIframe()) => getServed(target).serving,
    /** Answers the host's handshake on `target` (the current iframe by default) as a frame of a later release. */
    serveNewer(target: FakeIframe = getIframe()): void {
      createTransport({ schema: newerSchema, provider: openProvider(target), handshake: 'respond', hello: undefined });
    },
    /** The frame status `target` (the current iframe by default) serves on its serving transport. */
    getFrameStatus,
    /** Moves the timers on to the host's next handshake retry, so a frame that now answers is heard. */
    retryHandshake,
    /** Answers the current iframe as the frame app would, so it listens once its handshake is answered. */
    async listen(): Promise<FrameStatus> {
      const frameStatus = getFrameStatus();
      await retryHandshake();
      return frameStatus;
    },
    /** Answers the current iframe and reports its light client ready. */
    async bringUp(): Promise<FrameStatus> {
      const frameStatus = getFrameStatus();
      await retryHandshake();
      frameStatus.markReady();
      await timers.advance(0);
      return frameStatus;
    },
    /** The calls' messages the host sent `target` (the current iframe by default), its handshakes left out. */
    readSent: (target: FakeIframe = getIframe()) =>
      target.window.posted.flatMap(data => {
        const message = data instanceof ArrayBuffer ? recordMessage(protocolSchema, data) : null;
        return message === null ? [] : [message];
      }),
    /** Delivers `data` to the host as it is, as the current iframe's window sent it, unless `options` say otherwise. */
    deliverRaw(data: unknown, { from = getIframe(), origin = FRAME_ORIGIN }: DeliverRawParams = {}): void {
      deliverToHost({ data, origin, source: from.window });
    },
  };
}

/** Serves the frame's status on `serving` as a frame app does. */
function serveFrameStatus(serving: ProtocolTransport): FrameStatus {
  const status = createFrameStatus();
  serving.handleSubscription(protocolSchema.sections.frame.status, status.handler);
  return status;
}
