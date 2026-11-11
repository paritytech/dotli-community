// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { asProductId } from '@parity/truapi';
import { PERMISSIONS_REQUEST_DEVICE_PERMISSION } from '@parity/truapi/wire-table';
import { isSandboxOrigin } from '@dotli/config';
import { startSandboxChannel, type SandboxChannel, type SandboxMessageType } from '@dotli/sandbox-wire';
import { createDeferred, realTimers, type Timers } from '@dotli/shared';
import { atom } from 'nanostores';
import { catchError, catchRejection, createManualTimers, nth, readOutcome } from '@dotli/shared/testing';
import { encodeResponseFrame } from '../testing/encodeResponseFrame.js';
import { bindReports } from '../testing/bindReports.js';
import { rethrow } from '../testing/rethrow.js';
import { createCoreAuthCommands } from './createCoreAuthCommands.js';
import type { DotliAuthState } from './session/types.js';
import { pendingResets } from './createPendingResets.js';
import {
  createProductFrame,
  type FrameHostParams,
  type FrameProduct,
  type ProductFrameParams,
  type ProductFramePage,
} from './createProductFrame.js';
import { productState } from './state/productState.js';
import type { ProductFacts } from '../getProductFacts.js';
import { createPermissionAuthorizations } from './createPermissionAuthorizations.js';
import type { PermissionsChange } from './state/productPermissions.js';
import { buildLoginResponseFrame } from '../testing/buildLoginResponseFrame.js';
import { getFrameRequestId } from '../testing/getFrameRequestId.js';
import {
  answerConnection,
  createFakePageCore,
  createFakeProvider,
  type FakeCoreProvider,
  type FakePageCore,
} from './createPageCore.fake.js';
import { parseH160Address } from '../h160Address.js';
import {
  breakFramePosts,
  createFakeIframe,
  createFakeProductFrameView,
  readFramePosts,
} from './createProductFrame.fake.js';
import { createFakeStoredSession } from './session/createCoreStorage.fake.js';

type PageLocation = ReturnType<ProductFramePage['location']>;

type FakeIframeHost = {
  /** The params the frame was built with. */
  options: FrameHostParams;
  /** The frame's iframe. */
  iframe: HTMLIFrameElement;
  /** Records the frame's dispose. */
  dispose: ReturnType<typeof vi.fn<() => void>>;
};

type CreateHarnessParams = {
  /** The page core under the frame, a fresh fake by default. */
  fakes?: FakePageCore;
  /** Builds each frame, a host that records it and that the test can hold or fail by default. */
  createIframeHost?: ProductFrameParams['createIframeHost'];
  /** The frame's clock and timers, the page's own by default. */
  timers?: Timers;
  /** What differs from the root of a dev host in the host page's location. */
  location?: Partial<PageLocation>;
  /** Hears a throw of a sandbox channel handler, `rethrow` by default so a spec fails on it. */
  reportHandlerError?: (error: unknown, type: SandboxMessageType) => void;
};

type AskToRecoverParams = {
  /** The index of the frame whose sandbox asks, the first by default. */
  host?: number;
  /** The window the ask comes from, the frame's own by default. */
  from?: unknown;
  /** The origin the ask comes from, the frame's own by default. */
  origin?: string;
};

type BuildSandboxMessageParams = {
  /** The message the sandbox posts. */
  data: unknown;
  /** The origin it comes from. */
  origin: string;
  /** The window it comes from. */
  source: unknown;
};

type CreateTopbarLoginParams = {
  /** The page core the login runs on. */
  fakes: FakePageCore;
};

type BuildSubdomainProductParams = {
  /** The product's content id, `cid` by default. */
  cid?: string;
  /** Whether the product declares chat, no by default. */
  chat?: boolean;
};

/** The host page, at the root of a dev host. */
const ROOT_LOCATION: PageLocation = {
  href: 'http://localhost:3000/',
  protocol: 'http:',
  hostname: 'localhost',
  port: '3000',
  pathname: '/',
  search: '',
  hash: '',
};

/** As the bridge wires it, over the real page core with fake runtimes and frames the test can see. */
function createHarness({
  fakes = createFakePageCore(),
  createIframeHost,
  timers = realTimers,
  location = {},
  reportHandlerError = rethrow,
}: CreateHarnessParams = {}) {
  const hosts: FakeIframeHost[] = [];
  let held: Promise<undefined> | null = null;
  let asked = 0;
  let failing: Error | null = null;
  const permissionListeners = new Set<(change: PermissionsChange) => void>();
  const frameView = createFakeProductFrameView();
  /** The window the sandbox posts to. */
  const sandboxWindow = new EventTarget();
  const started = startSandboxChannel({
    target: sandboxWindow,
    isTrustedOrigin: isSandboxOrigin,
    report: reportHandlerError,
  });
  onTestFinished(() => {
    started.stop();
  });
  // One token per handler the frame registered and has not removed.
  const channelHandlers = new Set<object>();
  const channel: SandboxChannel = {
    on(type, handler) {
      const token = {};
      channelHandlers.add(token);
      const stopHandler = started.on(type, handler);
      return stop;

      function stop(): void {
        channelHandlers.delete(token);
        stopHandler();
      }
    },
  };
  const pageLocation = { ...ROOT_LOCATION, ...location };
  const frame = createProductFrame({
    core: fakes.core,
    createIframeHost: createIframeHost ?? createRecordingHost,
    channel,
    subscribePermissionChanges: listener => {
      permissionListeners.add(listener);
      return () => {
        permissionListeners.delete(listener);
      };
    },
    permissions: createPermissionAuthorizations(),
    view: {
      ...frameView.view,
      showStatus: status => {
        frameView.view.showStatus(status);
        fakes.changes.notify();
      },
    },
    notify: () => undefined,
    page: {
      location: () => pageLocation,
      reload: vi.fn(),
    },
    timers,
  });
  return {
    ...fakes,
    frame,
    /** The page around the frame. */
    frameView,
    /** Every frame the product frame created, in order. */
    hosts,
    /** The hosts not yet disposed, oldest first. */
    listOnScreen: (): FakeIframeHost[] => hosts.filter(host => host.dispose.mock.calls.length === 0),
    /** Every status the frame showed after the `idle` it shows as it is built, in order. */
    listStatuses: () => frameView.statuses.slice(1),
    /** The status the frame showed last. */
    readLastStatus: () => frameView.statuses.at(-1),
    /**
     * Holds the next frame, after its render read the permission policy, until the returned release. The release lets
     * the frame through, or with a failure rejects it with that failure.
     */
    holdNextFrame,
    /** How many frames were asked for, held or not. */
    countFramesAsked: () => asked,
    /** Fails every frame asked for from now on, as a frame chunk that cannot load, and with `null` stops failing them. */
    failFrames,
    /** The permission store announcing a change. */
    announce,
    /** Renders `product` and answers the core connection it asks for. */
    settle,
    /** The sandbox in a frame asking to be rebuilt, as it does after a reload, or another window of its origin asking. */
    askToRecover,
    /** Answers the connection the render on a replacement core asks for, and waits until the product is back on screen. */
    reconnect,
    /** Puts up both screens the way the shell does, as disposers the test can count. */
    putUpScreens,
    /** How many listeners the permission store holds. */
    countPermissionListeners: () => permissionListeners.size,
    /** How many handlers the sandbox channel holds. */
    countChannelHandlers: () => channelHandlers.size,
  };

  async function createRecordingHost(options: FrameHostParams) {
    asked += 1;
    fakes.changes.notify();
    if (failing !== null) {
      throw failing;
    }
    const gate = held;
    held = null;
    await gate;
    const iframe = createFakeIframe();
    const dispose = vi.fn(() => {
      fakes.changes.notify();
    });
    hosts.push({ options, iframe, dispose });
    fakes.changes.notify();
    return { iframe, dispose };
  }

  function holdNextFrame(): (failure?: Error) => void {
    const gate = createDeferred<undefined>();
    held = gate.promise;
    return failure => {
      if (failure === undefined) {
        gate.resolve(undefined);
        return;
      }
      gate.reject(failure);
    };
  }

  function failFrames(failure: Error | null): void {
    failing = failure;
  }

  function announce(change: Partial<PermissionsChange> & { label: string }): void {
    for (const listener of [...permissionListeners]) {
      listener({ permissions: [], allowChanged: true, fromPrompt: false, ...change });
    }
  }

  async function settle(product: FrameProduct, connection: number): Promise<void> {
    const rendered = frame.render(product);
    await answerConnection(fakes, connection);
    await rendered;
  }

  function askToRecover({ host = 0, from, origin }: AskToRecoverParams = {}): void {
    const asking = nth(hosts, host);
    sandboxWindow.dispatchEvent(
      buildSandboxMessage({
        data: { type: 'dotli:sandbox-recover' },
        origin: origin ?? asking.options.allowedOrigin ?? '',
        source: from === undefined ? asking.iframe.contentWindow : from,
      }),
    );
  }

  async function reconnect(connection: number): Promise<FakeCoreProvider> {
    const provider = await answerConnection(fakes, connection);
    await fakes.changes.until(() => frameView.statuses.at(-1) === 'connected');
    return provider;
  }

  function putUpScreens() {
    const disposeLoading = vi.fn();
    const disposePage = vi.fn();
    frameView.showScreen('loading', disposeLoading);
    frameView.showScreen('page', disposePage);
    return { disposeLoading, disposePage };
  }
}

