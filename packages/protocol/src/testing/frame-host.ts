// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One protocol frame or client per test, on its own message target and mount, so one left behind by an earlier test
// hears nothing and builds nothing a later test sees. The iframe is a fake with only what the frame touches, so the
// frame's lifecycle runs under Node. A mounted fake fires `load` as a page that loads would, or `error` when the test
// asks. Its window delivers on a microtask and moves each transferred buffer, as a browser does, and a test answers
// the host through a real transport on it.

import type { ManualTimers } from '@dotli/shared/testing';
import { _void } from 'scale-ts';
import {
  createTransport,
  createWindowProvider,
  defineSchema,
  type MessageTarget,
  type WindowLike,
  type WindowMessage,
} from '@dotli/transport';
import { recordMessage, type RecordedWireMessage } from '@dotli/transport/testing';
import { createProtocolClient, type ProtocolClient } from '../client.js';
import { createFrameStatus, type FrameStatus } from '../frame-status.js';
import type { ProtocolFrameConfig, ProtocolFrameDeps, ProtocolFrameTimeouts } from '../frame.js';
import { protocolSchema, type ProtocolTransport } from '../schema.js';

export const FRAME_ORIGIN = 'https://host.dot.li';

/** The host page's origin, as the frame's window knows it. */
const HOST_ORIGIN = 'https://dot.li';

// The host posts its handshake again this often until it is answered.
const HANDSHAKE_RETRY_MS = 50;

export const FRAME_CONFIG: ProtocolFrameConfig = {
  backend: 'smoldot-direct',
  network: 'paseo-next-v2',
  skipWorkerCache: false,
};

type Listener = (event: WindowMessage) => void;

/** What a mounted iframe fires on its own. */
type MountEvent = 'load' | 'error' | null;

function messageEvent(data: unknown, origin: string, source: unknown): WindowMessage {
  return { data, origin, source };
}

/** What a transfer leaves the receiver. The sender's buffer is detached, so posting it again fails as in a browser. */
function moved(data: unknown, transfer: Transferable[] | undefined): unknown {
  return transfer === undefined || transfer.length === 0 ? data : structuredClone(data, { transfer });
}

/** The frame's window: the host posts to it, and the frame listens on it and posts to its parent. */
export class FakeFrameWindow implements MessageTarget {
  /** Everything the host posted, in order, as the frame received it. */
  readonly posted: unknown[] = [];
  /** Everything the frame posted to the host, in order, as the host received it. */
  readonly sent: unknown[] = [];
  /** The host page as the frame sees it. A post reaches the host's listeners with this window as the source. */
  readonly parent: WindowLike;
  readonly #listeners = new Set<Listener>();

  constructor(toHost: Listener) {
    this.parent = {
      postMessage: (message, targetOrigin, transfer) => {
        if (targetOrigin !== HOST_ORIGIN) {
          return;
        }
        const data = moved(message, transfer);
        this.sent.push(data);
        queueMicrotask(() => {
          toHost(messageEvent(data, FRAME_ORIGIN, this));
        });
      },
    };
  }

  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void {
    const data = moved(message, transfer);
    this.posted.push(data);
    // A browser drops a message whose target origin is not the window's.
    if (targetOrigin !== FRAME_ORIGIN) {
      return;
    }
    queueMicrotask(() => {
      for (const listener of [...this.#listeners]) {
        listener(messageEvent(data, HOST_ORIGIN, this.parent));
      }
    });
  }

  addEventListener(_type: 'message', listener: Listener): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: Listener): void {
    this.#listeners.delete(listener);
  }
}

/** What the protocol frame reads and calls on its iframe. */
export class FakeIframe extends EventTarget {
  src = '';
  tabIndex = 0;
  readonly style = { cssText: '' };
  readonly attributes = new Map<string, string>();
  /** Null until mounted and again once removed, as in a browser. */
  contentWindow: FakeFrameWindow | null = null;
  isConnected = false;
  readonly #toHost: Listener;
  #window: FakeFrameWindow | null = null;
  #onRemove: (() => void) | null = null;

  constructor(toHost: Listener) {
    super();
    this.#toHost = toHost;
  }

