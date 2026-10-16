// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Settings persistence, origin wipes and diagnostics. Solid-free and eager because the host's boot
// calls wipeOriginState when a URL changes the settings, before any island has loaded.

import { formatAppVersion, getActiveAppManifest, getActiveRootManifest, log, markContinuation } from '@dotli/shared';
import { isRemoteChainSupported } from '@dotli/protocol';
import {
  getCacheSettings,
  setCacheSettings,
  getBackend,
  setBackend,
  setPolkaVmAppsEnabled,
  BACKEND_LABELS,
  type Backend,
  type CacheSettings,
  getNetwork,
  setNetwork,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  type Network,
  getActiveServicesConfig,
  writeSettingsToSearch,
} from '@dotli/config';
import { clearInstalledExecutableCache, clearBlockCache } from '@dotli/storage';

import { loadBridge } from './lazy.js';
import { ALL_PERMISSIONS, getPermissionStatuses } from './permissions.js';
import { getProductState } from './state/product.js';
import { THEME_KEY } from './theme-controller.js';
import { flushSharedModeWrites } from './shared-mode.js';

/** Nothing is persisted until Save & Apply, and closing the popover discards the draft. */
export interface ModeDraft {
  chain: Backend;
  network: Network;
  cache: CacheSettings;
  polkaVmAppsEnabled: boolean;
}

/**
 * Deletes only caches the user just turned off. The persisted `skipWorkerCache` flag makes the protocol
 * iframe purge itself on its next boot. Settings persist before the deletes so the reload boots with them.
 */
export async function applyAndReset(
  draft: ModeDraft,
  prior: ModeDraft,
  { forceFullWipe = false }: { forceFullWipe?: boolean } = {},
): Promise<void> {
  try {
    if (forceFullWipe) {
      await wipeOriginState();
      setBackend(draft.chain);
      setNetwork(draft.network);
      setCacheSettings(draft.cache);
      setPolkaVmAppsEnabled(draft.polkaVmAppsEnabled);
      // Forces the cross-origin frames to purge regardless of their persisted prefs.
      try {
        sessionStorage.setItem('dotli:pending-reset:protocol', '1');
        sessionStorage.setItem('dotli:pending-reset:sandbox', '1');
        // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable (Safari private mode); cross-origin purges are best-effort, reload below is unconditional.
      } catch {
        // Cross-origin purges skipped.
      }
    } else {
      setBackend(draft.chain);
      setNetwork(draft.network);
      setCacheSettings(draft.cache);
      setPolkaVmAppsEnabled(draft.polkaVmAppsEnabled);

      const cidTurnedOff = draft.cache.skipCidCache && !prior.cache.skipCidCache;
      const archiveTurnedOff = draft.cache.skipArchiveCache && !prior.cache.skipArchiveCache;

      if (cidTurnedOff) {
        await clearInstalledExecutableCache();
      }
      if (archiveTurnedOff) {
        await clearBlockCache();
      }
    }

    // The URL carries the settings too, so the reload boots with them. Defaults drop off.
    const search = new URLSearchParams(window.location.search);
    if (
      writeSettingsToSearch(
        {
          network: draft.network,
          chainBackend: draft.chain,
          cache: draft.cache,
        },
        search,
      )
    ) {
      const query = search.toString();
      const newUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
      window.history.replaceState(null, '', newUrl);
    }
  } finally {
    await flushSharedModeWrites();
    markContinuation('settings_change');
    window.location.reload();
  }
}

/** Survive a reset, since losing the theme would be a visible change nobody requested. */
export const PRESERVED_KEYS: readonly string[] = [THEME_KEY];

/** Best-effort, since Firefox and older Safari lack `indexedDB.databases()`. */
export async function wipeOriginState(): Promise<void> {
  await Promise.allSettled([deleteAllIndexedDBs(), deleteAllCacheStorage()]);
  await unregisterAllServiceWorkers();
  try {
    sessionStorage.clear();
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage unavailable (Safari private mode). Full reset is best-effort; anything we can't clear just means a partial baseline.
  } catch {
    // sessionStorage unavailable.
  }
  try {
    const preserved = PRESERVED_KEYS.map(key => [key, localStorage.getItem(key)] as const);
    localStorage.clear();
    for (const [key, value] of preserved) {
      if (value !== null) {
        localStorage.setItem(key, value);
      }
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage unavailable. Full reset is best-effort.
  } catch {
    // localStorage unavailable.
  }
}

async function deleteAllIndexedDBs(): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
      return;
    }
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map(
        db =>
          new Promise<void>(resolve => {
            if (db.name === undefined || db.name === '') {
              resolve();
              return;
            }
            const req = indexedDB.deleteDatabase(db.name);
            // Chromium may never fire success, error or blocked.
            const timer = setTimeout(resolve, 3000);
            const settle = (): void => {
              clearTimeout(timer);
              resolve();
            };
            req.onsuccess = settle;
            req.onerror = settle;
            req.onblocked = settle;
          }),
      ),
    );
  } catch (err) {
    log.warn('[dot.li settings] IndexedDB wipe failed:', err);
  }
}