/** A sandbox message, as the browser delivers it from the window `source` of `origin`. */
function buildSandboxMessage({ data, origin, source }: BuildSandboxMessageParams): Event {
  return Object.assign(new Event('message'), { data, origin, source });
}

/** The core under `connection` going down, as a crashed worker closes every connection it serves. */
function crash(connection: FakeCoreProvider): void {
  connection.closeListener?.(new Error('worker fatal error: boom'));
}

function buildIframeProduct(label: string): FrameProduct {
  return { mode: 'iframe', label, url: `https://${label}.example/app`, chat: Promise.resolve(false) };
}

function buildSubdomainProduct(
  label: string,
  { cid = 'cid', chat = false }: BuildSubdomainProductParams = {},
): FrameProduct {
  return { mode: 'subdomain', label, cid, chat: Promise.resolve(chat), facts: {} };
}

/** Whether the iframe of every host is the one attached at the same place, compared by identity. */
function matchAttached(attached: (HTMLIFrameElement | undefined)[], hosts: FakeIframeHost[]): boolean[] {
  return hosts.map((host, index) => attached[index] === host.iframe);
}

/** A product page whose topbar login runs on `fakes`, as the shell starts it. */
function createTopbarLogin({ fakes }: CreateTopbarLoginParams): () => Promise<void> {
  const auth = atom<DotliAuthState>({ tag: 'Disconnected' });
  const commands = createCoreAuthCommands({
    auth,
    core: fakes.core,
    session: { reportLoginFailure: vi.fn() },
    isLocalWallet: () => false,
    storedSession: createFakeStoredSession({ blob: '0xsession' }),
  });
  return async () => {
    await commands.login();
  };
}