  /** The window it was mounted with, kept after removal, since a message it sent before still names it as source. */
  get window(): FakeFrameWindow {
    if (this.#window === null) {
      throw new Error('the iframe was never mounted');
    }
    return this.#window;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /** Called by the mount it is appended to. `fires` null leaves `load` to the test. */
  mount(onRemove: () => void, fires: MountEvent): void {
    this.isConnected = true;
    this.#window ??= new FakeFrameWindow(this.#toHost);
    this.contentWindow = this.#window;
    this.#onRemove = onRemove;
    if (fires === null) {
      return;
    }
    queueMicrotask(() => {
      if (this.isConnected) {
        this.dispatchEvent(new Event(fires));
      }
    });
  }

  remove(): void {
    this.isConnected = false;
    this.contentWindow = null;
    this.#onRemove?.();
    this.#onRemove = null;
  }
}

/** Where the frame mounts its iframe. Holds only fake iframes. */
interface FakeMount {
  appendChild: <T>(node: T) => T;
  readonly iframes: ReadonlySet<FakeIframe>;
}

function createMount(fires: MountEvent): FakeMount {
  const iframes = new Set<FakeIframe>();
  return {
    iframes,
    appendChild: node => {
      if (!(node instanceof FakeIframe)) {
        throw new Error('the fake mount holds only fake iframes');
      }
      iframes.add(node);
      node.mount(() => iframes.delete(node), fires);
      return node;
    },
  };
}

/** Serves the frame's status on `serving` as a frame app does. */
function serveFrameStatus(serving: ProtocolTransport): FrameStatus {
  const status = createFrameStatus();
  serving.handleSubscription(protocolSchema.sections.frame.status, status.handler);
  return status;
}

/** A frame of a later release, whose wire the host cannot speak. */
const newerSchema = defineSchema({ version: 255, hello: _void, sections: {} });

export interface FrameDom {
  /** What a frame or client is built on. */
  deps: ProtocolFrameDeps<FakeIframe>;
  /** The mounted iframe, or throws when there is none. */
  iframe(): FakeIframe;
  /** How many iframes are mounted now. */
  frames(): number;
  /** An iframe mounted elsewhere on the page, which is not the protocol frame. */
  stranger(): FakeIframe;
  /**
   * A transport on `iframe`'s window (the current one by default), which accepts the host's handshake, so a spec
   * answers the host as the frame app would. The same iframe gives the same transport.
   */
  serve(iframe?: FakeIframe): ProtocolTransport;
  /** Answers the host's handshake on `iframe` (the current one by default) as a frame of a later release. */
  serveNewer(iframe?: FakeIframe): void;
  /** The frame status `iframe` (the current one by default) serves, on its serving transport. */
  status(iframe?: FakeIframe): FrameStatus;
  /** Moves the timers on to the host's next handshake retry, so a frame that now answers is heard. */
  retryHandshake(): Promise<void>;
  /** Answers the current iframe as the frame app would, so it listens once its handshake is answered. */
  listen(): Promise<FrameStatus>;
  /** Answers the current iframe and reports its light client ready. */
  bringUp(): Promise<FrameStatus>;
  /** The calls' messages the host sent `iframe` (the current one by default), its handshakes left out. */
  sent(iframe?: FakeIframe): RecordedWireMessage[];
  /** Data sent by `iframe` (the current one by default) as it is, from the frame's origin unless told otherwise. */
  deliverRaw(data: unknown, iframe?: FakeIframe, origin?: string): void;
}

/**
 * `options.mount` `'error'` makes each protocol iframe fail as it mounts, and null leaves its `load` to the test. The
 * frame waits on `options.timers`.
 */
export function createFrameDom(
  timeouts: Partial<ProtocolFrameTimeouts> | undefined,
  options: { mount?: MountEvent; timers: ManualTimers },
): FrameDom {
  const { timers } = options;
  const listeners = new Set<Listener>();
  const messages: MessageTarget = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const toHost: Listener = event => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };
  const mount = createMount(options.mount === undefined ? 'load' : options.mount);
  const elsewhere = createMount('load');
  const served = new Map<FakeIframe, { serving: ProtocolTransport; status: FrameStatus | null }>();
  const iframe = (): FakeIframe => {
    const [found] = mount.iframes;
    if (found === undefined) {
      throw new Error('missing protocol iframe');
    }
    return found;
  };
  const providerOn = (target: FakeIframe) => {
    const window = target.window;
    return createWindowProvider({ listen: window, peer: () => window.parent, origin: HOST_ORIGIN });
  };
  const servedOn = (target: FakeIframe): { serving: ProtocolTransport; status: FrameStatus | null } => {
    let entry = served.get(target);
    if (entry === undefined) {
      const serving = createTransport(protocolSchema, providerOn(target), {
        handshake: 'accept',
        hello: { resolutionId: null },
      });
      // A frame app always serves the client's feeds, and these frames have nothing to report on them.
      serving.handleSubscription(protocolSchema.sections.frame.telemetry, () => () => undefined);
      serving.handleSubscription(protocolSchema.sections.storage.authChanges, () => () => undefined);
      entry = { serving, status: null };
      served.set(target, entry);
    }
    return entry;
  };
  const status = (target = iframe()): FrameStatus => {
    const entry = servedOn(target);
    entry.status ??= serveFrameStatus(entry.serving);
    return entry.status;
  };
  const retryHandshake = (): Promise<void> => timers.advance(HANDSHAKE_RETRY_MS);
  return {
    deps: {
      origin: FRAME_ORIGIN,
      document: {
        createElement: () => new FakeIframe(toHost),
        body: mount,
      },
      window: messages,
      timeouts,
      timers,
    },
    iframe,
    frames: () => mount.iframes.size,
    stranger: () => elsewhere.appendChild(new FakeIframe(toHost)),
    serve: (target = iframe()) => servedOn(target).serving,
    serveNewer(target = iframe()) {
      createTransport(newerSchema, providerOn(target), { handshake: 'accept', hello: undefined });
    },
    status,
    retryHandshake,
    async listen() {
      const frameStatus = status();
      await retryHandshake();
      return frameStatus;
    },
    async bringUp() {
      const frameStatus = status();
      await retryHandshake();
      frameStatus.ready();
      await timers.advance(0);
      return frameStatus;
    },
    sent: (target = iframe()) =>
      target.window.posted.flatMap(data => {
        const message = data instanceof ArrayBuffer ? recordMessage(protocolSchema, data) : null;
        return message === null ? [] : [message];
      }),
    deliverRaw(data, from = iframe(), origin = FRAME_ORIGIN) {
      toHost(messageEvent(data, origin, from.window));
    },
  };
}

export interface FrameHost extends FrameDom {
  client: ProtocolClient;
}

/**
 * `config` null leaves the client unconfigured, as before the host's boot says how to build the frame. The client waits
 * on `timers`.
 */
export function createFrameHost(
  timeouts: Partial<ProtocolFrameTimeouts> | undefined,
  config: ProtocolFrameConfig | null,
  timers: ManualTimers,
): FrameHost {
  const dom = createFrameDom(timeouts, { timers });
  const client = createProtocolClient(dom.deps);
  if (config !== null) {
    client.configureProtocolFrame(config);
  }
  return { ...dom, client };
}
