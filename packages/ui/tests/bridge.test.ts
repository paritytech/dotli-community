// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
// The product and protocol frames are never navigated in these tests, and
// happy-dom would otherwise try to fetch their pages from a dev server.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  type WireProvider,
  MESSAGE_TYPE_RESPONSE,
  VersionedHostRequestLoginError,
  VersionedHostRequestLoginResponse,
  decodeWireMessage,
  encodeWireMessage,
  scale,
} from '@parity/truapi';
import { ACCOUNT_REQUEST_LOGIN } from '@parity/truapi/wire-table';
import { nth } from './helpers/nth.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface MockProvider {
  postMessage: Mock<WireProvider['postMessage']>;
  subscribe: Mock<WireProvider['subscribe']>;
  subscribeClose: Mock<NonNullable<WireProvider['subscribeClose']>>;
  disconnectSession: ReturnType<typeof vi.fn>;
  getPermissionAuthorizationStatus: ReturnType<typeof vi.fn>;
  getPermissionAuthorizationStatuses: ReturnType<typeof vi.fn>;
  setPermissionAuthorizationStatus: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  dispose: Mock<WireProvider['dispose']>;
}

interface MockRuntime {
  createProvider: ReturnType<typeof vi.fn>;
  cancelPairing: ReturnType<typeof vi.fn>;
  disconnectSession: ReturnType<typeof vi.fn>;
  notifySessionStoreChanged: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

type ProviderListener = (message: Uint8Array) => void;
type ProviderCloseListener = (error: Error) => void;

// Window listeners the bridge under test added; removed after each test so an
// earlier test's bridge never reacts to a later test's events.
let bridgeListeners: Parameters<typeof window.removeEventListener>[] = [];

afterEach(() => {
  for (const [type, listener] of bridgeListeners) {
    window.removeEventListener(type, listener);
  }
  bridgeListeners = [];
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  coreProviders: [] as MockProvider[],
  coreProviderDefers: [] as Deferred<MockProvider>[],
  coreRuntimes: [] as MockRuntime[],
  iframeHosts: [] as {
    iframeUrl: string;
    allowedOrigin: string;
    iframe: HTMLIFrameElement;
    dispose: ReturnType<typeof vi.fn>;
  }[],
  createWebWorkerPairingHostRuntime: vi.fn(),
  createWebWorkerSigningHostRuntime: vi.fn(),
  createIframeHost: vi.fn(),
  createWasmRawCallbacks: vi.fn((callbacks: unknown) => callbacks),
  timerStop: vi.fn(),
  HostWorker: vi.fn(),
}));

vi.mock('@dotli/config', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DEBUG: false,
}));

vi.mock('@parity/truapi-host', () => ({
  createWasmRawCallbacks: mocks.createWasmRawCallbacks,
}));

vi.mock('@parity/truapi-host/web', () => ({
  createWebWorkerPairingHostRuntime: mocks.createWebWorkerPairingHostRuntime,
  createWebWorkerSigningHostRuntime: mocks.createWebWorkerSigningHostRuntime,
  createIframeHost: mocks.createIframeHost,
}));

vi.mock('@parity/truapi-host/worker-runtime?worker', () => ({
  default: mocks.HostWorker,
}));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), recordExpected: vi.fn() }));
vi.mock('../../metrics/src/sentry.js', () => sentry);

vi.mock('../../metrics/src/metrics.js', () => ({
  m: {
    measure: vi.fn(),
    timer: vi.fn(() => mocks.timerStop),
  },
  getResolutionId: vi.fn(() => null),
}));

function makeProvider(): MockProvider {
  const provider = {
    postMessage: vi.fn<WireProvider['postMessage']>(),
    subscribe: vi.fn<WireProvider['subscribe']>(() => () => {}),
    subscribeClose: vi.fn<NonNullable<WireProvider['subscribeClose']>>(() => () => {}),
    disconnectSession: vi.fn(async () => {}),
    getPermissionAuthorizationStatus: vi.fn(() => Promise.resolve('NotDetermined')),
    getPermissionAuthorizationStatuses: vi.fn((requests: unknown[]) =>
      Promise.resolve(requests.map(() => 'NotDetermined')),
    ),
    setPermissionAuthorizationStatus: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    dispose: vi.fn<WireProvider['dispose']>(),
  };
  mocks.coreProviders.push(provider);
  return provider;
}

