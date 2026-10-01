// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState, RequiredHostCallbacks } from '@parity/truapi-host';
import type { LocalIdentity, LocalIdentityProgress, WalletAllowanceSnapshot } from '@parity/truapi-host/web';
import type { DotliAuthState } from '../src/host-callbacks/AuthState.js';
import type * as BridgeModule from '../src/bridge.js';
import type * as ModalQueueModule from '../src/blocking-modal-queue.js';
import { nth } from './helpers/nth.js';

const wallet = vi.hoisted(() => {
  const account: `0x${string}` = `0x${'12'.repeat(32)}`;
  return {
    account,
    revision: 'original',
    username: undefined as string | undefined,
    cachedUsername: undefined as string | undefined,
    // false: no chain lookup was ever recorded for this wallet revision.
    verified: true,
    failRefresh: false,
    refreshGate: undefined as Promise<void> | undefined,
    claimGate: undefined as Promise<void> | undefined,
    claimStarted: false,
    snapshotGate: undefined as Promise<void> | undefined,
    snapshotStarted: false,
    failNextProduct: false,
    closeNextProvider: false,
    sessions: [] as {
      disposed: boolean;
      username?: string | undefined;
      publish: (state: AuthState) => void;
      close: (error: Error) => void;
      closeCallbacks: Set<(error: Error) => void>;
    }[],
  };
});

const owner = vi.hoisted(() => ({
  requests: [] as { action: string; lease?: string }[],
  revoked: new Set<(lease: string) => void>(),
}));