describe('product frame renders', () => {
  it('As a dApp user, I open a second app before the first connects and the first app frame that connects late goes with its connection and core', async () => {
    // Given
    const fakes = createHarness();

    // When the second render connects first, then the first
    const first = fakes.frame.render(buildIframeProduct('first'));
    await fakes.changes.until(() => fakes.connections.length === 1);
    const second = fakes.frame.render(buildIframeProduct('second'));
    const secondProvider = await answerConnection(fakes, 1);
    await second;
    const shownBeforeFirst = fakes.listOnScreen()[0]?.options.iframeUrl;
    const firstProvider = await answerConnection(fakes, 0);
    await first;
    await fakes.changes.until(() => fakes.hosts.length === 2);
    const firstHost = fakes.hosts.find(host => host.options.iframeUrl === 'https://first.example/app');
    await fakes.changes.until(() => (firstHost?.dispose.mock.calls.length ?? 0) === 1);

    // Then
    expect(shownBeforeFirst).toBe('https://second.example/app');
    expect(firstProvider.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(secondProvider.dispose).not.toHaveBeenCalled();
    expect(fakes.listOnScreen()[0]?.options.iframeUrl).toBe('https://second.example/app');
  });

  it('As a dApp user, I open a second app while the first app frame is still being built and the first frame goes with its connection and core', async () => {
    // Given a render whose frame is still being built
    const fakes = createHarness();
    const release = fakes.holdNextFrame();
    const first = fakes.frame.render(buildIframeProduct('first'));
    const firstProvider = await answerConnection(fakes, 0);
    await fakes.changes.until(() => fakes.countFramesAsked() === 1);

    // When a newer render connects, then the first frame comes up
    const second = fakes.frame.render(buildIframeProduct('second'));
    await answerConnection(fakes, 1);
    await second;
    release();
    await first;
    await fakes.changes.until(() => fakes.hosts.length === 2);
    const firstHost = fakes.hosts.find(host => host.options.iframeUrl === 'https://first.example/app');
    await fakes.changes.until(() => (firstHost?.dispose.mock.calls.length ?? 0) === 1);

    // Then the first frame goes, and with it its connection and its core
    expect(firstProvider.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.readLastStatus()).toBe('connected');
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.listOnScreen()[0]?.options.iframeUrl).toBe('https://second.example/app');
  });

  it('As a dApp user, I open another app and see the previous app frame until its replacement connects', async () => {
    // Given
    const fakes = createHarness();
    await fakes.settle(buildIframeProduct('first'), 0);
    const firstHost = nth(fakes.hosts, 0);

    // When the replacement asks for its connection, then connects
    const second = fakes.frame.render(buildIframeProduct('second'));
    await fakes.changes.until(() => fakes.connections.length === 2);
    const shownWhileConnecting = fakes.listOnScreen().includes(firstHost);
    const disposalsWhileConnecting = firstHost.dispose.mock.calls.length;
    await answerConnection(fakes, 1);
    await second;

    // Then
    expect({ shownWhileConnecting, disposalsWhileConnecting }).toEqual({
      shownWhileConnecting: true,
      disposalsWhileConnecting: 0,
    });
    expect(firstHost.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.listOnScreen()[0]?.options.iframeUrl).toBe('https://second.example/app');
  });

  it('As a dApp user, I open an app by iframe and then by subdomain and each app frame is handed to the frame layout', async () => {
    // Given
    const fakes = createHarness();
    const products = [buildIframeProduct('product'), buildSubdomainProduct('product')];

    // When
    const lastAttached: (HTMLIFrameElement | undefined)[] = [];
    for (const [index, product] of products.entries()) {
      await fakes.settle(product, index);
      lastAttached.push(fakes.frameView.attached.at(-1));
    }

    // Then
    expect(matchAttached(lastAttached, fakes.hosts)).toEqual([true, true]);
  });

  it.each(['/x.dot@evil.com/pay', '/foo.dotify/pay'])(
    'As a user, I open an app under an adversarial deep path and its frame stays on the app sandbox origin: %s',
    async path => {
      // Given
      const fakes = createHarness({ location: { href: `http://localhost:3000${path}`, pathname: path } });

      // When
      await fakes.settle(buildSubdomainProduct('first'), 0);
      const created = nth(fakes.hosts, 0);
      const iframeUrl = new URL(created.options.iframeUrl);

      // Then
      expect(iframeUrl.hostname).toBe('first.app.localhost');
      expect(iframeUrl.pathname).toBe(path);
      expect(created.options.allowedOrigin).toBe(iframeUrl.origin);
    },
  );

  it('As a visitor, I open a product by its name in the path and the product gets only its own path', async () => {
    // Given
    const fakes = createHarness({
      location: {
        href: 'http://localhost:3000/Doom.dot/level/2?skill=3#boss',
        pathname: '/Doom.dot/level/2',
        search: '?skill=3',
        hash: '#boss',
      },
    });

    // When
    await fakes.settle(
      { mode: 'subdomain', label: 'doom', cid: 'cid', base: '/Doom.dot', chat: Promise.resolve(false), facts: {} },
      0,
    );
    const url = new URL(nth(fakes.hosts, 0).options.iframeUrl);

    // Then
    expect(url.hostname).toBe('doom.app.localhost');
    expect(url.pathname).toBe('/level/2');
    expect(url.searchParams.get('skill')).toBe('3');
    expect(url.hash).toBe('#boss');
  });

  it('As a developer on a local.host product subdomain, I open the product and its sandbox loads on the app subdomain of local.host', async () => {
    // Given a page on a product subdomain of local.host
    const fakes = createHarness({
      location: {
        href: 'https://doom.local.host:4321/',
        protocol: 'https:',
        hostname: 'doom.local.host',
        port: '4321',
      },
    });

    // When the product frame settles
    await fakes.settle(buildSubdomainProduct('doom'), 0);
    const created = nth(fakes.hosts, 0);
    const url = new URL(created.options.iframeUrl);

    // Then the sandbox loads on the app subdomain of local.host
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('doom.app.local.host');
    expect(created.options.allowedOrigin).toBe(url.origin);
  });

  it('As a visitor, I open a subname and its sandbox loads on one hashed label a wildcard certificate covers', async () => {
    // Given
    const fakes = createHarness({
      location: { href: 'http://localhost:3000/pr16.back-me-up/', pathname: '/pr16.back-me-up/' },
    });

    // When
    await fakes.settle(
      {
        mode: 'subdomain',
        label: 'pr16.back-me-up',
        cid: 'cid',
        base: '/pr16.back-me-up',
        chat: Promise.resolve(false),
        facts: {},
      },
      0,
    );
    const url = new URL(nth(fakes.hosts, 0).options.iframeUrl);

    // Then
    expect(url.hostname).toMatch(/^sn--[0-9a-f]{59}\.app\.localhost$/);
  });

  it("As a visitor, I open a link carrying the sandbox's own params and get the host's values only, with my own params intact", async () => {
    // Given
    const search = '?fullReset=1&cid=forged&v=0&network=forged&chainBackend=forged&resolutionId=forged&a=b';
    const fakes = createHarness({
      location: { href: `http://localhost:3000/foo%20bar${search}`, pathname: '/foo%20bar', search },
    });

    // When
    await fakes.settle(buildSubdomainProduct('product', { cid: 'real-cid' }), 0);
    const url = new URL(nth(fakes.hosts, 0).options.iframeUrl);

    // Then
    expect(url.pathname).toBe('/foo%20bar');
    expect(url.searchParams.has('fullReset')).toBe(false);
    expect(url.searchParams.getAll('cid')).toEqual(['real-cid']);
    expect(url.searchParams.getAll('v')).toHaveLength(1);
    expect(url.searchParams.getAll('v')).not.toContain('0');
    expect(url.searchParams.getAll('network')).not.toContain('forged');
    expect(url.searchParams.getAll('chainBackend')).not.toContain('forged');
    expect(url.searchParams.getAll('resolutionId')).not.toContain('forged');
    expect(url.searchParams.get('a')).toBe('b');
  });

  it('As a visitor, I open a link that says fullReset=0 after the host scheduled a reset and the sandbox is purged once, by the host', async () => {
    // Given
    const fakes = createHarness({ location: { href: 'http://localhost:3000/?fullReset=0', search: '?fullReset=0' } });
    pendingResets.schedule(['sandbox']);

    // When
    await fakes.settle(buildSubdomainProduct('product'), 0);
    const resets = new URL(nth(fakes.hosts, 0).options.iframeUrl).searchParams.getAll('fullReset');

    // Then
    expect(resets).toEqual(['1']);
  });

  it('As a dApp user, I open an app that declares chat and one that does not, and the first connects as a Worker recorded chat-capable and the second as an App', async () => {
    // Given
    const fakes = createHarness();

    // When
    await fakes.settle(buildSubdomainProduct('chatty', { chat: true }), 0);
    const chattyProviders = nth(fakes.runtimes, 0).createProvider.mock.calls.length;
    const chattyState = productState.store.get();
    await fakes.settle(buildSubdomainProduct('quiet'), 1);

    // Then
    expect(nth(fakes.runtimes, 0).createProvider).toHaveBeenNthCalledWith(
      chattyProviders,
      expect.objectContaining({ executionKind: 'Worker' }),
    );
    expect(chattyState).toMatchObject({ status: 'loaded', label: 'chatty', chat: true });
    expect(fakes.runtimes.at(-1)?.createProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionKind: 'App' }),
    );
    expect(productState.store.get()).toMatchObject({ status: 'loaded', label: 'quiet', chat: false });
  });

  it('As a dApp user, I open a product and the page records the id its core parsed, so its chat is keyed as the core keys it', async () => {
    // Given a core that parses the asked id into another spelling
    const fakes = createHarness({
      fakes: createFakePageCore({ parseProductId: () => asProductId('canonical.paseo') }),
    });

    // When
    await fakes.settle(buildSubdomainProduct('chatty', { chat: true }), 0);

    // Then
    expect(productState.store.get()).toMatchObject({ status: 'loaded', label: 'chatty', productId: 'canonical.paseo' });
  });

  it('As a dApp user, I open my product and the tab names it by its published name from the first render, and the page knows its versions', async () => {
    // Given
    const fakes = createHarness();
    const facts: ProductFacts = {
      displayName: 'DOOM',
      description: 'Shoot demons.',
      manifestVersion: 1,
      appVersion: [1, 2, 3],
      owner: parseH160Address('0x1111111111111111111111111111111111111111'),
    };

    // When
    await fakes.settle({ mode: 'subdomain', label: 'doom', cid: 'cid', chat: Promise.resolve(false), facts }, 0);

    // Then
    expect(fakes.frameView.titles).toEqual([{ mode: 'subdomain', label: 'doom', displayName: 'DOOM' }]);
    expect(productState.store.get()).toMatchObject({ status: 'loaded', label: 'doom', facts });
  });
});

describe('product frame status', () => {
  it('As a user, I open an app and see the frame connecting, then connected once the app is on screen', async () => {
    // Given
    const fakes = createHarness();

    // When
    const rendered = fakes.frame.render(buildIframeProduct('product'));
    const statusWhileRendering = fakes.readLastStatus();
    await answerConnection(fakes, 0);
    await rendered;

    // Then
    expect(statusWhileRendering).toBe('connecting');
    expect(fakes.listStatuses()).toEqual(['connecting', 'connected']);
  });

  it('As a user, I open an app whose core never boots and the render fails with the frame reported failed', async () => {
    // Given
    const fakes = createHarness();
    const failure = new Error('worker fatal error: boot');
    fakes.nextBoots.push(() => failure);

    // When
    const error = await catchRejection(fakes.frame.render(buildSubdomainProduct('product')));

    // Then
    expect(error).toBe(failure);
    expect(fakes.listStatuses()).toEqual(['connecting', 'failed']);
  });

  it('As a dApp user whose frame code fails to load, I open the app and the render fails and lets go of its core', async () => {
    // Given
    const failure = new Error('Failed to fetch dynamically imported module');
    const fakes = createHarness({ createIframeHost: () => Promise.reject(failure) });

    // When
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const connection = await answerConnection(fakes, 0);
    const error = await catchRejection(rendered);

    // Then
    expect(error).toBe(failure);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.readLastStatus()).toBe('failed');
  });

  it('As a user, I open a newer version of an app before the first connects and the superseded render settles without an error', async () => {
    // Given
    const fakes = createHarness();
    const first = fakes.frame.render(buildSubdomainProduct('product', { cid: 'first-cid' }));
    await fakes.changes.until(() => fakes.connections.length === 1);

    // When
    const second = fakes.frame.render(buildSubdomainProduct('product', { cid: 'second-cid' }));
    const firstOutcome = await readOutcome(first);
    await answerConnection(fakes, 1);
    await second;

    // Then
    expect(firstOutcome).toBe('resolved');
    expect(fakes.readLastStatus()).toBe('connected');
  });
});

