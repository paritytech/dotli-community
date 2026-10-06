// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
// The product and protocol frames are never navigated in these tests, and
// happy-dom would otherwise try to fetch their pages from a dev server.
import 'fake-indexeddb/auto';
import { afterEach, assert, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent } from '@solidjs/testing-library';
import {
  type WireProvider,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  VersionedHostRequestLoginError,
  VersionedHostRequestLoginResponse,
  decodeWireMessage,
  encodeWireMessage,
  scale,
} from '@parity/truapi';
import { ACCOUNT_REQUEST_LOGIN } from '@parity/truapi/wire-table';
import { nth } from './helpers/nth.js';
import { POLKAVM_APPS_KEY } from '@dotli/config';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { settle as settleSolid } from './helpers/solid.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface MockProvider {
  postMessage: Mock<WireProvider['postMessage']>;
  subscribe: Mock<WireProvider['subscribe']>;
  subscribeClose: Mock<NonNullable<WireProvider['subscribeClose']>>;
  disconnectSession: Mock;
  getPermissionAuthorizationStatus: Mock;
  getPermissionAuthorizationStatuses: Mock;
  setPermissionAuthorizationStatus: Mock;
  disconnect: Mock;
  dispose: Mock<WireProvider['dispose']>;
}

interface MockRuntime {
  createProvider: Mock;
  cancelPairing: Mock;
  disconnectSession: Mock;
  notifySessionStoreChanged: Mock;
  dispose: Mock;
}

type ProviderListener = (message: Uint8Array) => void;
type ProviderCloseListener = (error: Error) => void;

// Window listeners the bridge under test added; removed after each test so an
// earlier test's bridge never reacts to a later test's events.
let bridgeListeners: Parameters<typeof window.removeEventListener>[] = [];

afterEach(() => {
  resetOverlays();
  vi.unstubAllGlobals();
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
    allow: string;
    iframe: HTMLIFrameElement;
    dispose: Mock;
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

vi.mock('@parity/truapi-host', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createWasmRawCallbacks: mocks.createWasmRawCallbacks,
}));

vi.mock('@parity/truapi-host/web', () => ({
  createBrowserNativeChatFilesHost: vi.fn(),
  createWebWorkerPairingHostRuntime: mocks.createWebWorkerPairingHostRuntime,
  createWebWorkerSigningHostRuntime: mocks.createWebWorkerSigningHostRuntime,
  createIframeHost: mocks.createIframeHost,
}));