vi.mock('@dotli/config', async original => ({
  ...(await original<Record<string, unknown>>()),
  DEBUG: true,
}));
vi.mock('../../shared/src/chat-capability.js', () => ({
  chatCapabilityFor: () => Promise.resolve(false),
}));
vi.mock('../src/notification.js', () => ({ showNotification: vi.fn() }));
vi.mock('../../protocol/src/client.js', async original => ({
  ...(await original<Record<string, unknown>>()),
  requestWalletOwner: (operation: { action: string; lease?: string }) => {
    owner.requests.push(operation);
    return Promise.resolve(operation.action === 'acquire' ? 'page-lease' : undefined);
  },
  subscribeWalletOwnerRevoked: (listener: (lease: string) => void) => {
    owner.revoked.add(listener);
    return () => owner.revoked.delete(listener);
  },
}));
vi.mock('../src/host-callbacks/SessionStore.js', async original => ({
  ...(await original<Record<string, unknown>>()),
  initializeLocalWalletState: async () => {},
  isExperimentalWalletActive: () => true,
  localWalletContext: () => ({ network: 'westend', revision: wallet.revision }),
  isCurrentLocalWallet: (context: { revision: string }) => context.revision === wallet.revision,
  readLocalWalletSecret: () => Promise.resolve(new Uint8Array(16)),
  readVerifiedLocalIdentity: () =>
    Promise.resolve(
      wallet.verified
        ? {
            identityAccountId: wallet.account,
            liteUsername: wallet.cachedUsername,
          }
        : undefined,
    ),
  writeVerifiedLocalIdentity: (_binding: unknown, identity: LocalIdentity) => {
    wallet.verified = true;
    wallet.cachedUsername = identity.liteUsername;
    return Promise.resolve();
  },
  onStoredSessionChanged: () => () => {},
  onVerifiedLocalIdentityChanged: () => () => {},
}));
vi.mock('@parity/truapi-host/worker-runtime?worker', () => ({
  default: class {
    terminate(): void {}
  },
}));
vi.mock('@parity/truapi-host/web', () => ({
  createWebWorkerPairingHostRuntime: vi.fn(),
  createWebWorkerSigningHostRuntime: (_worker: unknown, callbacks: RequiredHostCallbacks) => {
    let closeError: Error | undefined;
    const closeCallbacks = new Set<(error: Error) => void>();
    const session = {
      disposed: false,
      username: undefined as string | undefined,
      publish: (state: AuthState) => {
        callbacks.auth.authStateChanged(state);
      },
      closeCallbacks,
      close: (error: Error) => {
        if (closeError !== undefined) {
          return;
        }
        closeError = error;
        session.disposed = true;
        for (const callback of [...closeCallbacks]) {
          callback(error);
        }
        closeCallbacks.clear();
      },
    };
    wallet.sessions.push(session);
    const assertLive = (): void => {
      if (session.disposed) {
        throw new Error('Native session disposed');
      }
    };
    const identity = (): LocalIdentity => ({
      identityAccountId: wallet.account,
      ...(wallet.username === undefined ? {} : { liteUsername: wallet.username }),
    });
    const publish = (username?: string): void => {
      assertLive();
      session.username = username;
      session.publish({
        tag: 'Connected',
        value: {
          identityAccountId: wallet.account,
          publicKey: wallet.account,
          ...(username === undefined ? {} : { liteUsername: username }),
        },
      });
    };
    return Promise.resolve({
      activateLocalSession: () =>
        Promise.resolve().then(() => {
          publish();
        }),
      refreshLocalIdentity: async () => {
        assertLive();
        if (wallet.failRefresh) {
          throw new Error('Identity chain unavailable');
        }
        await wallet.refreshGate;
        publish(wallet.username);
        return identity();
      },
      getWalletAllowanceSnapshot: async (productIds: string[]): Promise<WalletAllowanceSnapshot> => {
        assertLive();
        const identityAccountId = wallet.account;
        wallet.snapshotStarted = true;
        await wallet.snapshotGate;
        const unavailable = {
          status: 'unavailable' as const,
          reason: 'No chain connection in this lifecycle scenario',
        };
        return {
          schemaVersion: 1,
          identityAccountId,
          networkSuffix: 'paseo',
          productIds,
          statementStore: unavailable,
          pgasClaims: unavailable,
          pgasBalances: unavailable,
          bulletinClaims: unavailable,
          bulletinQuotas: unavailable,
        };
      },
      registerLocalLiteUsername: async (
        name: string,
        _backend: string,
        onProgress?: (progress: LocalIdentityProgress) => void,
      ) => {
        assertLive();
        wallet.claimStarted = true;
        onProgress?.({ stage: 'checking' });
        await wallet.claimGate;
        assertLive();
        onProgress?.({ stage: 'confirming' });
        wallet.username = `${name}.westend`;
        publish(wallet.username);
        return identity();
      },
      createProvider: () =>
        Promise.resolve().then(() => {
          assertLive();
          if (wallet.failNextProduct) {
            wallet.failNextProduct = false;
            throw new Error('Product startup failed');
          }
          if (wallet.closeNextProvider) {
            wallet.closeNextProvider = false;
            session.close(new Error('Wallet provider already closed'));
          }
          const connectionCallbacks = new Set<(error: Error) => void>();
          return {
            postMessage: () => {
              assertLive();
            },
            subscribe: () => () => {},
            subscribeClose: (callback: (error: Error) => void) => {
              if (closeError !== undefined) {
                callback(closeError);
              } else {
                closeCallbacks.add(callback);
                connectionCallbacks.add(callback);
              }
              return () => {
                closeCallbacks.delete(callback);
                connectionCallbacks.delete(callback);
              };
            },
            disconnectSession: async () => {},
            getPermissionAuthorizationStatus: () => Promise.resolve('NotDetermined'),
            getPermissionAuthorizationStatuses: (requests: unknown[]) =>
              Promise.resolve(requests.map(() => 'NotDetermined')),
            setPermissionAuthorizationStatus: async () => {},
            dispose: () => {
              for (const callback of connectionCallbacks) {
                closeCallbacks.delete(callback);
                callback(new Error('Native provider disposed'));
              }
              connectionCallbacks.clear();
            },
          };
        }),
      dispose: () => {
        session.close(new Error('Native session disposed'));
      },
    });
  },
  createIframeHost: (args: { container: HTMLElement; iframeUrl: string }) => {
    const iframe = document.createElement('iframe');
    iframe.dataset['src'] = args.iframeUrl;
    args.container.appendChild(iframe);
    return {
      iframe,
      dispose: () => {
        iframe.remove();
      },
    };
  },
}));