describe('product frame app roots', () => {
  it('As a user, I open an app subdomain and the page root goes while the loading overlay stays up', async () => {
    // Given
    const fakes = createHarness();
    const { disposeLoading, disposePage } = fakes.putUpScreens();

    // When
    await fakes.settle(buildSubdomainProduct('first'), 0);

    // Then
    expect(disposePage).toHaveBeenCalledTimes(1);
    expect(disposeLoading).not.toHaveBeenCalled();
    expect(fakes.listOnScreen()).toHaveLength(1);
  });

  it('As a user, I open an app subdomain again and the loading overlay the first render kept goes', async () => {
    // Given
    const fakes = createHarness();
    const { disposeLoading } = fakes.putUpScreens();
    await fakes.settle(buildSubdomainProduct('first', { cid: 'first-cid' }), 0);

    // When
    await fakes.settle(buildSubdomainProduct('first', { cid: 'second-cid' }), 1);

    // Then
    expect(disposeLoading).toHaveBeenCalledTimes(1);
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.listOnScreen()[0]?.options.iframeUrl).toContain('cid=second-cid');
  });

  it('As a user, I open an app by iframe and both the page and the loading roots go', async () => {
    // Given
    const fakes = createHarness();
    const { disposeLoading, disposePage } = fakes.putUpScreens();

    // When
    await fakes.settle(buildIframeProduct('product'), 0);

    // Then
    expect(disposePage).toHaveBeenCalledTimes(1);
    expect(disposeLoading).toHaveBeenCalledTimes(1);
    expect(disposePage.mock.invocationCallOrder[0]).toBeLessThan(nth(disposeLoading.mock.invocationCallOrder, 0));
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.frameView.countMountsCleared()).toBe(1);
  });
});

describe('product frame halted', () => {
  it('As a visitor whose app failed for good, I stay on the failure screen and the app lets go of its core with nothing rebuilt under it', async () => {
    // Given a product on screen, halted under the failure screen the page put up
    const fakes = createHarness();
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const live = await answerConnection(fakes, 0);
    await rendered;
    fakes.frame.halt();
    const connectionClosedOnHalt = live.dispose.mock.calls.length;
    const { disposeLoading, disposePage } = fakes.putUpScreens();

    // When its sandbox asks to be rebuilt, a device permission changes, and its core goes down
    fakes.askToRecover();
    fakes.announce({ label: 'product', permissions: ['Camera'] });
    crash(live);

    // Then its connection to the core closed with the halt, and the screen stays
    expect(connectionClosedOnHalt).toBe(1);
    expect(disposePage).not.toHaveBeenCalled();
    expect(disposeLoading).not.toHaveBeenCalled();
    expect(fakes.listStatuses()).toEqual(['connecting', 'connected', 'failed']);
    expect(fakes.countFramesAsked()).toBe(1);
  });

  it('As a visitor whose app failed for good while it was being rebuilt, I stay on the failure screen and the rebuild is dropped', async () => {
    // Given a product on screen whose sandbox asked to be rebuilt
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('product'), 0);
    fakes.askToRecover();

    // When the app fails for good under the failure screen, and the rebuild's frame then connects
    fakes.frame.halt();
    const { disposePage } = fakes.putUpScreens();
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.hosts.length === 2 && fakes.listOnScreen().length === 1);

    // Then the rebuilt frame is dropped, and the product that was on screen stays under the screen
    expect(disposePage).not.toHaveBeenCalled();
    expect(fakes.listOnScreen()).toEqual([nth(fakes.hosts, 0)]);
    expect(fakes.readLastStatus()).toBe('failed');
  });
});

