// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One protocol frame or client per test, on its own message target and mount, so one left behind by an earlier test
// hears nothing and builds nothing a later test sees. The iframe is a fake with only what the frame touches, so the
// frame's lifecycle runs under Node. A mounted fake fires `load` as a page that loads would, or `error` when the test
// asks.

import { createProtocolClient, type ProtocolClient } from '../client.js';
import type { MessageTarget, ProtocolFrameConfig, ProtocolFrameDeps, ProtocolFrameTimeouts } from '../frame.js';
import type { ProtocolEnvelope } from '../messages.js';

export const FRAME_ORIGIN = 'https://host.dot.li';

export const FRAME_CONFIG: ProtocolFrameConfig = {
  backend: 'smoldot-direct',
  network: 'paseo-next-v2',
  skipWorkerCache: false,
};

/** The frame's window as the host sees it: something to post to, which keeps what it was sent. */
export interface FakeFrameWindow {
  postMessage: (message: unknown, targetOrigin: string) => void;
  /** Every message posted, in order. */
  readonly posted: unknown[];
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
  #onRemove: (() => void) | null = null;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /** Called by the mount it is appended to. */
  mount(onRemove: () => void, fires: 'load' | 'error' = 'load'): void {
    this.isConnected = true;
    const posted: unknown[] = [];
    this.contentWindow = {
      posted,
      postMessage: message => {
        posted.push(message);
      },
    };
    this.#onRemove = onRemove;
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

function createMount(fires: 'load' | 'error'): FakeMount {
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

export interface FrameDom {
  /** What a frame or client is built on. */
  deps: ProtocolFrameDeps;
  /** The mounted iframe, or throws when there is none. */
  iframe(): FakeIframe;
  /** How many iframes are mounted now. */
  frames(): number;
  /** An iframe mounted elsewhere on the page, which is not the protocol frame. */
  stranger(): FakeIframe;
  /** A message sent by `iframe` (the current one by default), from the frame's origin unless told otherwise. */
  deliver(envelope: ProtocolEnvelope, iframe?: FakeIframe, origin?: string): void;
}

/** `options.mount` `'error'` makes each protocol iframe fail as it mounts. */
export function createFrameDom(
  timeouts?: Partial<ProtocolFrameTimeouts>,
  options: { mount?: 'load' | 'error' } = {},
): FrameDom {
  const listeners = new Set<(event: MessageEvent) => void>();
  const messages: MessageTarget = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const mount = createMount(options.mount ?? 'load');
  const elsewhere = createMount('load');
  const iframe = (): FakeIframe => {
    const [found] = mount.iframes;
    if (found === undefined) {
      throw new Error('missing protocol iframe');
    }
    return found;
  };
  return {
    deps: {
      origin: FRAME_ORIGIN,
      document: {
        createElement: () => new FakeIframe() as unknown as HTMLIFrameElement,
        body: mount as unknown as HTMLElement,
      },
      window: messages,
      timeouts,
    },
    iframe,
    frames: () => mount.iframes.size,
    stranger: () => elsewhere.appendChild(new FakeIframe()),
    deliver(envelope, from = iframe(), origin = FRAME_ORIGIN) {
      // The frame reads only these, and Node's MessageEvent refuses a source that is not a port.
      const event = { data: envelope, origin, source: from.contentWindow } as unknown as MessageEvent;
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

export interface FrameHost extends FrameDom {
  client: ProtocolClient;
}

/** `config` null leaves the client unconfigured, as before the host's boot says how to build the frame. */
export function createFrameHost(
  timeouts?: Partial<ProtocolFrameTimeouts>,
  config: ProtocolFrameConfig | null = FRAME_CONFIG,
): FrameHost {
  const dom = createFrameDom(timeouts);
  const client = createProtocolClient(dom.deps);
  if (config !== null) {
    client.configureProtocolFrame(config);
  }
  return { ...dom, client };
}