vi.mock('@parity/truapi-host/worker-runtime?worker', () => ({
  default: mocks.HostWorker,
}));

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
    | { success: false; hostFailure: string },
): Uint8Array {
  // Codec 2 legs carry Result outside and the version wrapper inside.
  const responseCodec = scale.Result(
    VersionedHostRequestLoginResponse,
    scale.CallError(VersionedHostRequestLoginError),
  );
  const value = responseCodec.enc(
    result.success
      ? { success: true, value: { tag: 'V1', value: result.value } }
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
      (args: { iframeUrl: string; allowedOrigin: string; allow: string; container: HTMLElement }) => {
        const iframe = document.createElement('iframe');
        iframe.dataset['src'] = args.iframeUrl;
        args.container.appendChild(iframe);
        const dispose = vi.fn(() => {
          iframe.remove();
        });
        const host = {
          iframeUrl: args.iframeUrl,
          allowedOrigin: args.allowedOrigin,
          allow: args.allow,
          iframe,
          dispose,
        };
        mocks.iframeHosts.push(host);
        return { iframe, dispose };
      },
    );
    const spy = vi.spyOn(window, 'addEventListener');
    const [{ initBridgeEventListeners }, { createBlockingModalCoordinator }] = await Promise.all([
      import('../src/bridge.js'),
      import('../src/blocking-modal-queue.js'),
    ]);
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

  it('delivers direct-frame notifications without carrying activations into a replacement execution', async ({
    onTestFinished,
  }) => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    onTestFinished(() => {
      focus.mockRestore();
    });
    const { renderIframe } = await import('../src/bridge.js');
    const { createNotificationAdapters } = await import('../src/host-callbacks/PushNotification.js');
    const { setNotificationAccount } = await import('../src/notification-activation.js');
    const { findNotification } = await import('@dotli/storage/notification-activations');
    const label = 'preview-notifications';
    window.history.replaceState(null, '', '/__preview?url=https%3A%2F%2Fpreview.example%2Fapp');
    const first = renderIframe('https://preview.example/app', label);
    await waitForProviderRequests(1);
    nth(mocks.coreProviderDefers, 0).resolve(makeProvider());
    await first;
    setNotificationAccount(label, '11'.repeat(32));

    const api = createNotificationAdapters(label);
    const pushed = await api.pushNotification({ text: 'Preview notification', deeplink: '/message/1' });
    const record = await findNotification(label, pushed.id);
    assert.isDefined(record);
    expect(record.entryUrl).toBe(window.location.href);
    await overlaysReady();
    const notification = document.querySelector<HTMLButtonElement>('.notif-body');
    expect(notification?.textContent).toBe('Preview notification');
    notification?.click();
    await vi.waitFor(async () => {
      expect((await api.activationEvents()).events).toEqual([
        { sequence: BigInt(record.sequence), notificationId: pushed.id, route: '/message/1' },
      ]);
    });

    const replacement = renderIframe('https://preview.example/app', label);
    await waitForProviderRequests(2);
    nth(mocks.coreProviderDefers, 1).resolve(makeProvider());
    await replacement;
    setNotificationAccount(label, '11'.repeat(32));
    expect((await api.activationEvents()).events).toEqual([]);
    const next = await api.pushNotification({ text: 'New execution', deeplink: '/message/2' });
    const nextRecord = await findNotification(label, next.id);
    assert.isDefined(nextRecord);
    expect(nextRecord.scope.artifact).not.toBe(record.scope.artifact);

    window.dispatchEvent(new Event('dotli:logged-out'));
    await expect(api.pushNotification({ text: 'After logout' })).rejects.toThrow('authenticated account');
  }, 10_000);

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
    const [{ renderIframe, renderAppSubdomain }, layout] = await Promise.all([
      import('../src/bridge.js'),
      import('../src/product-frame-layout.js'),
    ]);
    const renders = [
      () => renderIframe('https://product.example/app', 'product'),
      () => renderAppSubdomain('cid', 'product'),
    ];
    for (const [index, render] of renders.entries()) {
      layout.setTopbarLayout({ offset: true, shown: true, transition: '' });
      const rendered = render();
      await waitForProviderRequests(index + 1);
      nth(mocks.coreProviderDefers, index).resolve(makeProvider());
      await rendered;
      const { iframe } = nth(mocks.iframeHosts, index);
      expect(iframe.style.position).toBe('fixed');
      layout.setTopbarLayout({ offset: false, shown: false, transition: '' });
      expect(iframe.style.transform).toBe('translateY(0)');
    }
  }, 10_000);

  it("threads exact executable manifest text and the user's PolkaVM opt-out into the sandbox contract", async () => {
    localStorage.setItem(POLKAVM_APPS_KEY, '0');
    const executableManifest =
      '{"$v":2,"kind":"app","appVersion":[0,1,7],"runtime":{"kind":"web","entrypoint":"index.html"}}';
    const { renderAppSubdomain } = await import('../src/bridge.js');

    const render = renderAppSubdomain('manifest-cid', 'manifest-app', executableManifest);
    await waitForProviderRequests(1);
    nth(mocks.coreProviderDefers, 0).resolve(makeProvider());
    await render;

    const iframeUrl = new URL(nth(mocks.iframeHosts, 0).iframeUrl);
    expect(iframeUrl.searchParams.get('executableManifest')).toBe(executableManifest);
    expect(iframeUrl.searchParams.get('polkaVmEnabled')).toBe('0');
    expect(nth(mocks.iframeHosts, 0).allow).not.toContain('accelerometer');
    expect(nth(mocks.iframeHosts, 0).allow).not.toContain('gyroscope');
  });

  it("threads the user's PolkaVM opt-in into the sandbox contract", async () => {
    localStorage.setItem(POLKAVM_APPS_KEY, '1');
    const { renderAppSubdomain } = await import('../src/bridge.js');

    const render = renderAppSubdomain('polkavm-cid', 'polkavm-app');
    await waitForProviderRequests(1);
    nth(mocks.coreProviderDefers, 0).resolve(makeProvider());
    await render;

    const iframeUrl = new URL(nth(mocks.iframeHosts, 0).iframeUrl);
    expect(iframeUrl.searchParams.get('polkaVmEnabled')).toBe('1');
  });

  it('delegates motion sensors to PolkaVM product frames with web fallbacks', async () => {
    const executableManifest =
      '{"$v":2,"kind":"app","appVersion":[0,1,12],"runtime":{"kind":"polkavm","abiVersion":2,"entrypoint":"app.polkavm","fallback":{"kind":"web","entrypoint":"fallback/index.html"}},"capabilities":{"graphics":{"abiVersion":1,"profile":"webgpu-raster","requiredFeatures":[],"requiredLimits":{}}}}';
    const { renderAppSubdomain } = await import('../src/bridge.js');

    const render = renderAppSubdomain('motion-cid', 'motion-app', executableManifest);
    await waitForProviderRequests(1);
    nth(mocks.coreProviderDefers, 0).resolve(makeProvider());
    await render;

    const directives = nth(mocks.iframeHosts, 0).allow.split('; ');
    expect(directives).toContain('accelerometer');
    expect(directives).toContain('gyroscope');
  });

  it('requests motion at top level and relays physical samples to the PolkaVM frame', async () => {
    class TestDeviceMotionEvent extends Event {
      static requestPermission = vi.fn(() => Promise.resolve('granted' as const));
      readonly accelerationIncludingGravity = { x: 1, y: 2, z: 9 };
      readonly rotationRate = { alpha: 3, beta: 4, gamma: 5 };
    }
    vi.stubGlobal('DeviceMotionEvent', TestDeviceMotionEvent);
    const executableManifest =
      '{"$v":2,"kind":"app","appVersion":[0,1,9],"runtime":{"kind":"polkavm","abiVersion":2,"entrypoint":"app.polkavm"},"capabilities":{"graphics":{"abiVersion":1,"profile":"webgpu-raster","requiredFeatures":[],"requiredLimits":{}}}}';
    const { renderAppSubdomain } = await import('../src/bridge.js');
    const render = renderAppSubdomain('motion-relay-cid', 'motion-relay', executableManifest);
    await waitForProviderRequests(1);
    nth(mocks.coreProviderDefers, 0).resolve(makeProvider());
    await render;

    const created = nth(mocks.iframeHosts, 0);
    const targetWindow = created.iframe.contentWindow;
    if (targetWindow === null) {
      throw new Error('app frame has no content window');
    }
    const postMessage = vi.spyOn(targetWindow, 'postMessage').mockImplementation(() => {});
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:polkavm-motion-request' },
        origin: created.allowedOrigin,
        source: targetWindow,
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:polkavm-motion-request' },
        origin: created.allowedOrigin,
        source: targetWindow,
      }),
    );
    await overlaysReady();
    expect(document.querySelectorAll('.notif-action')).toHaveLength(1);
    const enable = document.querySelector<HTMLButtonElement>('.notif-action');
    enable?.click();
    enable?.click();
    await vi.waitFor(() => {
      expect(TestDeviceMotionEvent.requestPermission).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith(
        { type: 'dotli:polkavm-motion-status', availability: 1 },
        created.allowedOrigin,
      );
    });
    const prompt = enable?.closest('.notif-card');
    if (prompt === null || prompt === undefined) {
      throw new Error('motion permission prompt is missing');
    }
    fireEvent.animationEnd(prompt);
    await settleSolid();
    expect(prompt.isConnected).toBe(false);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:polkavm-motion-request' },
        origin: created.allowedOrigin,
        source: targetWindow,
      }),
    );
    await settleSolid();
    expect(document.querySelector('.notif-action')).toBeNull();

    window.dispatchEvent(new TestDeviceMotionEvent('devicemotion'));
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'dotli:polkavm-motion-sample',
        timestampMs: expect.any(Number) as unknown,
        acceleration: { x: 1, y: 2, z: 9 },
        rotation: { alpha: 3, beta: 4, gamma: 5 },
      },
      created.allowedOrigin,
    );
  });

  it('mediates one PolkaVM platform command per trusted app-frame activation', async () => {
    const executableManifest =
      '{"$v":2,"kind":"app","appVersion":[0,2,0],"runtime":{"kind":"polkavm","abiVersion":2,"entrypoint":"app.polkavm"},"capabilities":{"graphics":{"abiVersion":1,"profile":"tri2d","requiredFeatures":[]}}}';
    // Import after the per-test module reset so bridge singleton state is isolated.
    const { renderAppSubdomain } = await import('../src/bridge.js');
    const render = renderAppSubdomain('ui-output-cid', 'ui-output', executableManifest);
    await waitForProviderRequests(1);
    nth(mocks.coreProviderDefers, 0).resolve(makeProvider());
    await render;

    const created = nth(mocks.iframeHosts, 0);
    const source = created.iframe.contentWindow;
    if (source === null) {
      throw new Error('app frame has no content window');
    }
    const origin = new URL(created.iframeUrl).origin;
    const activation = { isActive: false, hasBeenActive: false };
    const activationDescriptor = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: activation,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    let now = 10_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const dispatch = (data: unknown, messageOrigin = origin, messageSource: MessageEventSource = source): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data,
          origin: messageOrigin,
          source: messageSource,
        }),
      );
    };

    try {
      dispatch({
        type: 'dotli:polkavm-ui-command',
        command: { type: 'copy-text', text: 'automatic' },
      });
      await Promise.resolve();
      expect(writeText).not.toHaveBeenCalled();

      activation.isActive = true;
      activation.hasBeenActive = true;
      dispatch({ type: 'dotli:polkavm-user-activation' }, 'https://evil.example');
      dispatch({
        type: 'dotli:polkavm-ui-command',
        command: { type: 'copy-text', text: 'wrong-origin' },
      });
      await Promise.resolve();
      expect(writeText).not.toHaveBeenCalled();

      dispatch({ type: 'dotli:polkavm-user-activation' });
      // Cold guest work can exceed one second while browser activation is live.
      now += 1_500;
      dispatch({
        type: 'dotli:polkavm-ui-command',
        command: { type: 'copy-text', text: 'hello' },
      });
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledExactlyOnceWith('hello');
      });
      dispatch({
        type: 'dotli:polkavm-ui-command',
        command: { type: 'copy-text', text: 'second' },
      });
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledTimes(1);

      dispatch({ type: 'dotli:polkavm-user-activation' });
      now += 5_001;
      dispatch({
        type: 'dotli:polkavm-ui-command',
        command: { type: 'copy-text', text: 'expired' },
      });
      expect(writeText).toHaveBeenCalledTimes(1);

      dispatch({ type: 'dotli:polkavm-user-activation' });
      activation.isActive = false;
      dispatch({
        type: 'dotli:polkavm-ui-command',
        command: { type: 'copy-text', text: 'browser-activation-expired' },
      });
      expect(writeText).toHaveBeenCalledTimes(1);
      activation.isActive = true;

      dispatch({ type: 'dotli:polkavm-user-activation' });
      dispatch({
        type: 'dotli:polkavm-ui-command',
        command: {
          type: 'open-url',
          url: 'javascript:alert(1)',
        },
      });
      expect(open).not.toHaveBeenCalled();

      dispatch({ type: 'dotli:polkavm-user-activation' });
      dispatch({
        type: 'dotli:polkavm-ui-command',
        command: {
          type: 'open-url',
          url: 'https://example.test/ignored-control',
          newSurface: false,
        },
      });
      expect(open).not.toHaveBeenCalled();

      dispatch({ type: 'dotli:polkavm-user-activation' });
      dispatch({
        type: 'dotli:polkavm-ui-command',
        command: {
          type: 'open-url',
          url: 'http://example.test/insecure',
        },
      });
      expect(open).not.toHaveBeenCalled();

      dispatch({ type: 'dotli:polkavm-user-activation' });
      dispatch({
        type: 'dotli:polkavm-ui-command',
        command: {
          type: 'open-url',
          url: 'https://example.test/path',
        },
      });
      expect(open).toHaveBeenCalledExactlyOnceWith('https://example.test/path', '_blank', 'noopener,noreferrer');
    } finally {
      open.mockRestore();
      clock.mockRestore();
      if (activationDescriptor === undefined) {
        Reflect.deleteProperty(navigator, 'userActivation');
      } else {
        Object.defineProperty(navigator, 'userActivation', activationDescriptor);
      }
      if (clipboardDescriptor === undefined) {
        Reflect.deleteProperty(navigator, 'clipboard');
      } else {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      }
    }
  });

  it('rejects legacy window frames without forwarding codec-1 bytes to the core', async () => {
    const { renderAppSubdomain } = await import('../src/bridge.js');
    const notification = await import('../src/notification.js');
    const showNotification = vi.spyOn(notification, 'showNotification').mockImplementation(() => () => undefined);
    const render = renderAppSubdomain('cid', 'legacy');
    await waitForProviderRequests(1);
    const provider = makeProvider();
    nth(mocks.coreProviderDefers, 0).resolve(provider);
    await render;
    const created = nth(mocks.iframeHosts, 0);
    const source = created.iframe.contentWindow;
    if (source === null) {
      throw new Error('app frame has no content window');
    }
    // Empty request id, flat handshake discriminant 0, V1 tag, codec 1.
    const data = new Uint8Array([0, 0, 0, 0, 1]);
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        origin: 'https://attacker.example',
        data,
      }),
    );
    expect(showNotification).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        origin: created.allowedOrigin,
        data,
      }),
    );
    expect(provider.postMessage).not.toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledTimes(1);
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        origin: created.allowedOrigin,
        data,
      }),
    );
    expect(showNotification).toHaveBeenCalledTimes(1);
    showNotification.mockRestore();
  });

  it('forwards a sandbox schema mismatch as a host PWA update request', async () => {
    const { renderAppSubdomain } = await import('../src/bridge.js');
    const render = renderAppSubdomain('manifest-cid', 'manifest-app');
    await waitForProviderRequests(1);
    nth(mocks.coreProviderDefers, 0).resolve(makeProvider());
    await render;

    const updateRequired = vi.fn();
    window.addEventListener('dotli:host-update-required', updateRequired, {
      once: true,
    });
    const targetWindow = nth(mocks.iframeHosts, 0).iframe.contentWindow;
    expect(targetWindow).not.toBeNull();
    const appOrigin = new URL(nth(mocks.iframeHosts, 0).iframeUrl).origin;

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:host-update-required' },
        origin: 'https://evil.example',
        source: targetWindow,
      }),
    );
    expect(updateRequired).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:host-update-required' },
        origin: appOrigin,
        source: window,
      }),
    );
    expect(updateRequired).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:host-update-required' },
        origin: appOrigin,
        source: targetWindow,
      }),
    );
    expect(updateRequired).toHaveBeenCalledTimes(1);
  });

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
    document.body.innerHTML = `<div id="app"><div class="loading"></div></div>`;
    window.history.replaceState(null, '', '/');
    mocks.createWebWorkerPairingHostRuntime.mockImplementation(() => Promise.resolve(makeRuntime()));
    mocks.createIframeHost.mockImplementation(
      (args: { iframeUrl: string; allowedOrigin: string; allow?: string; container: HTMLElement }) => {
        const iframe = document.createElement('iframe');
        iframe.dataset['src'] = args.iframeUrl;
        args.container.appendChild(iframe);
        const dispose = vi.fn(() => {
          iframe.remove();
        });
        mocks.iframeHosts.push({
          iframeUrl: args.iframeUrl,
          allowedOrigin: args.allowedOrigin,
          allow: args.allow ?? '',
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
    const loading = app?.querySelector<HTMLElement>('.loading');
    if (app === null || loading === null || loading === undefined) {
      throw new Error('fixture has no #app > .loading');
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
    document.body.innerHTML = `<div class="loading" id="app-loading"></div><div id="app"></div>`;
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
    mocks.createWebWorkerPairingHostRuntime.mockImplementation(() => {
      const runtime = makeRuntime();
      runtime.createProvider.mockImplementation(() => Promise.resolve(makeProvider()));
      return Promise.resolve(runtime);
    });
    await renderAppSubdomain('cid', 'reloaded');
    const previousFrame = document.querySelector('#app > iframe');
    showErrorPage({ title: 'Failed' });

    expect(document.querySelector('#app > .error-page')).not.toBeNull();

    // An error page replaces the frame, so recovery now comes from the host,
    // not a fabricated sandbox message with the detached frame's null source.
    await renderAppSubdomain('cid', 'reloaded');

    const frame = document.querySelector('#app > iframe');
    expect(document.querySelector('#app > .error-page')).toBeNull();
    expect(frame?.isConnected).toBe(true);
    expect(frame).not.toBe(previousFrame);
    expect(document.querySelectorAll('#app > iframe')).toHaveLength(1);
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

  it('ignores responses for another trait, method, leg or request', async () => {
    const { requestCoreLogin } = await import('../src/bridge.js');
    const provider = makeLoginProvider({});
    const promise = requestCoreLogin(provider);
    const requestId = requestIdFromFrame(nth(provider.postMessage.mock.calls, 0)[0]);
    const response = decodeWireMessage(
      loginResponseFrame(requestId, {
        success: true,
        value: 'Success',
      }),
    );
    if (response.isErr()) {
      throw response.error;
    }
    for (const override of [
      { traitId: ACCOUNT_REQUEST_LOGIN.trait + 1 },
      { methodId: ACCOUNT_REQUEST_LOGIN.method + 1 },
      { messageType: MESSAGE_TYPE_REQUEST },
    ]) {
      const frame = encodeWireMessage({
        ...response.value,
        payload: { ...response.value.payload, ...override },
      });
      if (frame.isErr()) {
        throw frame.error;
      }
      provider.listener?.(frame.value);
      expect(provider.listener).not.toBeNull();
    }
    provider.listener?.(
      loginResponseFrame('another-request', {
        success: true,
        value: 'Rejected',
      }),
    );
    expect(provider.listener).not.toBeNull();
    provider.listener?.(
      loginResponseFrame(requestId, {
        success: true,
        value: 'Success',
      }),
    );
    await expect(promise).resolves.toBe('Success');
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
