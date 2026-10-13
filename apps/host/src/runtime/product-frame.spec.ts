// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { encodeWireMessage, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';
import type { IframeHostOptions } from '@parity/truapi-host/web';
import { PERMISSIONS_REQUEST_DEVICE_PERMISSION } from '@parity/truapi/wire-table';
import { isSandboxOrigin } from '@dotli/config';
import { startSandboxChannel, type StartedSandboxChannel } from '@dotli/sandbox-wire';
import { bindCaptureSink } from '@dotli/metrics';
import { createSyncStore } from '@dotli/shared';
import { createCoreAuthCommands } from './core-login.js';
import type { DotliAuthState } from './host-callbacks/AuthState.js';
import { schedulePendingReset } from './pending-reset.js';
import {
  createProductFrame,
  type FrameProduct,
  type ProductFrame,
  type ProductFrameDeps,
  type ProductFramePage,
  type ProductFrameStatus,
} from './product-frame.js';
import { StubElement } from '../testing/stub-element.js';
import { getProductState } from './state/product.js';
import type { ManifestFacts } from './manifest-facts.js';
import type { PermissionsChange } from './state/product-permissions.js';
import {
  answerConnection,
  createFakePageCore,
  loginResponseFrame,
  makeProvider,
  requestIdFromFrame,
  type FakeCoreProvider,
  type FakePageCore,
} from './page-core.fake.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { nth } from '@dotli/shared/testing';
import { fakeProductFrameView, type FakeProductFrameView } from './product-frame.fake.js';

/** A handler that throws fails the test. */
const rethrow = (error: unknown): never => {
  throw error;
};