async function deleteAllCacheStorage(): Promise<void> {
  try {
    if (typeof caches === 'undefined') {
      return;
    }
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch (err) {
    log.warn('[dot.li settings] CacheStorage wipe failed:', err);
  }
}

async function unregisterAllServiceWorkers(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) {
      return;
    }
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
  } catch (err) {
    log.warn('[dot.li settings] service worker unregister failed:', err);
  }
}

// Defined by `apps/host/vite.config.ts`, so undefined in tests and other bundles.
declare const __DOTLI_VERSION__: string | undefined;
declare const __LIGHT_CLIENT_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSIONS__: { name: string; version: string }[] | undefined;
declare const __PARITY_TRUAPI_VERSIONS__: { name: string; version: string }[] | undefined;

export function isTruapiDebugEnabled(): boolean {
  try {
    return sessionStorage.getItem('dotli:truapi-debug') === '1';
  } catch {
    // sessionStorage unavailable, as in Safari private mode.
    return false;
  }
}

/** Plain text that reads cleanly in a GitHub issue code block and in a Slack message. */
export async function formatDiagnosticsReport(
  base: [label: string, value: string][],
  smoldot: SmoldotInfo,
  polkadotApi: { name: string; version: string }[],
  parityTruapi: { name: string; version: string }[],
): Promise<string> {
  const lines: string[] = [];
  for (const [k, v] of base) {
    lines.push(`${k}: ${v}`);
  }

  const cache = getCacheSettings();
  lines.push(
    '',
    'Cache:',
    `  dotNS cache: ${cache.skipCidCache ? 'off' : 'on'}`,
    `  Archive cache: ${cache.skipArchiveCache ? 'off' : 'on'}`,
    `  Worker cache: ${cache.skipWorkerCache ? 'off' : 'on'}`,
  );

  const product = getProductState();
  if (product.status === 'loaded') {
    const productLabel = product.label;
    lines.push('', 'Permissions:');
    const statuses = await getPermissionStatuses(
      productLabel,
      ALL_PERMISSIONS.map(({ name }) => name),
    );
    for (const [index, perm] of ALL_PERMISSIONS.entries()) {
      const status = statuses[index] ?? 'ask';
      lines.push(`  ${perm.label}: ${status === 'granted' ? 'on' : 'off'}`);
    }
  }

  // smoldot leads because most issues are ultimately about it.
  lines.push('', 'Packages:', `  smoldot: ${smoldot.version}`);
  for (const p of polkadotApi) {
    lines.push(`  ${p.name}: ${p.version}`);
  }
  for (const p of parityTruapi) {
    lines.push(`  ${p.name}: ${p.version}`);
  }
  return lines.join('\n');
}

/** The release the build descends from. */
export function dotliVersion(): string {
  return typeof __DOTLI_VERSION__ === 'string' ? __DOTLI_VERSION__ : '0.0.0';
}

export function buildBaseDiagnosticsRows(): [label: string, value: string][] {
  const sha = import.meta.env.VITE_COMMIT_SHA ?? 'dev';

  const backend = getBackend();
  const network = getNetwork();

  const rows: [string, string][] = [
    ['Site', window.location.host],
    ['Build', `${dotliVersion()} (${shortSha(sha)})`],
    ['Network', NETWORK_NAME_TO_SERVICES_CONFIG[network].label],
    ['Transport', backendLabel(backend)],
  ];

  // A Worker SHA that diverges from Build is the tell-tale of a stale cached SharedWorker. RPC rows show
  // the first candidate, which the Diagnostics component replaces with the endpoint actually connected.
  if (backend === 'smoldot-shared-worker') {
    if (typeof SharedWorker === 'undefined') {
      rows.push(['Worker', 'unavailable']);
    } else {
      rows.push(['Worker', shortSha(sha)]);
    }
  } else if (backend === 'rpc-gateway') {
    const cfg = getActiveServicesConfig();
    rows.push(['Relay node', cfg.relay.rpcs[0] ?? 'n/a']);
    rows.push(['AssetHub node', cfg.assethub.rpcs[0] ?? 'n/a']);
    rows.push(['Bulletin Node', cfg.bulletin.rpcs[0] ?? 'n/a']);
  }

  const root = getActiveRootManifest();
  if (root !== null) {
    rows.push(['Manifest', `v${String(root.schemaVersion)}`]);
  }
  const app = getActiveAppManifest();
  if (app !== null) {
    rows.push(['App version', formatAppVersion(app.appVersion)]);
  }

  rows.push(['Browser', summarizeUserAgent(navigator.userAgent)]);
  return rows;
}

