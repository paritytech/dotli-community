import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubColorScheme } from './helpers/color-scheme.js';

const sharedAuth = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  listeners: new Set<(change: { siteId: string; key: string; value: string | null }) => void>(),
}));

vi.mock('../../protocol/src/client.js', () => ({
  readSharedAuthStorage: (siteId: string, key: string) =>
    Promise.resolve(sharedAuth.storage.get(`${siteId}:${key}`) ?? null),
  writeSharedAuthStorage: (siteId: string, key: string, value: string) => {
    sharedAuth.storage.set(`${siteId}:${key}`, value);
    return Promise.resolve();
  },
  clearSharedAuthStorage: (siteId: string, key: string) => {
    sharedAuth.storage.delete(`${siteId}:${key}`);
    return Promise.resolve();
  },
  subscribeSharedAuthStorage: (listener: (change: { siteId: string; key: string; value: string | null }) => void) => {
    sharedAuth.listeners.add(listener);
    return () => {
      sharedAuth.listeners.delete(listener);
    };
  },
  // initTopBar's block source, read by the network store it starts.
  isRemoteChainConnectable: () => false,
}));

const device = vi.hoisted(() => ({ mobile: false }));

vi.mock('../../shared/src/device.js', () => ({
  isMobileDevice: () => device.mobile,
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function installTopbarDom(): void {
  document.body.innerHTML = `
    <a id="topbar-home"></a>
  `;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  device.mobile = false;
  localStorage.clear();
  sharedAuth.storage.clear();
  sharedAuth.listeners.clear();
  document.body.innerHTML = '';
});

describe('topbar boot rehydration', () => {
  it('As a dotli integrator, the host renders the persisted session badge on idle after init', async () => {
    // Given
    installTopbarDom();
    vi.stubGlobal('requestIdleCallback', (callback: () => void): number => {
      callback();
      return 0;
    });

    const { SHARED_CORE_SESSION_KEY } = await import('../../protocol/src/auth-storage.js');
    const { SITE_ID } = await import('../../config/src/config.js');
    // The opaque session blob and the UI-state cache the core's authStateChanged persists beside it.
    sharedAuth.storage.set(`${SITE_ID}:${SHARED_CORE_SESSION_KEY}`, '0x0102');
    sharedAuth.storage.set(
      `${SITE_ID}:${SHARED_CORE_SESSION_KEY}:ui-state`,
      JSON.stringify({
        connected: true,
        publicKey: '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
        liteUsername: 'pgherveou.04',
        primaryUsername: 'pgherveou.04',
      }),
    );

    // When
    const { initTopBar } = await import('../src/topbar.js');
    const { getAuthState, getLoggedIn } = await import('../src/state/auth.js');
    initTopBar();
    await flushMicrotasks();

    // Then: the stores the auth islands render, whenever they mount.
    expect(getAuthState()).toEqual({
      tag: 'Connected',
      session: {
        connected: true,
        publicKey: '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
        liteUsername: 'pgherveou.04',
        primaryUsername: 'pgherveou.04',
      },
    });
    expect(getLoggedIn()).toBe(true);
  });

  it('As a dotli integrator, the host stays logged out when no session is persisted', async () => {
    // Given
    installTopbarDom();
    vi.stubGlobal('requestIdleCallback', (callback: () => void): number => {
      callback();
      return 0;
    });

    // When
    const { initTopBar } = await import('../src/topbar.js');
    const { getAuthState, getLoggedIn } = await import('../src/state/auth.js');
    initTopBar();
    await flushMicrotasks();

    // Then
    expect(getAuthState()).toEqual({ tag: 'Disconnected' });
    expect(getLoggedIn()).toBe(false);
  });
});

describe('topbar theme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-pref');
  });

  it('As a dotli user, initTopBar applies my stored theme', async () => {
    // Given
    installTopbarDom();
    stubColorScheme('dark');
    localStorage.setItem('dotli-theme', 'light');
    const { initTopBar } = await import('../src/topbar.js');
    const { getThemeState } = await import('../src/state/theme.js');

    // When
    initTopBar();

    // Then
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(getThemeState()).toEqual({ pref: 'light', resolved: 'light' });
  });

  it('As a dotli user, a fresh profile defaults to the System option', async () => {
    // Given
    installTopbarDom();
    stubColorScheme('light');
    const { initTopBar } = await import('../src/topbar.js');

    // When
    initTopBar();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBeNull();
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('As a dotli user, the System option follows OS theme changes after initTopBar', async () => {
    // Given
    installTopbarDom();
    const os = stubColorScheme('dark');
    localStorage.setItem('dotli-theme', 'system');
    const { initTopBar } = await import('../src/topbar.js');
    initTopBar();

    // When
    os.set('light');

    // Then
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