interface FakeIframeHost {
  options: IframeHostOptions;
  iframe: HTMLIFrameElement;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

interface Harness extends FakePageCore {
  frame: ProductFrame;
  container: HTMLElement;
  /** Every frame the product frame created, in order. */
  hosts: FakeIframeHost[];
  statuses: ProductFrameStatus[];
  /** Holds the next frame until the returned release, after its render read the permission policy. */
  holdNextFrame(): () => void;
  /** How many frames were asked for, held or not. */
  framesAsked(): number;
  /** Fails every frame asked for from now on, as a frame chunk that cannot load. */
  failFrames(failure: Error): void;
  /** The permission store announcing a change. */
  announce(change: Partial<PermissionsChange> & { label: string }): void;
}

let channel: StartedSandboxChannel | null = null;

afterEach(() => {
  channel?.stop();
  channel = null;
});

/** The host page, at the root of a dev host. */
let location: ReturnType<ProductFramePage['location']>;
/** The page around the frame. */
let frameView: FakeProductFrameView;

beforeEach(() => {
  location = {
    href: 'http://localhost:3000/',
    hostname: 'localhost',
    port: '3000',
    pathname: '/',
    search: '',
    hash: '',
  };
  frameView = fakeProductFrameView();
});

/** The window the sandbox posts to. */
let window: EventTarget;

/** A sandbox message, as the browser delivers it from the window `source` of `origin`. */
function sandboxMessage(data: unknown, origin: string, source: unknown = null): Event {
  return Object.assign(new Event('message'), { data, origin, source });
}

/** As the bridge wires it, over the real page core with fake runtimes and frames the test can see. */
function harness(
  fakes: FakePageCore = createFakePageCore(),
  overrides: Partial<Pick<ProductFrameDeps, 'createIframeHost'>> = {},
): Harness {
  const container = new StubElement('div', { root: true }).asHtml();
  const hosts: FakeIframeHost[] = [];
  let held: Promise<undefined> | null = null;
  let asked = 0;
  let failing: Error | null = null;
  const permissionListeners = new Set<(change: PermissionsChange) => void>();
  window = new EventTarget();
  channel = startSandboxChannel({ target: window, isTrustedOrigin: isSandboxOrigin, report: rethrow });
  const frame = createProductFrame({
    core: fakes.core,
    createIframeHost: async options => {
      asked += 1;
      fakes.changes.notify();
      if (failing !== null) {
        throw failing;
      }
      const gate = held;
      held = null;
      await gate;
      const iframe = new StubElement('iframe').asIframe();
      iframe.dataset['src'] = options.iframeUrl;
      options.container.appendChild(iframe);
      const dispose = vi.fn(() => {
        iframe.remove();
        fakes.changes.notify();
      });
      hosts.push({ options, iframe, dispose });
      fakes.changes.notify();
      return { iframe, dispose };
    },
    container,
    channel,
    onPermissionsChanged: listener => {
      permissionListeners.add(listener);
      return () => {
        permissionListeners.delete(listener);
      };
    },
    view: frameView.view,
    notify: () => undefined,
    page: {
      location: () => location,
      reload: vi.fn(),
    },
    ...overrides,
  });
  const statuses: ProductFrameStatus[] = [];
  frame.subscribeStatus(status => {
    statuses.push(status);
    fakes.changes.notify();
  });
  return {
    ...fakes,
    frame,
    container,
    hosts,
    statuses,
    holdNextFrame() {
      const gate = Promise.withResolvers<undefined>();
      held = gate.promise;
      return () => {
        gate.resolve(undefined);
      };
    },
    framesAsked: () => asked,
    failFrames(failure) {
      failing = failure;
    },
    announce(change) {
      for (const listener of [...permissionListeners]) {
        listener({ permissions: [], device: true, fromPrompt: false, ...change });
      }
    },
  };
}

/** Renders `product` and answers the core connection it asks for. */
async function settle(fakes: Harness, product: FrameProduct, connection: number): Promise<void> {
  const rendered = fakes.frame.render(product);
  await answerConnection(fakes, connection);
  await rendered;
}

/** The sandbox in frame `host` asking to be rebuilt, as it does after a reload, or `from` another window of its origin. */
function askToRecover(fakes: Harness, host = 0, from?: unknown): void {
  const asking = nth(fakes.hosts, host);
  window.dispatchEvent(
    sandboxMessage(
      { type: 'dotli:sandbox-recover' },
      asking.options.allowedOrigin ?? '',
      from === undefined ? asking.iframe.contentWindow : from,
    ),
  );
}

/** The core under `connection` going down, as a crashed worker closes every connection it serves. */
function crash(connection: FakeCoreProvider): void {
  connection.closeListener?.(new Error('worker fatal error: boom'));
}

/** Answers the connection the render on a replacement core asks for, and waits until the product is back on screen. */
async function reconnect(fakes: Harness, connection: number): Promise<FakeCoreProvider> {
  const provider = await answerConnection(fakes, connection);
  await fakes.changes.until(() => fakes.frame.getStatus() === 'connected');
  return provider;
}

/** Register both roots the way the shell does: disposing removes the node. */
function registerRoots(container: HTMLElement): {
  loading: HTMLElement;
  page: HTMLElement;
  disposeLoading: ReturnType<typeof vi.fn>;
  disposePage: ReturnType<typeof vi.fn>;
} {
  const loading = new StubElement('div').asHtml();
  container.appendChild(loading);
  const page = new StubElement('div').asHtml();
  container.appendChild(page);
  const disposeLoading = vi.fn(() => {
    loading.remove();
  });
  const disposePage = vi.fn(() => {
    page.remove();
  });
  frameView.showScreen('loading', disposeLoading);
  frameView.showScreen('page', disposePage);
  return { loading, page, disposeLoading, disposePage };
}

const iframeProduct = (label: string, url = `https://${label}.example/app`): FrameProduct => ({
  mode: 'iframe',
  label,
  url,
  chat: Promise.resolve(false),
});
const subdomainProduct = (label: string, cid = 'cid', chat = false): FrameProduct => ({
  mode: 'subdomain',
  label,
  cid,
  chat: Promise.resolve(chat),
});

describe('product frame renders', () => {
  it('As a dotli integrator, the frame disposes a host that connects after a newer render has started', async () => {
    // Given
    const fakes = harness();

    // When
    const first = fakes.frame.render(iframeProduct('first'));
    await fakes.changes.until(() => fakes.connections.length === 1);
    const second = fakes.frame.render(iframeProduct('second'));
    const secondProvider = await answerConnection(fakes, 1);
    await second;

    // Then
    expect(fakes.container.querySelector('iframe')?.dataset['src']).toBe('https://second.example/app');

    // When
    const firstProvider = await answerConnection(fakes, 0);
    await first;

    // Then
    await fakes.changes.until(() => fakes.hosts.length === 2);
    const firstHost = fakes.hosts.find(host => host.options.iframeUrl === 'https://first.example/app');
    await fakes.changes.until(() => (firstHost?.dispose.mock.calls.length ?? 0) === 1);
    expect(firstProvider.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(secondProvider.dispose).not.toHaveBeenCalled();
    expect(fakes.container.querySelector('iframe')?.dataset['src']).toBe('https://second.example/app');
  });

  it('As a dotli integrator, the frame takes down a frame still being built when a newer render supersedes it', async () => {
    // Given a render whose frame is still being built
    const fakes = harness();
    const release = fakes.holdNextFrame();
    const first = fakes.frame.render(iframeProduct('first'));
    const firstProvider = await answerConnection(fakes, 0);
    await fakes.changes.until(() => fakes.framesAsked() === 1);

    // When a newer render connects, then the first frame comes up
    const second = fakes.frame.render(iframeProduct('second'));
    await answerConnection(fakes, 1);
    await second;
    release();
    await first;

    // Then the first frame goes, and with it its connection and its core
    await fakes.changes.until(() => fakes.hosts.length === 2);
    const firstHost = fakes.hosts.find(host => host.options.iframeUrl === 'https://first.example/app');
    await fakes.changes.until(() => (firstHost?.dispose.mock.calls.length ?? 0) === 1);
    expect(firstProvider.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.frame.getStatus()).toBe('connected');
    expect(fakes.container.querySelectorAll('iframe')).toHaveLength(1);
    expect(fakes.container.querySelector('iframe')?.dataset['src']).toBe('https://second.example/app');
  });

  it('As a dotli integrator, the frame keeps the previous iframe visible while its replacement connects', async () => {
    // Given
    const fakes = harness();
    await settle(fakes, iframeProduct('first'), 0);
    const firstHost = nth(fakes.hosts, 0);

    // When
    const second = fakes.frame.render(iframeProduct('second'));
    await fakes.changes.until(() => fakes.connections.length === 2);

    // Then
    expect(firstHost.iframe.isConnected).toBe(true);
    expect(firstHost.dispose).not.toHaveBeenCalled();

    // When
    await answerConnection(fakes, 1);
    await second;

    // Then
    expect(firstHost.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.container.querySelectorAll('iframe')).toHaveLength(1);
    expect(fakes.container.querySelector('iframe')?.dataset['src']).toBe('https://second.example/app');
  });

  it('As a dotli integrator, the frame keeps the previous app subdomain frame visible while its replacement connects', async () => {
    // Given
    const fakes = harness();
    await settle(fakes, subdomainProduct('first', 'first-cid'), 0);
    const firstHost = nth(fakes.hosts, 0);

    // When
    const second = fakes.frame.render(subdomainProduct('first', 'second-cid'));
    await fakes.changes.until(() => fakes.connections.length === 2);

    // Then
    expect(firstHost.iframe.isConnected).toBe(true);

    // When
    await answerConnection(fakes, 1);
    await second;

    // Then
    expect(firstHost.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.container.querySelectorAll('iframe')).toHaveLength(1);
    expect(fakes.container.querySelector('iframe')?.dataset['src']).toContain('cid=second-cid');
  });

  it('As a dApp user, both render paths hand the product frame to the frame layout', async () => {
    // Given
    const fakes = harness();
    const products = [iframeProduct('product'), subdomainProduct('product')];

    for (const [index, product] of products.entries()) {
      // When
      await settle(fakes, product, index);

      // Then
      expect(frameView.attached.at(-1)).toBe(nth(fakes.hosts, index).iframe);
    }
  });

  it.each(['/x.dot@evil.com/pay', '/foo.dotify/pay'])(
    'As a user, the frame keeps an adversarial deep path on the app sandbox origin: %s',
    async path => {
      // Given
      location = { ...location, href: `http://localhost:3000${path}`, pathname: path };
      const fakes = harness();

      // When
      await settle(fakes, subdomainProduct('first'), 0);

      // Then
      const created = nth(fakes.hosts, 0);
      const iframeUrl = new URL(created.options.iframeUrl);
      expect(iframeUrl.hostname).toBe('first.app.localhost');
      expect(iframeUrl.pathname).toBe(path);
      expect(created.options.allowedOrigin).toBe(iframeUrl.origin);
    },
  );

  it('As a user who reset everything, only the first product frame after the reload purges the sandbox origin', async () => {
    // Given
    const fakes = harness();
    schedulePendingReset(['protocol', 'sandbox']);

    // When
    await settle(fakes, subdomainProduct('reset'), 0);
    await settle(fakes, subdomainProduct('reset'), 1);

    // Then
    const [first, second] = fakes.hosts.map(host => new URL(host.options.iframeUrl).searchParams);
    expect(first?.get('fullReset')).toBe('1');
    expect(second?.has('fullReset')).toBe(false);
  });

  it('As a product that declares chat, I am connected as a Worker and recorded as chat-capable, and one that does not as an App', async () => {
    // Given
    const fakes = harness();

    // When
    await settle(fakes, subdomainProduct('chatty', 'cid', true), 0);

    // Then
    expect(nth(fakes.runtimes, 0).createProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionKind: 'Worker' }),
    );
    expect(getProductState()).toMatchObject({ status: 'loaded', label: 'chatty', chat: true });

    // When
    await settle(fakes, subdomainProduct('quiet'), 1);

    // Then
    expect(fakes.runtimes.at(-1)?.createProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionKind: 'App' }),
    );
    expect(getProductState()).toMatchObject({ status: 'loaded', label: 'quiet', chat: false });
  });

  it('As a dApp user, the tab names my product by its published name from the first render, and the page knows its versions', async () => {
    // Given
    const fakes = harness();
    const facts: ManifestFacts = { displayName: 'DOOM', manifestVersion: 1, appVersion: [1, 2, 3] };

    // When
    await settle(fakes, { mode: 'subdomain', label: 'doom', cid: 'cid', chat: Promise.resolve(false), ...facts }, 0);

    // Then
    expect(frameView.titles).toEqual([{ mode: 'subdomain', label: 'doom', displayName: 'DOOM' }]);
    expect(getProductState()).toMatchObject({ status: 'loaded', label: 'doom', ...facts });
  });
});