function makeLoginProvider(options: { onPostMessage?: (message: Uint8Array) => void }): MockProvider & {
  listener: ProviderListener | null;
  closeListener: ProviderCloseListener | null;
} {
  const provider = {
    listener: null as ProviderListener | null,
    closeListener: null as ProviderCloseListener | null,
    postMessage: vi.fn((message: Uint8Array) => {
      options.onPostMessage?.(message);
    }),
    subscribe: vi.fn((callback: ProviderListener) => {
      provider.listener = callback;
      return () => {
        provider.listener = null;
      };
    }),
    subscribeClose: vi.fn((callback: ProviderCloseListener) => {
      provider.closeListener = callback;
      return () => {
        provider.closeListener = null;
      };
    }),
    disconnectSession: vi.fn(async () => {}),
    getPermissionAuthorizationStatus: vi.fn(() => Promise.resolve('NotDetermined')),
    getPermissionAuthorizationStatuses: vi.fn((requests: unknown[]) =>
      Promise.resolve(requests.map(() => 'NotDetermined')),
    ),
    setPermissionAuthorizationStatus: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    dispose: vi.fn<WireProvider['dispose']>(),
  };
  return provider;
}

function makeRuntime(): MockRuntime {
  const runtime = {
    createProvider: vi.fn(() => {
      const item = deferred<MockProvider>();
      mocks.coreProviderDefers.push(item);
      return item.promise;
    }),
    cancelPairing: vi.fn(),
    disconnectSession: vi.fn(async () => {}),
    notifySessionStoreChanged: vi.fn(),
    dispose: vi.fn(),
  };
  mocks.coreRuntimes.push(runtime);
  return runtime;
}

function loginResponseFrame(
  requestId: string,
  result:
    | { success: true; value: 'Success' | 'AlreadyConnected' | 'Rejected' }
    | { success: false; reason: string }
    | { success: false; hostFailure: string }
    | { success: false; cancelled: true },
): Uint8Array {
  // Codec 2 legs carry Result outside and the version wrapper inside.
  const responseCodec = scale.Result(
    VersionedHostRequestLoginResponse,
    scale.CallError(VersionedHostRequestLoginError),
  );
  const value = responseCodec.enc(
    result.success
      ? { success: true, value: { tag: 'V1', value: result.value } }
      : 'cancelled' in result
        ? { success: false, value: { tag: 'Cancelled' } }
        : 'hostFailure' in result
          ? {
              success: false,
              value: {
                tag: 'HostFailure',
                value: { reason: result.hostFailure },
              },
            }
          : {
              success: false,
              value: {
                tag: 'Domain',
                value: {
                  tag: 'V1',
                  value: {
                    tag: 'Unknown',
                    value: { reason: result.reason },
                  },
                },
              },
            },
  );
  const frame = encodeWireMessage({
    requestId,
    payload: {
      traitId: ACCOUNT_REQUEST_LOGIN.trait,
      methodId: ACCOUNT_REQUEST_LOGIN.method,
      messageType: MESSAGE_TYPE_RESPONSE,
      value,
    },
  });
  if (frame.isErr()) {
    throw frame.error;
  }
  return frame.value;
}

function requestIdFromFrame(message: Uint8Array): string {
  const decoded = decodeWireMessage(message);
  if (decoded.isErr()) {
    throw decoded.error;
  }
  return decoded.value.requestId;
}

async function waitForProviderRequests(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(mocks.coreProviderDefers.length).toBeGreaterThanOrEqual(count);
  });
}