const auth: DotliAuthState[] = [];
const recordAuth = (event: Event): void => {
  auth.push((event as CustomEvent<DotliAuthState>).detail);
};

let bridge: typeof BridgeModule;
let createBlockingModalCoordinator: typeof ModalQueueModule.createBlockingModalCoordinator;
let pageListeners: Parameters<typeof window.removeEventListener>[] = [];

function boot(): typeof BridgeModule {
  bridge.initBridgeEventListeners(createBlockingModalCoordinator());
  return bridge;
}

describe('host-owned experimental identity', () => {
  beforeEach(async () => {
    vi.resetModules();
    wallet.revision = 'original';
    wallet.username = undefined;
    wallet.cachedUsername = undefined;
    wallet.verified = true;
    wallet.failRefresh = false;
    wallet.refreshGate = undefined;
    wallet.claimGate = undefined;
    wallet.claimStarted = false;
    wallet.snapshotGate = undefined;
    wallet.snapshotStarted = false;
    wallet.failNextProduct = false;
    wallet.closeNextProvider = false;
    wallet.sessions.length = 0;
    owner.requests.length = 0;
    owner.revoked.clear();
    auth.length = 0;
    localStorage.clear();
    localStorage.setItem('dotli:local-wallet-enabled', '1');
    document.body.innerHTML = '<div id="app"></div>';
    const addListener = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      pageListeners.push([type, listener]);
      addListener(type, listener, options);
    });
    window.addEventListener('dotli:truapi-auth-state', recordAuth);
    // Re-import after reset to model independent page/session lifetimes.
    [bridge, { createBlockingModalCoordinator }] = await Promise.all([
      import('../src/bridge.js'),
      import('../src/blocking-modal-queue.js'),
    ]);
  });
  afterEach(async () => {
    // Dispose the same freshly imported page core, not a static older module.
    const { disposePageCores } = await import('../src/page-core.js');
    disposePageCores();
    for (const [type, listener] of pageListeners) {
      window.removeEventListener(type, listener);
    }
    pageListeners = [];
    vi.restoreAllMocks();
  });

  it('queries and claims identity before a product exists', async () => {
    const { experimentalWalletControls: controls } = boot();
    await expect(controls.getIdentity()).resolves.toMatchObject({
      identityAccountId: wallet.account,
    });
    await expect(controls.getProduct()).resolves.toBeNull();
    await expect(controls.claimLiteUsername('alice')).resolves.toEqual({
      identityAccountId: wallet.account,
      liteUsername: 'alice.westend',
    });
    expect(auth.at(-1)).toMatchObject({
      tag: 'Connected',
      session: { primaryUsername: 'alice.westend' },
    });
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('takes one tab lease before starting any wallet core, shared by the page', async () => {
    const { experimentalWalletControls: controls, renderIframe } = boot();
    bridge.setPageProduct({ label: 'first' });
    await controls.getIdentity();
    await renderIframe('https://first.example/', 'first');
    await renderIframe('https://first.example/reloaded', 'first');

    expect(wallet.sessions).toHaveLength(1);
    expect(owner.requests).toEqual([{ action: 'acquire' }]);
  });

  it('stops every wallet core and pauses before releasing the tab lease to another tab', async () => {
    const { experimentalWalletControls: controls, renderIframe } = boot();
    await controls.getIdentity();
    await renderIframe('https://first.example/', 'first');
    const paused = vi.fn();
    window.addEventListener('dotli:test-wallet-owner-revoked', paused);
    const disposedAtRelease: boolean[] = [];
    const release = owner.requests.push.bind(owner.requests);
    owner.requests.push = (...items) => {
      if (items.some(item => item.action === 'release')) {
        disposedAtRelease.push(wallet.sessions.every(s => s.disposed));
      }
      return release(...items);
    };

    for (const listener of owner.revoked) {
      listener('page-lease');
    }

    expect(paused).toHaveBeenCalledTimes(1);
    expect(disposedAtRelease).toEqual([true]);
    expect(owner.requests.at(-1)).toEqual({
      action: 'release',
      lease: 'page-lease',
    });
    window.removeEventListener('dotli:test-wallet-owner-revoked', paused);
  });

  it('publishes restored native identity without trusting a disk username or emitting bare Connected', async () => {
    wallet.cachedUsername = 'forged.westend';
    wallet.username = 'alice.westend';
    const gate = Promise.withResolvers<undefined>();
    wallet.refreshGate = gate.promise;
    const { experimentalWalletControls: controls } = boot();
    const query = controls.getIdentity();
    await vi.waitFor(() => {
      expect(wallet.sessions).toHaveLength(1);
    });
    expect(auth).toEqual([]);
    gate.resolve(undefined);
    await expect(query).resolves.toMatchObject({
      liteUsername: 'alice.westend',
    });
    expect(auth).toEqual([
      expect.objectContaining({
        tag: 'Connected',
        session: expect.objectContaining({ primaryUsername: 'alice.westend' }) as unknown,
      }),
    ]);
  });

  it("looks up a freshly imported wallet's username without Check username", async () => {
    wallet.verified = false;
    wallet.username = 'alice.westend';
    const { experimentalWalletControls: controls } = boot();
    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: 'alice.westend',
      usernameVerified: true,
    });
    expect(auth.at(-1)).toMatchObject({
      tag: 'Connected',
      session: { primaryUsername: 'alice.westend' },
    });
    expect(wallet.cachedUsername).toBe('alice.westend');
  });

  it('re-checks a cached absence, so a username claimed elsewhere appears', async () => {
    // This browser checked the identity before the name was claimed, e.g. on
    // another device; the record outlives re-imports because it is keyed by
    // account, not by import.
    wallet.cachedUsername = undefined;
    wallet.username = 'alice.westend';
    const { experimentalWalletControls: controls } = boot();
    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: 'alice.westend',
      usernameVerified: true,
    });
    expect(wallet.cachedUsername).toBe('alice.westend');
  });

  it('keeps a freshly imported wallet usable when its username lookup fails', async () => {
    wallet.verified = false;
    wallet.failRefresh = true;
    const { experimentalWalletControls: controls } = boot();
    await expect(controls.getIdentity()).resolves.toMatchObject({
      identityAccountId: wallet.account,
      usernameVerified: false,
    });
    // A failed read is not a verified absence: the next load must retry.
    expect(wallet.verified).toBe(false);
  });

  it('keeps wallet identity and global auth through failed and successful product replacement', async () => {
    const { experimentalWalletControls: controls, renderIframe } = boot();
    bridge.setPageProduct({ label: 'first' });
    await controls.claimLiteUsername('alice');
    await renderIframe('https://first.example/', 'first');
    wallet.failNextProduct = true;
    await expect(renderIframe('https://failed.example/', 'first')).rejects.toThrow('Product startup failed');
    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: 'alice.westend',
    });
    expect(document.querySelector('iframe')?.dataset['src']).toBe('https://first.example/');
    await renderIframe('https://second.example/', 'first');
    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: 'alice.westend',
    });
    expect(auth.at(-1)).toMatchObject({ tag: 'Connected', session: { primaryUsername: 'alice.westend' } });
    expect(wallet.sessions.filter(session => !session.disposed)).toHaveLength(1);
    expect(wallet.sessions.at(-1)?.username).toBe('alice.westend');
  });

  it('updates the product and host from the same native username confirmation', async () => {
    const { experimentalWalletControls: controls, renderIframe } = boot();
    await renderIframe('https://first.example/', 'first');
    await expect(controls.claimLiteUsername('alice')).resolves.toMatchObject({
      liteUsername: 'alice.westend',
    });
    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: 'alice.westend',
    });
    expect(auth.at(-1)).toMatchObject({
      tag: 'Connected',
      session: { primaryUsername: 'alice.westend' },
    });
  });

  it('finishes an in-flight claim while a product is replaced', async () => {
    const { experimentalWalletControls: controls, renderAppSubdomain } = boot();
    await renderAppSubdomain('first-cid', 'first');
    const gate = Promise.withResolvers<undefined>();
    wallet.claimGate = gate.promise;
    const claim = controls.claimLiteUsername('alice');
    await vi.waitFor(() => {
      expect(wallet.claimStarted).toBe(true);
    });
    const replacement = renderAppSubdomain('second-cid', 'first');
    await expect(controls.getIdentity()).resolves.toMatchObject({
      identityAccountId: wallet.account,
    });
    gate.resolve(undefined);
    await expect(claim).resolves.toMatchObject({
      liteUsername: 'alice.westend',
    });
    await replacement;
    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: 'alice.westend',
    });
    expect(wallet.sessions.at(-1)?.username).toBe('alice.westend');
    expect(auth.at(-1)).toMatchObject({
      tag: 'Connected',
      session: { primaryUsername: 'alice.westend' },
    });
  });

  it('retires a failed page core and explicitly retries without trusting stale callbacks', async () => {
    const { experimentalWalletControls: controls, renderIframe } = boot();
    bridge.setPageProduct({ label: 'first' });
    await controls.claimLiteUsername('alice');
    await renderIframe('https://first.example/', 'first');
    const owner = nth(wallet.sessions, 0);
    const lateCloseCallbacks = [...owner.closeCallbacks];
    const display = controls.getCachedIdentity();
    expect(display).toMatchObject({
      identityAccountId: wallet.account,
      primaryUsername: 'alice.westend',
    });
    const before = auth.length;
    owner.close(new Error('Wallet worker terminated'));
    owner.publish({ tag: 'Disconnected' });
    expect(auth.slice(before)).toEqual([{ tag: 'WalletUnavailable', reason: 'Wallet worker terminated' }]);
    expect(controls.getCachedIdentity()).toEqual(display);
    expect(owner.disposed).toBe(true);
    expect(document.querySelector('iframe')?.dataset['src']).toBe('https://first.example/');
    expect(wallet.sessions).toHaveLength(1);

    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: 'alice.westend',
    });
    const replacement = nth(wallet.sessions, 1);
    const afterRetry = auth.slice();
    for (const callback of lateCloseCallbacks) {
      callback(new Error('Late old worker close'));
    }
    expect(auth).toEqual(afterRetry);
    expect(replacement.disposed).toBe(false);
    await expect(controls.refreshUsername()).resolves.toMatchObject({
      liteUsername: 'alice.westend',
    });
    await expect(controls.claimLiteUsername('bob')).resolves.toMatchObject({
      liteUsername: 'bob.westend',
    });
    await renderIframe('https://first.example/reloaded', 'first');
    expect(replacement.disposed).toBe(false);
    expect(replacement.username).toBe('bob.westend');
    expect(wallet.sessions).toHaveLength(2);
  });

  it('does not publish a failure or retire a replacement after intentional owner disposal', async () => {
    const { experimentalWalletControls: controls } = boot();
    await controls.getIdentity();
    const owner = nth(wallet.sessions, 0);
    const lateCloseCallbacks = [...owner.closeCallbacks];
    const before = auth.slice();
    wallet.revision = 'replacement';
    await expect(controls.getIdentity()).rejects.toThrow('wallet or network changed');
    expect(owner.disposed).toBe(true);
    expect(auth).toEqual(before);
    await controls.getIdentity();
    const replacement = nth(wallet.sessions, 1);
    for (const callback of lateCloseCallbacks) {
      callback(new Error('Late intentionally disposed worker'));
    }
    await expect(controls.claimLiteUsername('alice')).resolves.toMatchObject({
      liteUsername: 'alice.westend',
    });
    expect(replacement.disposed).toBe(false);
    expect(auth.some(state => state.tag === 'WalletUnavailable')).toBe(false);
    expect(wallet.sessions).toHaveLength(2);
  });

  it('rejects an already-closed owner once and allows an explicit retry', async () => {
    wallet.closeNextProvider = true;
    const { experimentalWalletControls: controls } = boot();
    await expect(controls.getIdentity()).rejects.toThrow('Wallet provider already closed');
    expect(auth.filter(state => state.tag === 'WalletUnavailable')).toEqual([
      { tag: 'WalletUnavailable', reason: 'Wallet provider already closed' },
    ]);
    expect(auth.some(state => state.tag === 'LoginFailed')).toBe(false);
    expect(auth.some(state => state.tag === 'Connected')).toBe(false);
    expect(nth(wallet.sessions, 0).disposed).toBe(true);
    await expect(controls.refreshUsername()).resolves.toMatchObject({
      identityAccountId: wallet.account,
    });
    expect(wallet.sessions).toHaveLength(2);
    expect(nth(wallet.sessions, 1).disposed).toBe(false);
    expect(auth.at(-1)).toMatchObject({ tag: 'Connected' });
  });

  it('surfaces a native restoration failure instead of publishing cached identity', async () => {
    wallet.cachedUsername = 'forged.westend';
    const gate = Promise.withResolvers<undefined>();
    wallet.refreshGate = gate.promise;
    const { experimentalWalletControls: controls } = boot();
    const query = controls.getIdentity();
    const failed = expect(query).rejects.toThrow('Identity chain unavailable');
    await vi.waitFor(() => {
      expect(wallet.sessions).toHaveLength(1);
    });
    gate.reject(new Error('Identity chain unavailable'));
    await failed;
    expect(auth.some(state => state.tag === 'Connected')).toBe(false);
    await vi.waitFor(() => {
      expect(auth.at(-1)).toMatchObject({
        tag: 'WalletUnavailable',
        reason: 'Identity chain unavailable',
      });
    });
    expect(auth.some(state => state.tag === 'LoginFailed')).toBe(false);
    expect(nth(wallet.sessions, 0).disposed).toBe(true);
    expect(wallet.cachedUsername).toBe('forged.westend');
  });

  it('rejects an allowance snapshot completed after the wallet was replaced', async () => {
    const { experimentalWalletControls: controls } = boot();
    const gate = Promise.withResolvers<undefined>();
    wallet.snapshotGate = gate.promise;
    const request = controls.getAllowanceSnapshot();
    const rejected = expect(request).rejects.toThrow('test identity changed');
    await vi.waitFor(() => {
      expect(wallet.snapshotStarted).toBe(true);
    });
    wallet.revision = 'replacement';
    gate.resolve(undefined);
    await rejected;
  });

  it('rejects an allowance snapshot completed after the selected product changed', async () => {
    const { experimentalWalletControls: controls, renderIframe } = boot();
    const gate = Promise.withResolvers<undefined>();
    wallet.snapshotGate = gate.promise;
    const request = controls.getAllowanceSnapshot();
    const rejected = expect(request).rejects.toThrow('inspection context changed');
    await vi.waitFor(() => {
      expect(wallet.snapshotStarted).toBe(true);
    });
    await renderIframe('https://next.example/', 'next');
    gate.resolve(undefined);
    await rejected;
  });

  it('rejects a late claim and native callback from a replaced identity', async () => {
    const { experimentalWalletControls: controls } = boot();
    await controls.getIdentity();
    const gate = Promise.withResolvers<undefined>();
    wallet.claimGate = gate.promise;
    const progress = vi.fn();
    const claim = controls.claimLiteUsername('alice', progress);
    await vi.waitFor(() => {
      expect(wallet.claimStarted).toBe(true);
    });
    expect(progress).toHaveBeenLastCalledWith({ stage: 'checking' });
    wallet.revision = 'replacement';
    const before = auth.slice();
    progress.mockClear();
    gate.resolve(undefined);
    await expect(claim).rejects.toThrow();
    expect(auth).toEqual(before);
    expect(progress).not.toHaveBeenCalled();
    await expect(controls.getIdentity()).rejects.toThrow('wallet or network changed');
  });
});