describe('product frame status', () => {
  it('As the shell, I see the frame connecting, then connected once the product is on screen', async () => {
    // Given
    const fakes = harness();

    // When
    const rendered = fakes.frame.render(iframeProduct('product'));

    // Then
    expect(fakes.frame.getStatus()).toBe('connecting');

    // When
    await answerConnection(fakes, 0);
    await rendered;

    // Then
    expect(fakes.statuses).toEqual(['connecting', 'connected']);
  });

  it('As a browser test, I read each status on the product container as the frame publishes it', async () => {
    // Given
    const fakes = harness();
    const seen = [fakes.container.dataset['productFrame']];
    fakes.frame.subscribeStatus(() => {
      seen.push(fakes.container.dataset['productFrame']);
    });
    const rendered = fakes.frame.render(subdomainProduct('product'));
    const dead = await answerConnection(fakes, 0);
    await rendered;

    // When
    crash(dead);
    await reconnect(fakes, 1);

    // Then
    expect(seen).toEqual(['idle', 'connecting', 'connected', 'lost', 'connecting', 'connected']);
  });

  it('As the shell, a render whose core never boots fails to me and the frame reports failed', async () => {
    // Given
    const fakes = harness();
    const failure = new Error('worker fatal error: boot');
    fakes.nextBoots.push(() => failure);

    // When
    const rendered = fakes.frame.render(subdomainProduct('product'));

    // Then
    await expect(rendered).rejects.toBe(failure);
    expect(fakes.statuses).toEqual(['connecting', 'failed']);
  });

  it('As a dApp user whose frame code fails to load, the render fails and lets go of its core', async () => {
    // Given
    const failure = new Error('Failed to fetch dynamically imported module');
    const fakes = harness(createFakePageCore(), { createIframeHost: () => Promise.reject(failure) });

    // When
    const rendered = fakes.frame.render(subdomainProduct('product'));
    const connection = await answerConnection(fakes, 0);

    // Then
    await expect(rendered).rejects.toBe(failure);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.frame.getStatus()).toBe('failed');
  });

  it('As the shell, a render that a newer one superseded settles without an error', async () => {
    // Given
    const fakes = harness();
    const first = fakes.frame.render(subdomainProduct('product', 'first-cid'));
    await fakes.changes.until(() => fakes.connections.length === 1);

    // When
    const second = fakes.frame.render(subdomainProduct('product', 'second-cid'));

    // Then
    await expect(first).resolves.toBeUndefined();
    await answerConnection(fakes, 1);
    await second;
    expect(fakes.frame.getStatus()).toBe('connected');
  });

  it('As the shell, a status listener that renders again hears every change in order', async () => {
    // Given: a listener that renders again once a render failed
    const fakes = harness();
    fakes.nextBoots.push(() => new Error('worker fatal error: boot'));
    const heard: ProductFrameStatus[] = [];
    const retries: Promise<void>[] = [];
    fakes.frame.subscribeStatus(status => {
      if (status === 'failed') {
        retries.push(fakes.frame.render(subdomainProduct('product')));
      }
    });
    fakes.frame.subscribeStatus(status => {
      heard.push(status);
    });

    // When
    await expect(fakes.frame.render(subdomainProduct('product'))).rejects.toThrow('boot');
    await answerConnection(fakes, 0);
    await Promise.all(retries);

    // Then
    expect(heard).toEqual(['connecting', 'failed', 'connecting', 'connected']);
  });

  it('As the shell, a listener subscribed during a status delivery hears only the changes after it', async () => {
    // Given: a listener that subscribes another and renders again once a render failed
    const fakes = harness();
    fakes.nextBoots.push(() => new Error('worker fatal error: boot'));
    const late: ProductFrameStatus[] = [];
    const retries: Promise<void>[] = [];
    fakes.frame.subscribeStatus(status => {
      if (status === 'failed') {
        fakes.frame.subscribeStatus(next => {
          late.push(next);
        });
        retries.push(fakes.frame.render(subdomainProduct('product')));
      }
    });

    // When
    await expect(fakes.frame.render(subdomainProduct('product'))).rejects.toThrow('boot');
    await answerConnection(fakes, 0);
    await Promise.all(retries);

    // Then
    expect(late).toEqual(['connecting', 'connected']);
  });
  it('As the shell, a status listener that throws is reported and counted, and the next listener still hears the change', async () => {
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
    const fakes = harness();
    fakes.frame.subscribeStatus(() => {
      throw new Error('listener broke');
    });
    const heard: ProductFrameStatus[] = [];
    fakes.frame.subscribeStatus(status => {
      heard.push(status);
    });

    // When
    const rendered = fakes.frame.render(iframeProduct('product'));
    await answerConnection(fakes, 0);
    await rendered;

    // Then the next listener heard each change, and each throw was captured once and counted once
    expect(heard).toEqual(['connecting', 'connected']);
    expect(captures).toEqual([
      { step: 'product_frame_status_listener', tags: { status: 'connecting' } },
      { step: 'product_frame_status_listener', tags: { status: 'connected' } },
    ]);
    expect(metrics.counted('product.status_listener')).toEqual([
      { outcome: 'error', reason: 'Error' },
      { outcome: 'error', reason: 'Error' },
    ]);
  });
});