describe('product frame disposed', () => {
  it('As a dApp user who leaves the page, I see the product on screen go with its connection and core', async () => {
    // Given a product on screen
    const fakes = createHarness();
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const live = await answerConnection(fakes, 0);
    await rendered;

    // When the frame is disposed
    fakes.frame.dispose();

    // Then the frame, its connection and its core go
    expect(fakes.listOnScreen()).toEqual([]);
    expect(live.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('As a dApp user who left the page, I change a device permission of the product that was on screen and nothing is rebuilt or listens for it', async () => {
    // Given a product on screen, then the frame disposed
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('product'), 0);
    fakes.frame.dispose();

    // When a device permission of the product changes
    fakes.announce({ label: 'product', permissions: ['Camera'] });

    // Then no frame is asked for, and the permission store holds no listener of the frame
    expect(fakes.countFramesAsked()).toBe(1);
    expect(fakes.connections).toHaveLength(1);
    expect(fakes.countPermissionListeners()).toBe(0);
  });

  it('As a dApp user who left the page, I see the sandbox that was on screen ask to be rebuilt and nothing is rebuilt or listens for it', async () => {
    // Given a product on screen, then the frame disposed
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('product'), 0);
    fakes.frame.dispose();

    // When its sandbox asks to be rebuilt
    fakes.askToRecover();

    // Then no frame is asked for, and the sandbox channel holds no handler of the frame
    expect(fakes.countFramesAsked()).toBe(1);
    expect(fakes.connections).toHaveLength(1);
    expect(fakes.countChannelHandlers()).toBe(0);
  });

  it('As a dApp user who leaves the page while a product connects, I see nothing mounted and its connection go', async () => {
    // Given a render waiting for its connection to the core
    const fakes = createHarness();
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    await fakes.changes.until(() => fakes.connections.length === 1);

    // When the frame is disposed, then the connection opens and the frame comes up
    fakes.frame.dispose();
    const connection = await answerConnection(fakes, 0);
    const outcome = await readOutcome(rendered);
    await fakes.changes.until(
      () => fakes.hosts.length === 1 && (fakes.frameView.attached.length > 0 || fakes.listOnScreen().length === 0),
    );

    // Then the render resolves, and the frame goes with its connection without being attached
    expect(outcome).toBe('resolved');
    expect(fakes.frameView.attached).toEqual([]);
    expect(fakes.listOnScreen()).toEqual([]);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  it('As an operator, I watch a frame disposed while a render on a replacement core waits out its interval and see no failure reported', async () => {
    // Given a product rendered again on a replacement core, whose render waits out the interval
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    const { counted } = bindReports({ onReport: fakes.changes.notify });
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const first = await answerConnection(fakes, 0);
    await rendered;
    crash(first);
    await fakes.reconnect(1);
    await fakes.changes.until(() => counted('product.rerender').length === 1);
    await timers.advance(0);
    const pendingBeforeDispose = timers.countPending();

    // When the frame is disposed
    fakes.frame.dispose();
    await timers.advance(0);

    // Then the wait ended at once, and only the render that was shown is counted
    expect(pendingBeforeDispose).toBe(1);
    expect(timers.countPending()).toBe(0);
    expect(counted('product.rerender')).toEqual([{ outcome: 'ok', reason: 'replacement' }]);
  });

  it('As an operator, I watch a frame disposed while a rebuild at the sandbox ask waits out its interval and see no failure reported', async () => {
    // Given a product rebuilt at its sandbox's ask, whose rebuild waits out the interval
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    const { counted } = bindReports({ onReport: fakes.changes.notify });
    await fakes.settle(buildSubdomainProduct('product'), 0);
    fakes.askToRecover();
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => counted('product.rerender').length === 1);
    await timers.advance(0);
    const pendingBeforeDispose = timers.countPending();

    // When the frame is disposed
    fakes.frame.dispose();
    await timers.advance(0);

    // Then the wait ended at once, and only the rebuild that was shown is counted
    expect(pendingBeforeDispose).toBe(1);
    expect(timers.countPending()).toBe(0);
    expect(counted('product.rerender')).toEqual([{ outcome: 'ok', reason: 'recover' }]);
  });

  it('As a dApp user who left the page, I see a product rendered after it resolve with nothing mounted', async () => {
    // Given a disposed frame
    const fakes = createHarness();
    fakes.frame.dispose();

    // When a product is rendered
    const outcome = await readOutcome(fakes.frame.render(buildSubdomainProduct('product')));

    // Then the render resolves, and no connection or frame is asked for
    expect(outcome).toBe('resolved');
    expect(fakes.connections).toHaveLength(0);
    expect(fakes.countFramesAsked()).toBe(0);
    expect(fakes.frameView.attached).toEqual([]);
  });

  it('As a dApp user whose product fails to go as I leave the page, I dispose the frame again and its failed dispose is not repeated', async () => {
    // Given a product on screen whose connection throws as it goes
    const fakes = createHarness();
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const live = await answerConnection(fakes, 0);
    await rendered;
    const failure = new Error('connection dispose failed');
    live.dispose.mockImplementationOnce(() => {
      throw failure;
    });

    // When the frame is disposed, and then disposed again
    const first = catchError(fakes.frame.dispose);
    const second = catchError(fakes.frame.dispose);

    // Then the first dispose threw the product's failure, the second threw nothing, and the connection went once
    expect(first).toBe(failure);
    expect(second).toBeUndefined();
    expect(live.dispose).toHaveBeenCalledTimes(1);
  });

  it('As a dApp user whose app failed to render, I leave the page and the frame is disposed without throwing', async () => {
    // Given a render that failed as the core never booted
    const fakes = createHarness();
    fakes.nextBoots.push(() => new Error('worker fatal error: boot'));
    await catchRejection(fakes.frame.render(buildSubdomainProduct('product')));

    // When the frame is disposed
    const thrown = catchError(fakes.frame.dispose);

    // Then it does not throw, and the frame holds no listener or handler
    expect(thrown).toBeUndefined();
    expect(fakes.countPermissionListeners()).toBe(0);
    expect(fakes.countChannelHandlers()).toBe(0);
  });
});

describe('product frame rebuilds', () => {
  it('As a dApp user, I keep the product open while its sandbox is rebuilt and the tab title is shown again for it', async () => {
    // Given a product on screen
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('titled'), 0);

    // When its sandbox asks to be rebuilt
    fakes.askToRecover();
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => (fakes.hosts[0]?.dispose.mock.calls.length ?? 0) > 0);

    // Then the page names the same product again, from whatever its root manifest has published by now
    expect(fakes.frameView.titles).toEqual([
      { mode: 'subdomain', label: 'titled' },
      { mode: 'subdomain', label: 'titled' },
    ]);
  });

  it('As a dApp user, I keep an app whose sandbox asks to be rebuilt twice in a row and it is rebuilt once', async () => {
    // Given
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    await fakes.settle(buildSubdomainProduct('twice'), 0);

    // When
    fakes.askToRecover();
    fakes.askToRecover();
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.hosts.length === 2);
    await timers.advance(5_000);

    // Then
    expect(fakes.readLastStatus()).toBe('connected');
    expect(fakes.connections).toHaveLength(2);
  });

  it('As a dApp user whose product reloaded its frame, I get the frame told that the host accepted its ask', async () => {
    // Given a settled subdomain product
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('accepted'), 0);

    // When its frame asks to recover
    fakes.askToRecover();

    // Then the frame is told, at the origin the ask came from, before any core connection is answered
    const { iframe, options } = nth(fakes.hosts, 0);
    expect(readFramePosts(iframe)).toEqual([
      { message: { type: 'dotli:sandbox-recover-accepted' }, targetOrigin: options.allowedOrigin },
    ]);
  });

  it('As a dApp user whose reloaded frame cannot be told, I still get it rebuilt at its ask', async () => {
    // Given a settled subdomain product whose frame's posts throw
    const failure = new Error('The frame cannot be posted to');
    const heard: [unknown, SandboxMessageType][] = [];
    const fakes = createHarness({
      reportHandlerError: (error, type) => {
        heard.push([error, type]);
      },
    });
    await fakes.settle(buildSubdomainProduct('untold'), 0);
    breakFramePosts(nth(fakes.hosts, 0).iframe, failure);

    // When its frame asks to recover and the next connection is answered
    fakes.askToRecover();
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.hosts.length === 2);

    // Then the frame is rebuilt and the channel heard the post's error
    expect(fakes.hosts).toHaveLength(2);
    expect(heard).toEqual([[failure, 'dotli:sandbox-recover']]);
  });

  it('As a dApp user whose rebuilt sandbox reloads while an older ask still waits, I see the newer ask wait out the interval and rebuild the frame on screen', async () => {
    // Given a rebuild at the sandbox's ask whose new frame is still being built
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    await fakes.settle(buildSubdomainProduct('asking'), 0);
    const release = fakes.holdNextFrame();
    fakes.askToRecover();
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.countFramesAsked() === 2);

    // When the old frame asks again, then the new frame comes up and asks too, and the newer ask rebuilds it
    fakes.askToRecover();
    release();
    await fakes.changes.until(() => fakes.readLastStatus() === 'connected' && fakes.hosts.length === 2);
    fakes.askToRecover({ host: 1 });
    await timers.advance(5_000);
    await answerConnection(fakes, 2);
    await fakes.changes.until(() => fakes.hosts.length === 3 && fakes.readLastStatus() === 'connected');
    await timers.advance(10_000);

    // Then the newer ask rebuilt the frame on screen, and nothing else did
    expect(fakes.connections).toHaveLength(3);
  });

  it("As a dApp user, I keep my app open while a sandbox of another product asks to rebuild it and the app I'm on stays", async () => {
    // Given
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('mine'), 0);
    const other = new URL(nth(fakes.hosts, 0).options.allowedOrigin ?? '');
    other.hostname = 'other.app.localhost';

    // When
    fakes.askToRecover({ origin: other.origin, from: null });

    // Then
    expect(fakes.readLastStatus()).toBe('connected');
    expect(fakes.connections).toHaveLength(1);
  });

  it('As a dApp user, I keep my app open while a window of its origin that is not the frame on screen asks to rebuild it and the app stays', async () => {
    // Given another window on the product's origin, such as a frame the product nested in itself
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    await fakes.settle(buildSubdomainProduct('nested'), 0);
    const nested = {};

    // When
    fakes.askToRecover({ from: nested });
    await timers.advance(0);

    // Then
    expect(fakes.readLastStatus()).toBe('connected');
    expect(fakes.countFramesAsked()).toBe(1);
    expect(fakes.connections).toHaveLength(1);
    expect(readFramePosts(nth(fakes.hosts, 0).iframe)).toEqual([]);
  });

  it('As a dApp user whose rebuilt sandbox reloads again at once, I see it wait and rebuilt once the interval has passed', async () => {
    // Given a product rebuilt once at its sandbox's ask
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    await fakes.settle(buildSubdomainProduct('looping'), 0);
    fakes.askToRecover();
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.readLastStatus() === 'connected' && fakes.hosts.length === 2);

    // When the rebuilt sandbox asks again within the interval, then the interval passes
    fakes.askToRecover({ host: 1 });
    await timers.advance(0);
    const waiting = {
      status: fakes.readLastStatus(),
      connections: fakes.connections.length,
      pending: timers.countPending(),
    };
    await timers.advance(5_000);
    await answerConnection(fakes, 2);
    await fakes.changes.until(() => fakes.hosts.length === 3);

    // Then it waited on the interval, then it was rebuilt
    expect(waiting).toEqual({ status: 'connected', connections: 2, pending: 1 });
    expect(fakes.hosts).toHaveLength(3);
  });

  it('As a dApp user whose sandbox keeps asking to be rebuilt while each rebuild fails, I see one more rebuild wait and the rest dropped', async () => {
    // Given a product whose rebuilds fail
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    await fakes.settle(buildSubdomainProduct('failing'), 0);
    fakes.failFrames(new Error('Failed to fetch dynamically imported module'));

    // When its sandbox asks four times while the first rebuild runs
    for (let ask = 0; ask < 4; ask += 1) {
      fakes.askToRecover();
    }
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.readLastStatus() === 'failed');
    await timers.advance(5_000);
    await answerConnection(fakes, 2);
    await fakes.changes.until(() => fakes.countFramesAsked() === 3);
    await timers.advance(10_000);

    // Then
    expect(fakes.connections).toHaveLength(3);
    expect(fakes.listStatuses()).toEqual(['connecting', 'connected', 'connecting', 'failed', 'connecting', 'failed']);
  });

  it('As a user, I change a device permission in the menu and the app is rebuilt in a new frame', async () => {
    // Given
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('camera-menu'), 0);

    // When
    fakes.announce({ label: 'camera-menu', permissions: ['Camera'] });
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.hosts.length === 2 && (fakes.hosts[0]?.dispose.mock.calls.length ?? 0) > 0);

    // Then
    expect(fakes.hosts).toHaveLength(2);
    expect(nth(fakes.hosts, 0).dispose).toHaveBeenCalled();
  });

  it('As a user, I change a permission that no frame policy covers and the app keeps its frame', async () => {
    // Given
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('notifications'), 0);

    // When
    fakes.announce({ label: 'notifications', permissions: ['Notifications'], allowChanged: false });

    // Then
    expect(fakes.readLastStatus()).toBe('connected');
    expect(fakes.connections).toHaveLength(1);
  });

  it("As a user, I grant a device permission in the app's own prompt and the app is rebuilt only once my answer has reached it", async () => {
    // Given a product whose frame is piped to a core the test speaks for
    const fakes = createHarness();
    const port = new MessageChannel();
    onTestFinished(() => {
      port.port2.close();
    });
    const toProduct: unknown[] = [];
    port.port2.onmessage = event => {
      toProduct.push(event.data);
      fakes.changes.notify();
    };
    const rendered = fakes.frame.render(buildSubdomainProduct('prompted'));
    const core = await answerConnection(fakes, 0);
    await rendered;
    nth(fakes.hosts, 0).options.onPort(port.port1);
    const answer = encodeResponseFrame({
      requestId: 'camera-prompt',
      method: PERMISSIONS_REQUEST_DEVICE_PERMISSION,
      value: new Uint8Array(),
    });

    // When the user grants the camera, other core traffic reaches the product first, and then the answer
    fakes.announce({ label: 'prompted', permissions: ['Camera'], fromPrompt: true });
    core.listener?.(buildLoginResponseFrame('unrelated', { kind: 'success', value: 'Success' }));
    await fakes.changes.until(() => toProduct.length === 1);
    const connectionsBeforeAnswer = fakes.connections.length;
    core.listener?.(answer);
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => (fakes.hosts[0]?.dispose.mock.calls.length ?? 0) > 0 && toProduct.length === 2);

    // Then nothing was rebuilt before the answer, and the app is rebuilt in a new frame after it
    expect(connectionsBeforeAnswer).toBe(1);
    expect(nth(fakes.hosts, 0).dispose).toHaveBeenCalled();
    expect(toProduct).toHaveLength(2);
  });
});