export function backendLabel(b: Backend): string {
  return BACKEND_LABELS[b];
}

export async function collectSmoldotInfo(): Promise<SmoldotInfo> {
  const info: SmoldotInfo = {
    version: buildLightClientVersionLabel(),
    blocks: { relay: 'n/a', assetHub: 'n/a', people: 'n/a' },
  };
  if (getBackend() === 'rpc-gateway') {
    return info;
  }
  const cfg = getActiveServicesConfig();
  const [relay, assetHub, people] = await Promise.all([
    queryFinalizedBlock(cfg.relay.genesis),
    queryFinalizedBlock(cfg.assethub.genesis),
    queryFinalizedBlock(cfg.people.genesis),
  ]);
  info.blocks = {
    relay: formatBlock(relay),
    assetHub: formatBlock(assetHub),
    people: formatBlock(people),
  };
  return info;
}

export interface SmoldotInfo {
  version: string;
  blocks: { relay: string; assetHub: string; people: string };
}

// smoldot is compiled into truapi-provider's wasm, so the provider version identifies the build.
export function buildLightClientVersionLabel(): string {
  return typeof __LIGHT_CLIENT_VERSION__ === 'string' ? __LIGHT_CLIENT_VERSION__ : 'unknown';
}

/**
 * Null when the active backend does not support the chain or the query times out. The bridge and
 * `polkadot-api` chunks load here because this module is on the eager path.
 */
export async function queryFinalizedBlock(genesisHash: string): Promise<number | null> {
  try {
    if (!isRemoteChainSupported(genesisHash)) {
      return null;
    }
    const { hostChainProvider } = await loadBridge();
    const provider = hostChainProvider(genesisHash);
    if (provider === null) {
      return null;
    }
    const papi = await import('polkadot-api');
    const client = papi.createClient(provider);
    try {
      const block = await Promise.race([
        client.getFinalizedBlock(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('timeout'));
          }, 10_000);
        }),
      ]);
      return block.number;
    } finally {
      client.destroy();
    }
  } catch (err) {
    log.warn('[dot.li settings] finalized block query failed:', err);
    return null;
  }
}

export function formatBlock(n: number | null): string {
  return n === null ? 'n/a' : `#${n.toLocaleString('en-US')}`;
}

export function shortSha(sha: string): string {
  if (sha === 'dev' || sha.length <= 7) {
    return sha;
  }
  return sha.slice(0, 7);
}

/** A heuristic like "Chrome 147 (macOS)", not a real UA parser. */
export function summarizeUserAgent(ua: string): string {
  let browser = 'Unknown';
  const chromeVersion = /(Chrome|CriOS)\/(\d+)/.exec(ua)?.[2];
  const firefoxVersion = /Firefox\/(\d+)/.exec(ua)?.[1];
  const safariVersion = /Version\/(\d+)[^)]+Safari/.exec(ua)?.[1];
  const edgeVersion = /Edg\/(\d+)/.exec(ua)?.[1];
  if (edgeVersion !== undefined) {
    browser = `Edge ${edgeVersion}`;
  } else if (firefoxVersion !== undefined) {
    browser = `Firefox ${firefoxVersion}`;
  } else if (chromeVersion !== undefined) {
    browser = `Chrome ${chromeVersion}`;
  } else if (safariVersion !== undefined) {
    browser = `Safari ${safariVersion}`;
  }

  let os = 'Unknown';
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) {
    os = 'macOS';
  } else if (ua.includes('Windows')) {
    os = 'Windows';
  } else if (ua.includes('Android')) {
    os = 'Android';
  } else if (ua.includes('iPhone') || ua.includes('iPad')) {
    os = 'iOS';
  } else if (ua.includes('Linux')) {
    os = 'Linux';
  }

  return `${browser} (${os})`;
}

export interface PackageVersion {
  name: string;
  version: string;
}

/** The unscoped `polkadot-api` package is listed with its `@polkadot-api/*` siblings. */
export function packageVersions(): {
  polkadotApi: PackageVersion[];
  parityTruapi: PackageVersion[];
} {
  const polkadotApi: PackageVersion[] = [];
  if (typeof __POLKADOT_API_VERSION__ === 'string') {
    polkadotApi.push({
      name: 'polkadot-api',
      version: __POLKADOT_API_VERSION__,
    });
  }
  if (typeof __POLKADOT_API_VERSIONS__ !== 'undefined') {
    polkadotApi.push(...__POLKADOT_API_VERSIONS__);
  }
  const parityTruapi = typeof __PARITY_TRUAPI_VERSIONS__ === 'undefined' ? [] : __PARITY_TRUAPI_VERSIONS__;
  return { polkadotApi, parityTruapi };
}