describe('product frame app roots', () => {
  it('As the shell, an app subdomain render disposes the page root and keeps the loading overlay up', async () => {
    // Given
    const fakes = harness();
    const { loading, page, disposeLoading, disposePage } = registerRoots(fakes.container);

    // When
    await settle(fakes, subdomainProduct('first'), 0);

    // Then
    expect(disposePage).toHaveBeenCalledTimes(1);
    expect(page.isConnected).toBe(false);
    expect(disposeLoading).not.toHaveBeenCalled();
    expect(loading.parentElement).toBe(fakes.container);
    expect(fakes.container.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('As the shell, a later app subdomain render disposes a loading overlay the first one kept', async () => {
    // Given
    const fakes = harness();
    const { loading, disposeLoading } = registerRoots(fakes.container);
    await settle(fakes, subdomainProduct('first', 'first-cid'), 0);

    // When
    await settle(fakes, subdomainProduct('first', 'second-cid'), 1);

    // Then
    expect(disposeLoading).toHaveBeenCalledTimes(1);
    expect(loading.isConnected).toBe(false);
    expect(fakes.container.children).toHaveLength(1);
    expect(fakes.container.querySelector('iframe')?.dataset['src']).toContain('cid=second-cid');
  });

  it('As the shell, a direct iframe render disposes both the page and the loading roots', async () => {
    // Given
    const fakes = harness();
    const { disposeLoading, disposePage } = registerRoots(fakes.container);

    // When
    await settle(fakes, iframeProduct('product'), 0);

    // Then
    expect(disposePage).toHaveBeenCalledTimes(1);
    expect(disposeLoading).toHaveBeenCalledTimes(1);
    expect(disposePage.mock.invocationCallOrder[0]).toBeLessThan(nth(disposeLoading.mock.invocationCallOrder, 0));
    expect(fakes.container.children).toHaveLength(1);
    expect(fakes.container.firstElementChild?.tagName).toBe('IFRAME');
  });
});

describe('product frame rebuilds', () => {
  it('As a dApp user, I keep the product open while its sandbox is rebuilt and the tab title is shown again for it', async () => {
    // Given a product on screen
    const fakes = harness();
    await settle(fakes, subdomainProduct('titled'), 0);

    // When its sandbox asks to be rebuilt
    askToRecover(fakes);
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => (fakes.hosts[0]?.dispose.mock.calls.length ?? 0) > 0);

    // Then the page names the same product again, from whatever its root manifest has published by now
    expect(frameView.titles).toEqual([
      { mode: 'subdomain', label: 'titled' },
      { mode: 'subdomain', label: 'titled' },
    ]);
  });

  it('As a dApp user, a sandbox that asks to be rebuilt twice in a row is rebuilt once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      // Given
      const fakes = harness();
      await settle(fakes, subdomainProduct('twice'), 0);

      // When
      askToRecover(fakes);
      askToRecover(fakes);
      await answerConnection(fakes, 1);
      await fakes.changes.until(() => fakes.hosts.length === 2);
      await vi.advanceTimersByTimeAsync(5_000);

      // Then
      expect(fakes.frame.getStatus()).toBe('connected');
      expect(fakes.connections).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a dApp user whose rebuilt sandbox reloads while an older ask still waits, I see the newer ask rebuild it once the interval has passed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      // Given a rebuild at the sandbox's ask whose new frame is still being built
      const fakes = harness();
      await settle(fakes, subdomainProduct('asking'), 0);
      const release = fakes.holdNextFrame();
      askToRecover(fakes);
      await answerConnection(fakes, 1);
      await fakes.changes.until(() => fakes.framesAsked() === 2);

      // When the old frame asks again, then the new frame comes up and asks too
      askToRecover(fakes);
      release();
      await fakes.changes.until(() => fakes.frame.getStatus() === 'connected' && fakes.hosts.length === 2);
      askToRecover(fakes, 1);
      await vi.advanceTimersByTimeAsync(5_000);

      // Then the newer ask rebuilds the frame now on screen
      await answerConnection(fakes, 2);
      await fakes.changes.until(() => fakes.hosts.length === 3 && fakes.frame.getStatus() === 'connected');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fakes.connections).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a dApp user, a sandbox of another product cannot rebuild the one I'm on", async () => {
    // Given
    const fakes = harness();
    await settle(fakes, subdomainProduct('mine'), 0);
    const other = new URL(nth(fakes.hosts, 0).options.allowedOrigin ?? '');
    other.hostname = 'other.app.localhost';

    // When
    window.dispatchEvent(sandboxMessage({ type: 'dotli:sandbox-recover' }, other.origin));

    // Then
    expect(fakes.frame.getStatus()).toBe('connected');
    expect(fakes.connections).toHaveLength(1);
  });

  it("As a dApp user, a window of my own product's origin that is not the frame on screen cannot rebuild it", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      // Given: another window on the product's origin, such as a frame the product nested in itself
      const fakes = harness();
      await settle(fakes, subdomainProduct('nested'), 0);
      const nested = new StubElement('iframe');

      // When
      askToRecover(fakes, 0, nested.contentWindow);
      await vi.advanceTimersByTimeAsync(0);

      // Then
      expect(fakes.frame.getStatus()).toBe('connected');
      expect(fakes.framesAsked()).toBe(1);
      expect(fakes.connections).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a dApp user whose rebuilt sandbox reloads again at once, it is rebuilt once the interval has passed', async () => {
    // Given a product rebuilt once at its sandbox's ask
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const fakes = harness();
      await settle(fakes, subdomainProduct('looping'), 0);
      askToRecover(fakes);
      await answerConnection(fakes, 1);
      await fakes.changes.until(() => fakes.frame.getStatus() === 'connected' && fakes.hosts.length === 2);

      // When the rebuilt sandbox asks again within the interval
      askToRecover(fakes, 1);
      await Promise.resolve();

      // Then it waits
      expect(fakes.frame.getStatus()).toBe('connected');
      expect(fakes.connections).toHaveLength(2);

      // When the interval has passed
      await vi.advanceTimersByTimeAsync(5_000);

      // Then it is rebuilt
      await answerConnection(fakes, 2);
      await fakes.changes.until(() => fakes.hosts.length === 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a dApp user whose sandbox keeps asking to be rebuilt while each rebuild fails, one more rebuild waits and the rest are dropped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      // Given a product whose rebuilds fail
      const fakes = harness();
      await settle(fakes, subdomainProduct('failing'), 0);
      fakes.failFrames(new Error('Failed to fetch dynamically imported module'));

      // When its sandbox asks four times while the first rebuild runs
      for (let ask = 0; ask < 4; ask += 1) {
        askToRecover(fakes);
      }
      await answerConnection(fakes, 1);
      await fakes.changes.until(() => fakes.frame.getStatus() === 'failed');
      await vi.advanceTimersByTimeAsync(5_000);
      await answerConnection(fakes, 2);
      await fakes.changes.until(() => fakes.framesAsked() === 3);
      await vi.advanceTimersByTimeAsync(10_000);

      // Then
      expect(fakes.connections).toHaveLength(3);
      expect(fakes.statuses).toEqual(['connecting', 'connected', 'connecting', 'failed', 'connecting', 'failed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a user who changes a device permission in the menu, the app is rebuilt in a new frame', async () => {
    // Given
    const fakes = harness();
    await settle(fakes, subdomainProduct('camera-menu'), 0);

    // When
    fakes.announce({ label: 'camera-menu', permissions: ['Camera'] });
    await answerConnection(fakes, 1);

    // Then
    await fakes.changes.until(() => fakes.hosts.length === 2 && (fakes.hosts[0]?.dispose.mock.calls.length ?? 0) > 0);
  });

  it('As a user who changes a permission that no frame policy covers, the app keeps its frame', async () => {
    // Given
    const fakes = harness();
    await settle(fakes, subdomainProduct('notifications'), 0);

    // When
    fakes.announce({ label: 'notifications', permissions: ['Notifications'], device: false });

    // Then
    expect(fakes.frame.getStatus()).toBe('connected');
    expect(fakes.connections).toHaveLength(1);
  });

  it("As a user granting a device permission in the app's own prompt, the app is rebuilt only once my answer has reached it", async () => {
    // Given a product whose frame is piped to a core the test speaks for
    const fakes = harness();
    const port = new MessageChannel();
    const toProduct: unknown[] = [];
    port.port2.onmessage = event => {
      toProduct.push(event.data);
      fakes.changes.notify();
    };
    const rendered = fakes.frame.render(subdomainProduct('prompted'));
    const core = await answerConnection(fakes, 0);
    await rendered;
    nth(fakes.hosts, 0).options.onPort(port.port1);

    // When the user grants the camera, and other core traffic reaches the product before the answer
    fakes.announce({ label: 'prompted', permissions: ['Camera'], fromPrompt: true });
    core.listener?.(loginResponseFrame('unrelated', { success: true, value: 'Success' }));
    await fakes.changes.until(() => toProduct.length === 1);

    // Then nothing is rebuilt yet
    expect(fakes.connections).toHaveLength(1);

    // When the answer reaches the product
    const answer = encodeWireMessage({
      requestId: 'camera-prompt',
      payload: {
        traitId: PERMISSIONS_REQUEST_DEVICE_PERMISSION.trait,
        methodId: PERMISSIONS_REQUEST_DEVICE_PERMISSION.method,
        messageType: MESSAGE_TYPE_RESPONSE,
        value: new Uint8Array(),
      },
    });
    if (answer.isErr()) {
      throw answer.error;
    }
    core.listener?.(answer.value);

    // Then the app is rebuilt in a new frame
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => (fakes.hosts[0]?.dispose.mock.calls.length ?? 0) > 0 && toProduct.length === 2);
    expect(toProduct).toHaveLength(2);
    port.port2.close();
  });
});

describe('product frame and a device grant during a rebuild', () => {
  it("As a user granting a device permission in the app's own prompt while its frame is rebuilt, the new frame gets the grant", async () => {
    // Given a product whose frame is being rebuilt, past the point where the new frame read its policy
    const fakes = harness();
    await settle(fakes, subdomainProduct('regrant'), 0);
    const release = fakes.holdNextFrame();
    fakes.announce({ label: 'regrant', permissions: ['Microphone'] });
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.framesAsked() === 2);

    // When the user grants the camera in the app's own prompt
    fakes.announce({ label: 'regrant', permissions: ['Camera'], fromPrompt: true });
    release();

    // Then the frame is built once more, so its policy is read after the grant
    await answerConnection(fakes, 2);
    await fakes.changes.until(() => fakes.frame.getStatus() === 'connected' && fakes.framesAsked() === 3);
    expect(fakes.container.querySelectorAll('iframe')).toHaveLength(1);
    expect(fakes.container.querySelector('iframe')).toBe(fakes.hosts.at(-1)?.iframe);
    expect(fakes.hosts[1]?.dispose).toHaveBeenCalled();
  });

  it("As a user, I grant a device permission for another app while this app's frame is rebuilt and this frame is left alone", async () => {
    // Given a product whose frame is being rebuilt
    const fakes = harness();
    await settle(fakes, subdomainProduct('mine'), 0);
    const release = fakes.holdNextFrame();
    fakes.announce({ label: 'mine', permissions: ['Microphone'] });
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.framesAsked() === 2);

    // When a prompt grant arrives for another product
    fakes.announce({ label: 'other', permissions: ['Camera'], fromPrompt: true });
    release();

    // Then no further frame is asked for
    await fakes.changes.until(() => fakes.frame.getStatus() === 'connected');
    expect(fakes.framesAsked()).toBe(2);
  });

  it('As a user, I grant a device permission for another app while this app is shown and this frame is left alone', async () => {
    // Given a connected product
    const fakes = harness();
    await settle(fakes, subdomainProduct('mine'), 0);

    // When a prompt grant arrives for another product
    fakes.announce({ label: 'other', permissions: ['Camera'], fromPrompt: true });

    // Then no frame is asked for
    expect(fakes.framesAsked()).toBe(1);
    expect(fakes.frame.getStatus()).toBe('connected');
  });
});