describe('product frame and a device grant during a rebuild', () => {
  it("As a user, I grant a device permission in the app's own prompt while its frame is rebuilt and the new frame gets the grant", async () => {
    // Given a product whose frame is being rebuilt, past the point where the new frame read its policy
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('regrant'), 0);
    const release = fakes.holdNextFrame();
    fakes.announce({ label: 'regrant', permissions: ['Microphone'] });
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.countFramesAsked() === 2);

    // When the user grants the camera in the app's own prompt
    fakes.announce({ label: 'regrant', permissions: ['Camera'], fromPrompt: true });
    release();
    await answerConnection(fakes, 2);
    await fakes.changes.until(() => fakes.readLastStatus() === 'connected' && fakes.countFramesAsked() === 3);

    // Then the frame is built once more, so its policy is read after the grant
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.listOnScreen()[0]).toBe(fakes.hosts.at(-1));
    expect(fakes.hosts[1]?.dispose).toHaveBeenCalled();
  });

  it("As a user, I grant a device permission for another app while this app's frame is rebuilt and this frame is left alone", async () => {
    // Given a product whose frame is being rebuilt
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('mine'), 0);
    const release = fakes.holdNextFrame();
    fakes.announce({ label: 'mine', permissions: ['Microphone'] });
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.countFramesAsked() === 2);

    // When a prompt grant arrives for another product
    fakes.announce({ label: 'other', permissions: ['Camera'], fromPrompt: true });
    release();
    await fakes.changes.until(() => fakes.readLastStatus() === 'connected');

    // Then no further frame is asked for
    expect(fakes.countFramesAsked()).toBe(2);
  });
});

describe('product frame and the topbar login', () => {
  it('As a user, I log in before the product has loaded and the product joins the core my login runs on, with my pairing surviving its render', async () => {
    // Given a product page whose topbar login is pairing
    const fakes = createFakePageCore();
    fakes.core.setProduct({ label: 'product' });
    void createTopbarLogin({ fakes })();
    const sent: { requestId?: string } = {};
    const pairing = await answerConnection(fakes, 0, {
      provider: createFakeProvider({
        onPostMessage(message) {
          sent.requestId = getFrameRequestId(message);
        },
      }),
    });
    await fakes.changes.until(() => sent.requestId !== undefined);
    const shell = createHarness({ fakes });

    // When the product renders mid-pairing, then the wallet completes pairing
    await shell.settle(buildIframeProduct('product'), 1);
    const onRender = { cores: fakes.runtimes.length, pairingClosed: pairing.dispose.mock.calls.length };
    pairing.listener?.(buildLoginResponseFrame(sent.requestId ?? '', { kind: 'success', value: 'Success' }));
    await fakes.changes.until(() => pairing.dispose.mock.calls.length === 1);

    // Then one core served both with the pairing's connection open, then the login's connection closed and the product
    // keeps the core
    expect(onRender).toEqual({ cores: 1, pairingClosed: 0 });
    expect(pairing.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).not.toHaveBeenCalled();
  });

  it('As a user, I log in while the core is still starting and the product render does not cancel my login', async () => {
    // Given a topbar login waiting for its connection to the core
    const fakes = createFakePageCore();
    fakes.core.setProduct({ label: 'product' });
    void createTopbarLogin({ fakes })();
    await fakes.changes.until(() => fakes.connections.length === 1);
    const shell = createHarness({ fakes });

    // When the product renders before that connection is open
    await shell.settle(buildIframeProduct('product'), 1);
    const pairing = await answerConnection(fakes, 0);
    await fakes.changes.until(() => pairing.postMessage.mock.calls.length === 1);

    // Then the login still goes out, on the same core
    expect(pairing.postMessage).toHaveBeenCalledTimes(1);
    expect(pairing.dispose).not.toHaveBeenCalled();
    expect(fakes.runtimes).toHaveLength(1);
  });
});

