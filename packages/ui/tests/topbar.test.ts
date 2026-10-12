import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubColorScheme } from './helpers/color-scheme.js';

const sharedAuth = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  listeners: new Set<(change: { siteId: string; key: string; value: string | null }) => void>(),
}));

vi.mock('../../protocol/src/client.js', () => ({
  readSharedLocalWallet: () => Promise.resolve({ status: 'none' }),
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