describe('product frame and the topbar login', () => {
  function loginOver(fakes: FakePageCore): () => Promise<void> {
    const commands = createCoreAuthCommands({
      auth: createSyncStore<DotliAuthState>('auth', { tag: 'Disconnected' }, { equals: () => false }),
      core: fakes.core,
      session: { reportLoginFailure: vi.fn(), reportLogoutWithoutCore: vi.fn() },
      walletMode: () => 'app',
      leaveLocalWallet: () => Promise.resolve('reloading' as const),
    });
    return () => commands.login();
  }

  it('As a user who logs in before the product has loaded, the product joins the core my login runs on and my pairing survives its render', async () => {
    // Given: a product page whose topbar login is pairing
    const fakes = createFakePageCore();
    fakes.core.setProduct({ label: 'product' });
    const login = loginOver(fakes);
    void login();
    const sent: { requestId?: string } = {};
    const pairing = await answerConnection(
      fakes,
      0,
      makeProvider({
        onPostMessage(message) {
          sent.requestId = requestIdFromFrame(message);
        },
      }),
    );
    await fakes.changes.until(() => sent.requestId !== undefined);
    const shell = harness(fakes);

    // When: the product renders mid-pairing
    await settle(shell, iframeProduct('product'), 1);

    // Then: one core serves both, and the pairing's connection is still open
    expect(fakes.runtimes).toHaveLength(1);
    expect(pairing.dispose).not.toHaveBeenCalled();

    // When: the wallet completes pairing
    pairing.listener?.(loginResponseFrame(sent.requestId ?? '', { success: true, value: 'Success' }));

    // Then: the login's connection closes, and the product keeps the core
    await fakes.changes.until(() => pairing.dispose.mock.calls.length === 1);
    expect(fakes.runtimes[0]?.dispose).not.toHaveBeenCalled();
  });

  it('As a user who logs in while the core is still starting, the product render does not cancel my login', async () => {
    // Given: a topbar login waiting for its connection to the core
    const fakes = createFakePageCore();
    fakes.core.setProduct({ label: 'product' });
    void loginOver(fakes)();
    await fakes.changes.until(() => fakes.connections.length === 1);
    const shell = harness(fakes);

    // When: the product renders before that connection is open
    await settle(shell, iframeProduct('product'), 1);
    const pairing = await answerConnection(fakes, 0);

    // Then: the login still goes out, on the same core
    await fakes.changes.until(() => pairing.postMessage.mock.calls.length === 1);
    expect(pairing.dispose).not.toHaveBeenCalled();
    expect(fakes.runtimes).toHaveLength(1);
  });
});