describe('product frame and the page core', () => {
  it('As a dApp user whose core goes down under my product, I keep it open and it is rendered again on the replacement core', async () => {
    // Given
    const fakes = createHarness();
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const dead = await answerConnection(fakes, 0);
    await rendered;

    // When
    dead.closeListener?.(new Error('worker fatal error: boom'));
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.readLastStatus() === 'connected');

    // Then the old frame and its dead core go once the new frame is up
    expect(fakes.listStatuses()).toEqual(['connecting', 'connected', 'lost', 'connecting', 'connected']);
    expect(fakes.runtimes).toHaveLength(2);
    expect(nth(fakes.hosts, 0).dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.listOnScreen()).toHaveLength(1);
  });

  it('As an operator, I watch a rebuild that a newer render took over and see it counted as aborted with its reason', async () => {
    // Given a rebuild at the sandbox's ask, still connecting
    const fakes = createHarness();
    const { counted } = bindReports({ onReport: fakes.changes.notify });
    await fakes.settle(buildSubdomainProduct('rebuilt'), 0);
    fakes.askToRecover();
    await fakes.changes.until(() => fakes.connections.length === 2);

    // When the shell renders another product
    const next = fakes.frame.render(buildSubdomainProduct('next'));
    await answerConnection(fakes, 2);
    await next;
    await fakes.changes.until(() => counted('product.rerender').length === 1);

    // Then
    expect(counted('product.rerender')).toEqual([{ outcome: 'aborted', reason: 'recover' }]);
  });

  it('As a dApp user whose replacement core cannot boot, I see the frame report failed and stop there, with my product on screen and its dead core let go', async () => {
    // Given
    const fakes = createHarness();
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const dead = await answerConnection(fakes, 0);
    await rendered;
    fakes.nextBoots.push(() => new Error('worker fatal error: redial'));

    // When
    dead.closeListener?.(new Error('worker fatal error: boom'));
    await fakes.changes.until(() => fakes.readLastStatus() === 'failed');

    // Then
    expect(fakes.listStatuses()).toEqual(['connecting', 'connected', 'lost', 'connecting', 'failed']);
    expect(fakes.connections).toHaveLength(1);
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('As an operator, I watch a replacement core that cannot boot and see it reported once, as the redial', async () => {
    // Given
    const fakes = createHarness();
    const { captures, counted } = bindReports({ onReport: fakes.changes.notify });
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const dead = await answerConnection(fakes, 0);
    await rendered;
    fakes.nextBoots.push(() => new Error('worker fatal error: redial'));

    // When
    dead.closeListener?.(new Error('worker fatal error: boom'));
    await fakes.changes.until(() => counted('product.rerender').length === 1);

    // Then
    expect(counted('product.rerender')).toEqual([{ outcome: 'error', reason: 'replacement' }]);
    expect(captures.exception.mock.calls.map(([, context]) => context.step)).toEqual(['core_redial']);
  });

  it('As a dApp user, I name another product after a redial failed and the new product is not reported lost', async () => {
    // Given a redial that faulted and was dropped by the page naming another product
    const fakes = createHarness();
    const rendered = fakes.frame.render(buildSubdomainProduct('first'));
    const dead = await answerConnection(fakes, 0);
    await rendered;
    fakes.nextBoots.push(() => new Error('worker fatal error: redial'));
    dead.closeListener?.(new Error('worker fatal error: boom'));
    await fakes.changes.until(() => fakes.readLastStatus() === 'failed');
    fakes.core.setProduct({ label: 'second' });

    // When
    await fakes.settle(buildSubdomainProduct('second'), 1);

    // Then
    expect(fakes.readLastStatus()).toBe('connected');
    expect(fakes.listStatuses()).toEqual([
      'connecting',
      'connected',
      'lost',
      'connecting',
      'failed',
      'connecting',
      'connected',
    ]);
  });

  it('As a dApp user whose core goes down while my product is still being shown, I keep it open and it is rendered again on the replacement core', async () => {
    // Given a render whose connection is open and whose frame is still being built
    const fakes = createHarness();
    const release = fakes.holdNextFrame();
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const dead = await answerConnection(fakes, 0);
    await fakes.changes.until(() => fakes.countFramesAsked() === 1);

    // When the core goes down before the frame is up
    dead.closeListener?.(new Error('worker fatal error: boom'));
    release();
    await rendered;
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.readLastStatus() === 'connected');

    // Then the product ends connected on the replacement core
    expect(fakes.listStatuses()).toEqual(['connecting', 'lost', 'connecting', 'connected']);
    expect(fakes.runtimes).toHaveLength(2);
    expect(nth(fakes.runtimes, 1).createProvider).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.listOnScreen()[0]).toBe(nth(fakes.hosts, 1));
  });

  it('As a local wallet user whose pairing core turned stale under my product, I keep it open and it is rendered again on my local core', async () => {
    // Given a product on a pairing core
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('product'), 0);

    // When another tab's login brings the local wallet, so the pairing core turns stale
    fakes.findLocalWallet();
    await answerConnection(fakes, 1);
    await fakes.changes.until(
      () => fakes.readLastStatus() === 'connected' && (fakes.runtimes[0]?.dispose.mock.calls.length ?? 0) === 1,
    );

    // Then the product ends connected on the local core, and the stale core goes
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.listStatuses()).toEqual(['connecting', 'connected', 'lost', 'connecting', 'connected']);
    expect(fakes.runtimes).toHaveLength(2);
    expect(nth(fakes.runtimes, 1).createProvider).toHaveBeenCalledTimes(1);
    expect(fakes.listOnScreen()).toHaveLength(1);
  });

  it('As a dApp user, I keep my product open while a core dialed for another product cannot boot and my product stays connected', async () => {
    // Given
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('mine'), 0);
    fakes.nextBoots.push(() => new Error('worker fatal error: boot'));

    // When a login dials a core for another product and it cannot boot
    fakes.core.setProduct({ label: 'other' });
    const error = await catchRejection(fakes.core.acquire());

    // Then
    expect(error.message).toContain('boot');
    expect(fakes.readLastStatus()).toBe('connected');
    expect(fakes.listStatuses()).toEqual(['connecting', 'connected']);
  });

  it('As a dApp user whose core refuses another connection, I keep my product open and it is rendered again on the replacement core', async () => {
    // Given a product on screen and a second connection asked of its core
    const fakes = createHarness();
    await fakes.settle(buildSubdomainProduct('product'), 0);
    const other = await fakes.core.acquire();
    const refused = other.connect();
    await fakes.changes.until(() => fakes.connections.length === 2);

    // When the core refuses it
    nth(fakes.connections, 1).reject(new Error('runtime disposed'));
    const error = await catchRejection(refused);
    other.release();
    await answerConnection(fakes, 2);
    await fakes.changes.until(() => fakes.readLastStatus() === 'connected');

    // Then
    expect(error.message).toContain('runtime disposed');
    expect(fakes.listStatuses()).toEqual(['connecting', 'connected', 'lost', 'connecting', 'connected']);
    expect(fakes.runtimes).toHaveLength(2);
    expect(nth(fakes.runtimes, 1).createProvider).toHaveBeenCalledTimes(1);
  });

  it('As a dApp user whose core dies under every render, I see the product rendered again at most once per interval and then reported failed', async () => {
    // Given a product on screen, rendered again once on a replacement after its core died
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const first = await answerConnection(fakes, 0);
    await rendered;
    crash(first);
    const second = await fakes.reconnect(1);

    // When the replacement dies soon after too, then the interval passes and the third core dies as well
    crash(second);
    await timers.advance(4_000);
    const withinInterval = { status: fakes.readLastStatus(), connections: fakes.connections.length };
    await timers.advance(1_000);
    crash(await fakes.reconnect(2));
    await timers.advance(60_000);

    // Then the next render waited out the interval, and the frame gave up and reports failed
    expect(withinInterval).toEqual({ status: 'lost', connections: 2 });
    expect(fakes.readLastStatus()).toBe('failed');
    expect(fakes.connections).toHaveLength(3);
    expect(fakes.listStatuses()).toEqual([
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
  });

  it('As a dApp user whose cores keep dying, I see the frame that gives up keep my product on screen and let its core go', async () => {
    // Given a product whose core died twice and was rendered again each time
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const first = await answerConnection(fakes, 0);
    await rendered;
    crash(first);
    const second = await fakes.reconnect(1);
    crash(second);
    await timers.advance(5_000);
    const third = await fakes.reconnect(2);

    // When the third core dies as well
    crash(third);
    await timers.advance(60_000);

    // Then the frame reports failed, the product stays, and the dead core goes with its last lease
    expect(fakes.readLastStatus()).toBe('failed');
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.runtimes[2]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("As a dApp user whose frame gave up on its cores, I grant a device permission in the app's own prompt and the app is rebuilt", async () => {
    // Given a product left on screen by a frame that gave up on its dying cores
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const first = await answerConnection(fakes, 0);
    await rendered;
    crash(first);
    const second = await fakes.reconnect(1);
    crash(second);
    await timers.advance(5_000);
    crash(await fakes.reconnect(2));
    await timers.advance(60_000);
    const statusBeforeGrant = fakes.readLastStatus();
    const pendingBeforeGrant = timers.countPending();

    // When the user grants the camera in the app's prompt, whose answer can no longer reach the product
    fakes.announce({ label: 'product', permissions: ['Camera'], fromPrompt: true });
    const pendingAfterGrant = timers.countPending();
    await timers.advance(3_000);
    await fakes.reconnect(3);

    // Then the wait for the answer ran on the frame's timers, the app is rebuilt in a new frame once it is over, and the
    // frame it replaced goes alone
    expect(statusBeforeGrant).toBe('failed');
    expect(pendingAfterGrant).toBe(pendingBeforeGrant + 1);
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.listOnScreen()[0]).toBe(fakes.hosts.at(-1));
    expect(nth(fakes.hosts, 2).dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[2]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('As a dApp user whose core outlives the window before it dies, I keep my product open and it is rendered again with a fresh budget', async () => {
    // Given a product whose core died twice in quick succession
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const first = await answerConnection(fakes, 0);
    await rendered;
    crash(first);
    const second = await fakes.reconnect(1);
    await timers.advance(5_000);
    crash(second);
    const third = await fakes.reconnect(2);

    // When the third core stays up past the window, then dies, and its replacement dies soon after
    await timers.advance(61_000);
    crash(third);
    const fourth = await fakes.reconnect(3);
    crash(fourth);
    await timers.advance(5_000);
    await fakes.reconnect(4);

    // Then the product is back on screen
    expect(fakes.readLastStatus()).toBe('connected');
    expect(fakes.listStatuses()).not.toContain('failed');
    expect(fakes.connections).toHaveLength(5);
  });

  it('As a dApp user whose product is loaded afresh after its cores died twice, I keep it open and it is rendered again with a fresh budget', async () => {
    // Given a product whose core died twice in quick succession
    const timers = createManualTimers();
    const fakes = createHarness({ timers });
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const first = await answerConnection(fakes, 0);
    await rendered;
    crash(first);
    const second = await fakes.reconnect(1);
    await timers.advance(5_000);
    crash(second);
    await fakes.reconnect(2);

    // When the loader renders the product afresh, and its core dies twice soon after
    const fresh = fakes.frame.render(buildSubdomainProduct('product', { cid: 'fresh-cid' }));
    const fourth = await answerConnection(fakes, 3);
    await fresh;
    await timers.advance(5_000);
    crash(fourth);
    const fifth = await fakes.reconnect(4);
    crash(fifth);
    await timers.advance(5_000);
    await fakes.reconnect(5);

    // Then the product is back on screen
    expect(fakes.readLastStatus()).toBe('connected');
    expect(fakes.listStatuses()).not.toContain('failed');
    expect(fakes.listOnScreen()[0]?.options.iframeUrl).toContain('cid=fresh-cid');
  });

  it('As a dApp user whose core dies while a newer render connects to it, I keep my product open and that render is shown on the replacement core', async () => {
    // Given a product on screen and a newer render waiting for its connection on the same core
    const fakes = createHarness();
    const rendered = fakes.frame.render(buildSubdomainProduct('product', { cid: 'first-cid' }));
    const first = await answerConnection(fakes, 0);
    await rendered;
    const newer = fakes.frame.render(buildSubdomainProduct('product', { cid: 'second-cid' }));
    await fakes.changes.until(() => fakes.connections.length === 2);

    // When the core dies, and the connection the newer render asked for fails with it
    crash(first);
    nth(fakes.connections, 1).reject(new Error('runtime disposed'));
    await answerConnection(fakes, 2);
    await newer;

    // Then the newer render is on screen, connected to the replacement core
    expect(fakes.readLastStatus()).toBe('connected');
    expect(fakes.runtimes).toHaveLength(2);
    expect(nth(fakes.runtimes, 1).createProvider).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.listOnScreen()[0]?.options.iframeUrl).toContain('cid=second-cid');
  });

  it('As a dApp user whose app could not be rebuilt after a permission change, I keep it open when its core goes down and it is rendered again on the replacement core', async () => {
    // Given a product whose rebuild after a device permission change failed, on screen on its first core
    const fakes = createHarness();
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const first = await answerConnection(fakes, 0);
    await rendered;
    fakes.failFrames(new Error('frame chunk failed'));
    fakes.announce({ label: 'product', permissions: ['Camera'] });
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.readLastStatus() === 'failed');
    fakes.failFrames(null);

    // When its core goes down
    crash(first);
    await fakes.reconnect(2);

    // Then it is rendered again on the replacement and the old frame and its dead core go
    expect(fakes.listStatuses()).toEqual([
      'connecting',
      'connected',
      'connecting',
      'failed',
      'lost',
      'connecting',
      'connected',
    ]);
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(nth(fakes.hosts, 0).dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('As a dApp user who changes a device permission while my app waits for a replacement core that cannot boot, I keep my app on screen and the page lets go of its dead core', async () => {
    // Given a product whose core went down, with the redial held and set to fail
    const fakes = createHarness();
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const dead = await answerConnection(fakes, 0);
    await rendered;
    fakes.holdBoots();
    fakes.nextBoots.push(() => new Error('worker fatal error: redial'));
    crash(dead);
    await fakes.changes.until(() => fakes.heldBoots.length === 1);

    // When a permission change starts a newer render, and the redial fails under it
    fakes.announce({ label: 'product', permissions: ['Camera'] });
    fakes.heldBoots[0]?.resolve(undefined);
    await fakes.changes.until(() => fakes.readLastStatus() === 'failed');

    // Then the product stays and the dead core goes with its last lease
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('As a dApp user whose core goes down while my app is rebuilt after a permission change and the rebuild fails, I keep my app on screen and the page lets go of its dead core', async () => {
    // Given a product on screen whose rebuild after a device permission change has connected and waits for its frame
    const fakes = createHarness();
    const rendered = fakes.frame.render(buildSubdomainProduct('product'));
    const first = await answerConnection(fakes, 0);
    await rendered;
    const releaseFrame = fakes.holdNextFrame();
    fakes.announce({ label: 'product', permissions: ['Camera'] });
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => fakes.countFramesAsked() === 2);

    // When its core goes down and the rebuild's frame then fails
    crash(first);
    releaseFrame(new Error('frame chunk failed'));
    await fakes.changes.until(() => fakes.readLastStatus() === 'failed');

    // Then the product stays and the dead core goes with its last lease
    expect(fakes.listStatuses()).toEqual(['connecting', 'connected', 'connecting', 'failed']);
    expect(fakes.listOnScreen()).toHaveLength(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
  });
});