describe('bridge render lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.coreProviders.length = 0;
    mocks.coreProviderDefers.length = 0;
    mocks.coreRuntimes.length = 0;
    mocks.iframeHosts.length = 0;
    localStorage.clear();
    document.body.innerHTML = `<div id="app"></div>`;
    window.history.replaceState(null, '', '/');
    mocks.createWebWorkerPairingHostRuntime.mockImplementation(() => Promise.resolve(makeRuntime()));
    mocks.createIframeHost.mockImplementation(
      (args: { iframeUrl: string; allowedOrigin: string; container: HTMLElement }) => {
        const iframe = document.createElement('iframe');
        iframe.dataset['src'] = args.iframeUrl;
        args.container.appendChild(iframe);
        const dispose = vi.fn(() => {
          iframe.remove();
        });
        const host = {
          iframeUrl: args.iframeUrl,
          allowedOrigin: args.allowedOrigin,
          iframe,
          dispose,
        };
        mocks.iframeHosts.push(host);
        return { iframe, dispose };
      },
    );
    const [{ initBridgeEventListeners }, { createBlockingModalCoordinator }] = await Promise.all([
      import('../src/bridge.js'),
      import('../src/blocking-modal-queue.js'),
    ]);
    const spy = vi.spyOn(window, 'addEventListener');
    initBridgeEventListeners(createBlockingModalCoordinator());
    bridgeListeners = spy.mock.calls.map(([type, listener]) => [type, listener]);
    spy.mockRestore();
  });

  it('does not enable experimental custody through stored state or a debug URL in production', async () => {
    localStorage.setItem('dotli:local-wallet-enabled', '1');
    window.history.replaceState(null, '', '/?debug=true');
    const { experimentalWalletControls } = await import('../src/bridge.js');
    expect(experimentalWalletControls.isActive()).toBe(false);
    await expect(experimentalWalletControls.activate()).rejects.toThrow();
    await expect(experimentalWalletControls.disconnect()).rejects.toThrow();
    await expect(experimentalWalletControls.deleteWallet()).rejects.toThrow();
    await expect(experimentalWalletControls.exportMnemonic()).rejects.toThrow();
    await expect(experimentalWalletControls.importMnemonic('abandon '.repeat(11) + 'about')).rejects.toThrow();
    expect(localStorage.getItem('dotli:local-wallet-enabled')).toBe('1');
  });

  it('As a dotli integrator, the host disposes a host that resolves after a newer render has started', async () => {
    // Given
    const { renderIframe } = await import('../src/bridge.js');

    // When
    const first = renderIframe('https://first.example/app', 'first');
    await waitForProviderRequests(1);
    const second = renderIframe('https://second.example/app', 'second');
    await waitForProviderRequests(2);

    const secondProvider = makeProvider();
    nth(mocks.coreProviderDefers, 1).resolve(secondProvider);
    await second;

    // Then
    expect(document.querySelector('iframe')?.dataset['src']).toBe('https://second.example/app');

    // When
    const firstProvider = makeProvider();
    nth(mocks.coreProviderDefers, 0).resolve(firstProvider);
    await first;

    // Then
    expect(mocks.iframeHosts).toHaveLength(2);
    const firstHost = mocks.iframeHosts.find(host => host.iframeUrl === 'https://first.example/app');
    expect(firstHost?.dispose).toHaveBeenCalledTimes(1);
    expect(firstProvider.dispose).toHaveBeenCalledTimes(1);
    expect(secondProvider.dispose).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')?.dataset['src']).toBe('https://second.example/app');
  }, 10_000);

  it('As a dotli integrator, the host keeps the previous iframe visible while its replacement initializes', async () => {
    // Given
    const { renderIframe } = await import('../src/bridge.js');

    const first = renderIframe('https://first.example/app', 'first');
    await waitForProviderRequests(1);
    nth(mocks.coreProviderDefers, 0).resolve(makeProvider());
    await first;

    const firstHost = nth(mocks.iframeHosts, 0);
    const second = renderIframe('https://second.example/app', 'second');
    await waitForProviderRequests(2);

    // Then
    expect(firstHost.iframe.isConnected).toBe(true);
    expect(firstHost.dispose).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')?.dataset['src']).toBe('https://first.example/app');

    // When
    nth(mocks.coreProviderDefers, 1).resolve(makeProvider());
    await second;

    // Then
    expect(firstHost.dispose).toHaveBeenCalledTimes(1);
    const app = document.getElementById('app');
    expect(app?.querySelectorAll('iframe')).toHaveLength(1);
    expect(app?.querySelector('iframe')?.dataset['src']).toBe('https://second.example/app');
  }, 10_000);

  it('As a dotli integrator, the host keeps the previous app-subdomain iframe visible while its replacement initializes', async () => {
    // Given
    const { renderAppSubdomain } = await import('../src/bridge.js');

    const first = renderAppSubdomain('first-cid', 'first');
    await waitForProviderRequests(1);
    nth(mocks.coreProviderDefers, 0).resolve(makeProvider());
    await first;

    const firstHost = nth(mocks.iframeHosts, 0);
    const second = renderAppSubdomain('second-cid', 'first');
    await waitForProviderRequests(2);

    // Then
    expect(firstHost.iframe.isConnected).toBe(true);
    expect(firstHost.dispose).not.toHaveBeenCalled();

    // When
    nth(mocks.coreProviderDefers, 1).resolve(makeProvider());
    await second;

    // Then
    expect(firstHost.dispose).toHaveBeenCalledTimes(1);
    const app = document.getElementById('app');
    expect(app?.querySelectorAll('iframe')).toHaveLength(1);
    expect(app?.querySelector('iframe')?.dataset['src']).toContain('cid=second-cid');
  }, 10_000);

  it('As a dApp user, both render paths hand the product frame to the frame layout', async () => {
    // Given
    const [{ renderIframe, renderAppSubdomain }, layout] = await Promise.all([
      import('../src/bridge.js'),
      import('../src/product-frame-layout.js'),
    ]);
    const renders = [
      () => renderIframe('https://product.example/app', 'product'),
      () => renderAppSubdomain('cid', 'product'),
    ];

    for (const [index, render] of renders.entries()) {
      // When
      layout.setTopbarLayout({ offset: true });
      const rendered = render();
      await waitForProviderRequests(index + 1);
      nth(mocks.coreProviderDefers, index).resolve(makeProvider());
      await rendered;
      const { iframe } = nth(mocks.iframeHosts, index);

      // Then the frame is placed
      expect(iframe.style.position).toBe('fixed');

      // And later layout changes reach it
      layout.setTopbarLayout({ offset: false });
      expect(iframe.style.top).toBe('var(--safe-top, 0px)');
    }
  }, 10_000);

  it.each(['/x.dot@evil.com/pay', '/foo.dotify/pay'])(
    'As a user, the host keeps an adversarial deep path on the app sandbox origin: %s',
    async path => {
      // Given
      window.history.replaceState(null, '', path);
      const { renderAppSubdomain } = await import('../src/bridge.js');

      // When
      const render = renderAppSubdomain('cid', 'first');
      await waitForProviderRequests(1);
      nth(mocks.coreProviderDefers, 0).resolve(makeProvider());
      await render;

      // Then
      const created = nth(mocks.iframeHosts, 0);
      const iframeUrl = new URL(created.iframeUrl);
      expect(iframeUrl.hostname).toBe('first.app.localhost');
      expect(iframeUrl.pathname).toBe(path);
      expect(created.allowedOrigin).toBe(iframeUrl.origin);
    },
  );

  it('As a dotli integrator, the host cancels pairing on the active product host', async () => {
    // Given
    const { renderIframe } = await import('../src/bridge.js');

    const render = renderIframe('https://product.example/app', 'product');
    await waitForProviderRequests(1);
    nth(mocks.coreProviderDefers, 0).resolve(makeProvider());
    await render;

    // When
    window.dispatchEvent(new Event('dotli:truapi-cancel-login'));

    // Then
    await vi.waitFor(() => {
      expect(mocks.coreRuntimes[0]?.cancelPairing).toHaveBeenCalledTimes(1);
    });
  });

  it('As a user who logs in before the product has loaded, the product joins the core my login runs on and my pairing survives its render', async () => {
    // Given: a product page whose topbar login is pairing
    const { renderIframe, setPageProduct } = await import('../src/bridge.js');
    setPageProduct({ label: 'product' });
    window.dispatchEvent(new CustomEvent('dotli:truapi-login-request', { detail: {} }));
    await waitForProviderRequests(1);
    const sent: { requestId?: string } = {};
    const login = makeLoginProvider({
      onPostMessage(message) {
        sent.requestId = requestIdFromFrame(message);
      },
    });
    nth(mocks.coreProviderDefers, 0).resolve(login);
    await vi.waitFor(() => {
      expect(sent.requestId).toBeDefined();
    });

    // When: the product renders mid-pairing
    const render = renderIframe('https://product.example/app', 'product');
    await waitForProviderRequests(2);
    nth(mocks.coreProviderDefers, 1).resolve(makeProvider());
    await render;

    // Then: one core serves both, and the pairing's connection is still open
    expect(mocks.coreRuntimes).toHaveLength(1);
    expect(login.dispose).not.toHaveBeenCalled();

    // When: the wallet completes pairing
    login.listener?.(loginResponseFrame(sent.requestId ?? '', { success: true, value: 'Success' }));

    // Then: the login's connection closes, and the product keeps the core
    await vi.waitFor(() => {
      expect(login.dispose).toHaveBeenCalledTimes(1);
    });
    expect(mocks.coreRuntimes[0]?.dispose).not.toHaveBeenCalled();
  }, 10_000);

  it('As a user who logs in while the core is still starting, the product render does not cancel my login', async () => {
    // Given: a topbar login waiting for its connection to the core
    const { renderIframe, setPageProduct } = await import('../src/bridge.js');
    setPageProduct({ label: 'product' });
    window.dispatchEvent(new CustomEvent('dotli:truapi-login-request', { detail: {} }));
    await waitForProviderRequests(1);

    // When: the product renders before that connection is open
    const render = renderIframe('https://product.example/app', 'product');
    await waitForProviderRequests(2);
    nth(mocks.coreProviderDefers, 1).resolve(makeProvider());
    await render;
    const login = makeLoginProvider({});
    nth(mocks.coreProviderDefers, 0).resolve(login);

    // Then: the login still goes out, on the same core
    await vi.waitFor(() => {
      expect(login.postMessage).toHaveBeenCalledTimes(1);
    });
    expect(login.dispose).not.toHaveBeenCalled();
    expect(mocks.coreRuntimes).toHaveLength(1);
  }, 10_000);

  it('As a user on the landing page, the core goes once my login is done', async () => {
    // Given: a topbar login with no product on the page
    await import('../src/bridge.js');
    window.dispatchEvent(new CustomEvent('dotli:truapi-login-request', { detail: {} }));
    await waitForProviderRequests(1);
    const login = makeLoginProvider({
      onPostMessage(message) {
        login.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: true, value: 'Success' }));
      },
    });

    // When
    nth(mocks.coreProviderDefers, 0).resolve(login);

    // Then: nothing holds the core any more
    await vi.waitFor(() => {
      expect(mocks.coreRuntimes[0]?.dispose).toHaveBeenCalledTimes(1);
    });
  }, 10_000);

  it('As a user whose core went down, reloading the product boots a fresh core', async () => {
    // Given: a product whose core closed its connection unasked
    const { renderIframe } = await import('../src/bridge.js');
    const render = renderIframe('https://product.example/app', 'product');
    await waitForProviderRequests(1);
    const failed = makeLoginProvider({});
    nth(mocks.coreProviderDefers, 0).resolve(failed);
    await render;
    failed.closeListener?.(new Error('worker fatal error: boom'));

    // When: the product reloads
    const reload = renderIframe('https://product.example/app', 'product');
    await waitForProviderRequests(2);
    nth(mocks.coreProviderDefers, 1).resolve(makeProvider());
    await reload;

    // Then: the reload runs on a new core, and the dead one goes with its host
    await vi.waitFor(() => {
      expect(mocks.coreRuntimes).toHaveLength(2);
      expect(mocks.coreRuntimes[0]?.dispose).toHaveBeenCalledTimes(1);
    });
  }, 10_000);

  it('As an operator, a login that fails before the core answers is reported under the wallet flow', async () => {
    // Given: a topbar login whose core connection drops once the request is sent
    await import('../src/bridge.js');
    window.dispatchEvent(new CustomEvent('dotli:truapi-login-request', { detail: {} }));
    await waitForProviderRequests(1);
    const failure = new Error('worker fatal error: boom');
    const login = makeLoginProvider({
      onPostMessage() {
        login.closeListener?.(failure);
      },
    });

    // When
    nth(mocks.coreProviderDefers, 0).resolve(login);

    // Then
    await vi.waitFor(() => {
      expect(sentry.captureException).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'login' });
    });
    expect(sentry.recordExpected).not.toHaveBeenCalled();
  }, 10_000);

  it('As an operator, a login the user cancels leaves a breadcrumb, not an issue', async () => {
    // Given: a topbar login
    await import('../src/bridge.js');
    window.dispatchEvent(new CustomEvent('dotli:truapi-login-request', { detail: {} }));
    await waitForProviderRequests(1);
    const login = makeLoginProvider({
      onPostMessage(message) {
        login.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: false, cancelled: true }));
      },
    });

    // When: the user cancels it
    nth(mocks.coreProviderDefers, 0).resolve(login);

    // Then
    await vi.waitFor(() => {
      expect(sentry.recordExpected).toHaveBeenCalledWith(expect.objectContaining({ name: 'LoginRequestError' }), {
        flow: 'wallet',
        step: 'login',
      });
    });
    expect(sentry.captureException).not.toHaveBeenCalled();
  }, 10_000);

  it('As a dotli integrator, the host boots the page core to disconnect a stored session without a product', async () => {
    // Given
    await import('../src/bridge.js');

    // When
    window.dispatchEvent(new Event('dotli:truapi-disconnect-request'));

    // Then: the core disconnects, then goes with its only lease
    await vi.waitFor(() => {
      expect(mocks.coreRuntimes[0]?.disconnectSession).toHaveBeenCalledTimes(1);
      expect(mocks.coreRuntimes[0]?.dispose).toHaveBeenCalledTimes(1);
    });
  }, 10_000);
});