describe('product frame and the page core', () => {
  it('As a dApp user whose core goes down under my product, the product is rendered again on the replacement core', async () => {
    // Given
    const fakes = harness();
    const rendered = fakes.frame.render(subdomainProduct('product'));
    const dead = await answerConnection(fakes, 0);
    await rendered;

    // When
    dead.closeListener?.(new Error('worker fatal error: boom'));
    await answerConnection(fakes, 1);

    // Then: the old frame and its dead core go once the new frame is up
    await fakes.changes.until(() => fakes.frame.getStatus() === 'connected');
    expect(fakes.statuses).toEqual(['connecting', 'connected', 'lost', 'connecting', 'connected']);
    expect(fakes.runtimes).toHaveLength(2);
    expect(nth(fakes.hosts, 0).dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.container.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('As an operator, I see a render on a replacement core counted as ok with its reason', async () => {
    // Given
    const fakes = harness();
    const metrics = bindRecordingSentry({ onFinished: onTestFinished, onRecord: fakes.changes.notify });
    const rendered = fakes.frame.render(subdomainProduct('product'));
    const dead = await answerConnection(fakes, 0);
    await rendered;

    // When
    crash(dead);
    await reconnect(fakes, 1);

    // Then
    await fakes.changes.until(() => metrics.counted('product.rerender').length === 1);
    expect(metrics.counted('product.rerender')).toEqual([{ outcome: 'ok', reason: 'replacement' }]);
  });

  it('As an operator, I see a rebuild that a newer render took over counted as aborted with its reason', async () => {
    // Given: a rebuild at the sandbox's ask, still connecting
    const fakes = harness();
    const metrics = bindRecordingSentry({ onFinished: onTestFinished, onRecord: fakes.changes.notify });
    await settle(fakes, subdomainProduct('rebuilt'), 0);
    askToRecover(fakes);
    await fakes.changes.until(() => fakes.connections.length === 2);

    // When the shell renders another product
    const next = fakes.frame.render(subdomainProduct('next'));
    await answerConnection(fakes, 2);
    await next;

    // Then
    await fakes.changes.until(() => metrics.counted('product.rerender').length === 1);
    expect(metrics.counted('product.rerender')).toEqual([{ outcome: 'aborted', reason: 'recover' }]);
  });

  it('As a dApp user whose replacement core cannot boot, the frame reports failed and stops there', async () => {
    // Given
    const fakes = harness();
    const rendered = fakes.frame.render(subdomainProduct('product'));
    const dead = await answerConnection(fakes, 0);
    await rendered;
    fakes.nextBoots.push(() => new Error('worker fatal error: redial'));

    // When
    dead.closeListener?.(new Error('worker fatal error: boom'));

    // Then
    await fakes.changes.until(() => fakes.frame.getStatus() === 'failed');
    expect(fakes.statuses).toEqual(['connecting', 'connected', 'lost', 'connecting', 'failed']);
    expect(fakes.connections).toHaveLength(1);
  });

  it('As a dApp user naming another product after a redial failed, the new product is not reported lost', async () => {
    // Given: a redial that faulted and was dropped by the page naming another product
    const fakes = harness();
    const rendered = fakes.frame.render(subdomainProduct('first'));
    const dead = await answerConnection(fakes, 0);
    await rendered;
    fakes.nextBoots.push(() => new Error('worker fatal error: redial'));
    dead.closeListener?.(new Error('worker fatal error: boom'));
    await fakes.changes.until(() => fakes.frame.getStatus() === 'failed');
    fakes.core.setProduct({ label: 'second' });

    // When
    await settle(fakes, subdomainProduct('second'), 1);

    // Then
    expect(fakes.frame.getStatus()).toBe('connected');
    expect(fakes.statuses).toEqual([
      'connecting',
      'connected',
      'lost',
      'connecting',
      'failed',
      'connecting',
      'connected',
    ]);
  });

  it('As a dApp user whose core goes down while my product is still being shown, the product is rendered again on the replacement core', async () => {
    // Given a render whose connection is open and whose frame is still being built
    const fakes = harness();
    const release = fakes.holdNextFrame();
    const rendered = fakes.frame.render(subdomainProduct('product'));
    const dead = await answerConnection(fakes, 0);
    await fakes.changes.until(() => fakes.framesAsked() === 1);

    // When the core goes down before the frame is up
    dead.closeListener?.(new Error('worker fatal error: boom'));
    release();
    await rendered;
    await answerConnection(fakes, 1);

    // Then the product ends connected on the replacement core
    await fakes.changes.until(() => fakes.frame.getStatus() === 'connected');
    expect(fakes.statuses).toEqual(['connecting', 'lost', 'connecting', 'connected']);
    expect(fakes.runtimes).toHaveLength(2);
    expect(nth(fakes.runtimes, 1).createProvider).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.container.querySelectorAll('iframe')).toHaveLength(1);
    expect(fakes.container.querySelector('iframe')).toBe(nth(fakes.hosts, 1).iframe);
  });

  it('As a local wallet user whose pairing core turned stale under my product, I see the product rendered again on my local core', async () => {
    // Given a product on a pairing core
    const fakes = harness();
    await settle(fakes, subdomainProduct('product'), 0);

    // When another tab's login brings the local wallet, so the pairing core turns stale
    fakes.findLocalWallet();
    await answerConnection(fakes, 1);

    // Then the product ends connected on the local core, and the stale core goes
    await fakes.changes.until(
      () => fakes.frame.getStatus() === 'connected' && (fakes.runtimes[0]?.dispose.mock.calls.length ?? 0) === 1,
    );
    expect(fakes.statuses).toEqual(['connecting', 'connected', 'lost', 'connecting', 'connected']);
    expect(fakes.runtimes).toHaveLength(2);
    expect(nth(fakes.runtimes, 1).createProvider).toHaveBeenCalledTimes(1);
    expect(fakes.container.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('As a dApp user, a core dialed for another product that cannot boot leaves my product connected', async () => {
    // Given
    const fakes = harness();
    await settle(fakes, subdomainProduct('mine'), 0);
    fakes.nextBoots.push(() => new Error('worker fatal error: boot'));

    // When a login dials a core for another product and it cannot boot
    fakes.core.setProduct({ label: 'other' });
    await expect(fakes.core.acquire()).rejects.toThrow('boot');

    // Then
    expect(fakes.core.getCoreStatus()).toBe('faulted');
    expect(fakes.frame.getStatus()).toBe('connected');
    expect(fakes.statuses).toEqual(['connecting', 'connected']);
  });

  it('As a dApp user whose core refuses another connection, my product is rendered again on the replacement core', async () => {
    // Given a product on screen and a second connection asked of its core
    const fakes = harness();
    await settle(fakes, subdomainProduct('product'), 0);
    const other = await fakes.core.acquire();
    const refused = other.connect();
    await fakes.changes.until(() => fakes.connections.length === 2);

    // When the core refuses it
    nth(fakes.connections, 1).reject(new Error('runtime disposed'));
    await expect(refused).rejects.toThrow('runtime disposed');
    other.release();
    await answerConnection(fakes, 2);

    // Then
    await fakes.changes.until(() => fakes.frame.getStatus() === 'connected');
    expect(fakes.statuses).toEqual(['connecting', 'connected', 'lost', 'connecting', 'connected']);
    expect(fakes.runtimes).toHaveLength(2);
    expect(nth(fakes.runtimes, 1).createProvider).toHaveBeenCalledTimes(1);
  });

  it('As a dApp user whose core dies under every render, I see the product rendered again at most once per interval and then reported failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      // Given a product on screen, rendered again once on a replacement after its core died
      const fakes = harness();
      const rendered = fakes.frame.render(subdomainProduct('product'));
      const first = await answerConnection(fakes, 0);
      await rendered;
      crash(first);
      const second = await reconnect(fakes, 1);

      // When the replacement dies soon after too
      crash(second);
      await vi.advanceTimersByTimeAsync(4_000);

      // Then the next render waits out the interval
      expect(fakes.frame.getStatus()).toBe('lost');
      expect(fakes.connections).toHaveLength(2);

      // When the interval has passed and the third core dies as well
      await vi.advanceTimersByTimeAsync(1_000);
      crash(await reconnect(fakes, 2));
      await vi.advanceTimersByTimeAsync(60_000);

      // Then the frame gives up and reports failed
      expect(fakes.frame.getStatus()).toBe('failed');
      expect(fakes.connections).toHaveLength(3);
      expect(fakes.statuses).toEqual([
        'connecting',
        'connected',
        'lost',
        'connecting',
        'connected',
        'lost',
        'connecting',
        'connected',
        'failed',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a dApp user whose core outlives the window before it dies, I see my product rendered again with a fresh budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      // Given a product whose core died twice in quick succession
      const fakes = harness();
      const rendered = fakes.frame.render(subdomainProduct('product'));
      const first = await answerConnection(fakes, 0);
      await rendered;
      crash(first);
      const second = await reconnect(fakes, 1);
      await vi.advanceTimersByTimeAsync(5_000);
      crash(second);
      const third = await reconnect(fakes, 2);

      // When the third core stays up past the window, then dies, and its replacement dies soon after
      await vi.advanceTimersByTimeAsync(61_000);
      crash(third);
      const fourth = await reconnect(fakes, 3);
      crash(fourth);
      await vi.advanceTimersByTimeAsync(5_000);
      await reconnect(fakes, 4);

      // Then the product is back on screen
      expect(fakes.frame.getStatus()).toBe('connected');
      expect(fakes.statuses).not.toContain('failed');
      expect(fakes.connections).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a dApp user whose product is loaded afresh after its cores died twice, I see it rendered again with a fresh budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      // Given a product whose core died twice in quick succession
      const fakes = harness();
      const rendered = fakes.frame.render(subdomainProduct('product'));
      const first = await answerConnection(fakes, 0);
      await rendered;
      crash(first);
      const second = await reconnect(fakes, 1);
      await vi.advanceTimersByTimeAsync(5_000);
      crash(second);
      await reconnect(fakes, 2);

      // When the loader renders the product afresh, and its core dies twice soon after
      const fresh = fakes.frame.render(subdomainProduct('product', 'fresh-cid'));
      const fourth = await answerConnection(fakes, 3);
      await fresh;
      await vi.advanceTimersByTimeAsync(5_000);
      crash(fourth);
      const fifth = await reconnect(fakes, 4);
      crash(fifth);
      await vi.advanceTimersByTimeAsync(5_000);
      await reconnect(fakes, 5);

      // Then the product is back on screen
      expect(fakes.frame.getStatus()).toBe('connected');
      expect(fakes.statuses).not.toContain('failed');
      expect(fakes.container.querySelector('iframe')?.dataset['src']).toContain('cid=fresh-cid');
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a dApp user whose core dies while a newer render connects to it, I see that render shown on the replacement core', async () => {
    // Given a product on screen and a newer render waiting for its connection on the same core
    const fakes = harness();
    const rendered = fakes.frame.render(subdomainProduct('product', 'first-cid'));
    const first = await answerConnection(fakes, 0);
    await rendered;
    const newer = fakes.frame.render(subdomainProduct('product', 'second-cid'));
    await fakes.changes.until(() => fakes.connections.length === 2);

    // When the core dies, and the connection the newer render asked for fails with it
    crash(first);
    nth(fakes.connections, 1).reject(new Error('runtime disposed'));
    await answerConnection(fakes, 2);
    await newer;

    // Then the newer render is on screen, connected to the replacement core
    expect(fakes.frame.getStatus()).toBe('connected');
    expect(fakes.runtimes).toHaveLength(2);
    expect(nth(fakes.runtimes, 1).createProvider).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.container.querySelectorAll('iframe')).toHaveLength(1);
    expect(fakes.container.querySelector('iframe')?.dataset['src']).toContain('cid=second-cid');
  });
});