describe('bridge app roots', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.coreProviders.length = 0;
    mocks.coreProviderDefers.length = 0;
    mocks.coreRuntimes.length = 0;
    mocks.iframeHosts.length = 0;
    document.body.innerHTML = `<div id="app"><div data-testid="loading-stand-in"></div></div>`;
    window.history.replaceState(null, '', '/');
    mocks.createWebWorkerPairingHostRuntime.mockImplementation(() => Promise.resolve(makeRuntime()));
    mocks.createIframeHost.mockImplementation(
      (args: { iframeUrl: string; allowedOrigin: string; container: HTMLElement }) => {
        const iframe = document.createElement('iframe');
        iframe.dataset['src'] = args.iframeUrl;
        args.container.appendChild(iframe);
        const dispose = vi.fn(() => {
          iframe.remove();
        });
        mocks.iframeHosts.push({
          iframeUrl: args.iframeUrl,
          allowedOrigin: args.allowedOrigin,
          iframe,
          dispose,
        });
        return { iframe, dispose };
      },
    );
    const [{ initBridgeEventListeners }, { createBlockingModalCoordinator }] = await Promise.all([
      import('../src/bridge.js'),
      import('../src/blocking-modal-queue.js'),
    ]);
    const spy = vi.spyOn(window, 'addEventListener');
    initBridgeEventListeners(createBlockingModalCoordinator());
    bridgeListeners = spy.mock.calls.map(([type, listener]) => [type, listener]);
    spy.mockRestore();
  });

  /** Register both roots the way the shell does: disposing removes the node. */
  async function registerRoots(): Promise<{
    loading: HTMLElement;
    page: HTMLElement;
    disposeLoading: ReturnType<typeof vi.fn>;
    disposePage: ReturnType<typeof vi.fn>;
  }> {
    const { registerAppRoot } = await import('../src/mount/app-roots.js');
    const app = document.getElementById('app');
    const loading = app?.querySelector<HTMLElement>('[data-testid="loading-stand-in"]');
    if (app === null || loading === null || loading === undefined) {
      throw new Error('fixture has no loading stand-in in #app');
    }
    const page = document.createElement('div');
    page.id = 'app-view';
    app.appendChild(page);
    const disposeLoading = vi.fn(() => {
      loading.remove();
    });
    const disposePage = vi.fn(() => {
      page.remove();
    });
    registerAppRoot('loading', disposeLoading);
    registerAppRoot('page', disposePage);
    return { loading, page, disposeLoading, disposePage };
  }

  async function settle(render: Promise<void>, index: number): Promise<void> {
    await waitForProviderRequests(index + 1);
    nth(mocks.coreProviderDefers, index).resolve(makeProvider());
    await render;
  }

  it('As the shell, an app-subdomain render disposes the page root and keeps the loading overlay up', async () => {
    // Given
    const { renderAppSubdomain } = await import('../src/bridge.js');
    const { loading, page, disposeLoading, disposePage } = await registerRoots();

    // When
    await settle(renderAppSubdomain('cid', 'first'), 0);

    // Then
    expect(disposePage).toHaveBeenCalledTimes(1);
    expect(page.isConnected).toBe(false);
    expect(disposeLoading).not.toHaveBeenCalled();
    const app = document.getElementById('app');
    expect(loading.parentElement).toBe(app);
    expect(app?.querySelectorAll('iframe')).toHaveLength(1);
  }, 10_000);

  it('As the shell, a later app-subdomain render disposes a loading overlay the first one kept', async () => {
    // Given
    const { renderAppSubdomain } = await import('../src/bridge.js');
    const { loading, disposeLoading } = await registerRoots();
    await settle(renderAppSubdomain('first-cid', 'first'), 0);

    // When
    await settle(renderAppSubdomain('second-cid', 'first'), 1);

    // Then
    expect(disposeLoading).toHaveBeenCalledTimes(1);
    expect(loading.isConnected).toBe(false);
    const app = document.getElementById('app');
    expect(app?.children).toHaveLength(1);
    expect(app?.querySelector('iframe')?.dataset['src']).toContain('cid=second-cid');
  }, 10_000);

  it('As the shell, a direct iframe render disposes both the page and the loading roots', async () => {
    // Given
    const { renderIframe } = await import('../src/bridge.js');
    const { disposeLoading, disposePage } = await registerRoots();

    // When
    await settle(renderIframe('https://product.example/app', 'product'), 0);

    // Then
    expect(disposePage).toHaveBeenCalledTimes(1);
    expect(disposeLoading).toHaveBeenCalledTimes(1);
    // Page first, then loading.
    expect(disposePage.mock.invocationCallOrder[0]).toBeLessThan(nth(disposeLoading.mock.invocationCallOrder, 0));
    const app = document.getElementById('app');
    expect(app?.children).toHaveLength(1);
    expect(app?.firstElementChild?.tagName).toBe('IFRAME');
  }, 10_000);

  it('As a visitor on a preview or local target, the first iframe render takes the static screen down', async () => {
    // Given the static screen, with no phases started, and the loading
    // controller loaded over it as the host's startup bundle loads it
    document.body.innerHTML = `<div id="app-loading"></div><div id="app"></div>`;
    const [{ renderIframe }, loading] = await Promise.all([
      import('../src/bridge.js'),
      import('../src/state/loading.js'),
      import('../src/loading-controller.js'),
    ]);

    // When
    await settle(renderIframe('https://product.example/app', 'product'), 0);

    // Then
    expect(loading.getLoadingState().phase).toBe('gone');
  }, 10_000);

  it('As a dApp user, an error page shown over a live product is cleared when the product is rebuilt', async () => {
    // Given a product whose load failed after its frame went up
    const [{ renderAppSubdomain }, { showErrorPage }] = await Promise.all([
      import('../src/bridge.js'),
      import('../src/ui.js'),
    ]);
    await settle(renderAppSubdomain('cid', 'reloaded'), 0);
    showErrorPage({ title: 'Failed' });

    // When its sandbox asks to be rebuilt. The label is unique to this test,
    // so bridge instances left over from earlier tests ignore the request.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:sandbox-recover' },
        origin: nth(mocks.iframeHosts, 0).allowedOrigin,
      }),
    );
    await waitForProviderRequests(2);
    nth(mocks.coreProviderDefers, 1).resolve(makeProvider());
    await vi.waitFor(() => {
      expect(mocks.iframeHosts).toHaveLength(2);
      expect(mocks.iframeHosts[1]?.iframe.isConnected).toBe(true);
      expect(mocks.iframeHosts[0]?.dispose).toHaveBeenCalled();
    });

    // Then only the new frame is left
    const app = document.getElementById('app');
    expect(app?.children).toHaveLength(1);
    expect(app?.firstElementChild).toBe(nth(mocks.iframeHosts, 1).iframe);
  }, 10_000);
});

describe('requestCoreLogin', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = `<div id="app"></div>`;
  });

  it('As a dotli integrator, the host resolves successful login responses', async () => {
    // Given
    const { requestCoreLogin } = await import('../src/bridge.js');
    const provider = makeLoginProvider({
      onPostMessage(message) {
        provider.listener?.(
          loginResponseFrame(requestIdFromFrame(message), {
            success: true,
            value: 'Success',
          }),
        );
      },
    });

    // When
    const login = requestCoreLogin(provider);

    // Then
    await expect(login).resolves.toBe('Success');
    expect(provider.subscribe).toHaveBeenCalledTimes(1);
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, the host rejects typed login errors as LoginRequestError', async () => {
    // Given
    const { requestCoreLogin } = await import('../src/bridge.js');
    const provider = makeLoginProvider({
      onPostMessage(message) {
        provider.listener?.(
          loginResponseFrame(requestIdFromFrame(message), {
            success: false,
            reason: 'Rejected',
          }),
        );
      },
    });

    // When
    const promise = requestCoreLogin(provider);

    // Then
    await expect(promise).rejects.toThrow('Rejected');
    await expect(promise).rejects.toMatchObject({
      name: 'LoginRequestError',
      error: {
        tag: 'Domain',
        value: {
          tag: 'V1',
          value: { tag: 'Unknown', value: { reason: 'Rejected' } },
        },
      },
    });
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, the host rejects host failures with the reason as the error message', async () => {
    // Given
    const { requestCoreLogin } = await import('../src/bridge.js');
    const reason = 'no free statement-store slot for device registration';
    const provider = makeLoginProvider({
      onPostMessage(message) {
        provider.listener?.(
          loginResponseFrame(requestIdFromFrame(message), {
            success: false,
            hostFailure: reason,
          }),
        );
      },
    });

    // When
    const promise = requestCoreLogin(provider);

    // Then
    await expect(promise).rejects.toThrow(reason);
    await expect(promise).rejects.toMatchObject({
      name: 'LoginRequestError',
      error: { tag: 'HostFailure', value: { reason } },
    });
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, the host rejects malformed response frames and unsubscribes', async () => {
    // Given
    const { requestCoreLogin } = await import('../src/bridge.js');
    const provider = makeLoginProvider({
      onPostMessage() {
        provider.listener?.(new Uint8Array([0xff, 0x00]));
      },
    });

    // When
    const login = requestCoreLogin(provider);

    // Then
    await expect(login).rejects.toThrow();
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, the host rejects send failures and unsubscribes', async () => {
    // Given
    const { requestCoreLogin } = await import('../src/bridge.js');
    const provider = makeLoginProvider({
      onPostMessage() {
        throw new Error('send failed');
      },
    });

    // When
    const login = requestCoreLogin(provider);

    // Then
    await expect(login).rejects.toThrow('send failed');
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, the host rejects and unsubscribes when the core provider closes', async () => {
    // Given
    const { requestCoreLogin } = await import('../src/bridge.js');
    const provider = makeLoginProvider({});

    // When
    const promise = requestCoreLogin(provider);

    // Then
    expect(provider.listener).not.toBeNull();
    expect(provider.closeListener).not.toBeNull();

    // When
    provider.closeListener?.(new Error('core transport closed'));

    // Then
    await expect(promise).rejects.toThrow('core transport closed');
    expect(provider.listener).toBeNull();
    expect(provider.closeListener).toBeNull();
  });
});
