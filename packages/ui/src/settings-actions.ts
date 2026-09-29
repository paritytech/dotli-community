// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the settings popover (components/shell/SettingsPopover.tsx) does
// besides rendering: persist the chosen settings and reload, wipe this
// origin's state, and gather the diagnostics it shows and shares. Solid-free
// and eager: the host's boot calls wipeOriginState when a URL changes the
// settings, before any island has loaded.

import {
  formatAppVersion,
  getActiveAppManifest,
  getActiveRootManifest,
} from "@dotli/shared";
import {
  createRemoteChainProvider,
  isRemoteChainSupported,
} from "@dotli/protocol";
import {
  getCacheSettings,
  setCacheSettings,
  getBackend,
  setBackend,
  BACKEND_LABELS,
  type Backend,
  type CacheSettings,
  getNetwork,
  setNetwork,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  type Network,
  getActiveServicesConfig,
  writeSettingsToSearch,
} from "@dotli/config";
import { clearCidCache, clearBlockCache } from "@dotli/storage";

import { ALL_PERMISSIONS, getPermissionStatuses } from "./permissions.js";
import { getProductState } from "./state/product.js";
import { THEME_KEY } from "./theme-controller.js";

/**
 * Draft of everything the popover can change. Controls mutate this. Nothing
 * touches localStorage or reloads the page until the user clicks Save &
 * Apply. Closing the popover throws the draft away. The next open re-reads
 * persisted state from scratch, so partial changes never leak.
 */
export interface ModeDraft {
  chain: Backend;
  network: Network;
  cache: CacheSettings;
}

/**
 * Apply the pending draft, then reload. Cache deletion is scoped to what
 * actually changed:
 *
 *   - Backend or network changes delete nothing. The cached CID, archive,
 *     and worker state stay warm.
 *   - Turning a cache toggle off clears that cache's origin:
 *       dotNS clears the host-origin CID store here, directly.
 *       Archive clears the host-origin block store here, directly.
 *       Worker needs no signal. The persisted `skipWorkerCache` flag
 *              makes the protocol iframe purge on its next boot.
 *
 * `forceFullWipe` (the "Clear all caches" button) bypasses the diff and
 * wipes every origin via the original full-reset pipeline: wipe host state,
 * re-apply settings, and flag the protocol and sandbox iframes to purge
 * themselves regardless of their persisted prefs.
 *
 * Order matters: persist settings first (so the reload boots with them),
 * run the host-origin deletes, mark cross-origin one-shot signals, reload.
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
      // Force every origin to purge regardless of persisted prefs.
      try {
        sessionStorage.setItem("dotli:pending-reset:protocol", "1");
        sessionStorage.setItem("dotli:pending-reset:sandbox", "1");
        // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable (Safari private mode); cross-origin purges are best-effort, reload below is unconditional.
      } catch {
        /* sessionStorage unavailable: cross-origin purges skipped */
      }
    } else {
      // No origin wipe. Persist the new choices, then delete only the caches
      // the user just turned off (skip flag flipped from false to true).
      setBackend(draft.chain);
      setNetwork(draft.network);
      setCacheSettings(draft.cache);

      const cidTurnedOff =
        draft.cache.skipCidCache && !prior.cache.skipCidCache;
      const archiveTurnedOff =
        draft.cache.skipArchiveCache && !prior.cache.skipArchiveCache;

      if (cidTurnedOff) {
        await clearCidCache();
      }
      if (archiveTurnedOff) {
        await clearBlockCache();
      }
    }

    // Mirror the new settings to the URL so the reload below boots with
    // the same effective state the user just picked. Defaults drop off
    // so a clean dot.li URL keeps meaning "every axis at default".
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
      const newUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", newUrl);
    }
  } finally {
    window.location.reload();
  }
}

/**
 * Keys that describe the browser rather than the state a reset clears.
 *
 * The theme is what the visitor chose to look at, not state they asked the
 * reset to clear. Losing it turns a settings reset into a visible change
 * nobody requested.
 */
export const PRESERVED_KEYS: readonly string[] = [THEME_KEY];

/**
 * Wipe this origin's IDB, CacheStorage, SW registrations, localStorage,
 * sessionStorage. Best-effort: Firefox and Safari pre-17 lack
 * `indexedDB.databases()`. Everything in `PRESERVED_KEYS` survives. Callers
 * still re-write settings they want to change, since those are new values
 * rather than preserved ones.
 */
export async function wipeOriginState(): Promise<void> {
  await Promise.allSettled([deleteAllIndexedDBs(), deleteAllCacheStorage()]);
  await unregisterAllServiceWorkers();
  try {
    sessionStorage.clear();
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage unavailable (Safari private mode). Full reset is best-effort; anything we can't clear just means a partial baseline.
  } catch {
    /* sessionStorage unavailable */
  }
  try {
    const preserved = PRESERVED_KEYS.map(
      (key) => [key, localStorage.getItem(key)] as const,
    );
    localStorage.clear();
    for (const [key, value] of preserved) {
      if (value !== null) {
        localStorage.setItem(key, value);
      }
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage unavailable. Full reset is best-effort.
  } catch {
    /* localStorage unavailable */
  }
}

async function deleteAllIndexedDBs(): Promise<void> {
  try {
    if (
      typeof indexedDB === "undefined" ||
      typeof indexedDB.databases !== "function"
    ) {
      return;
    }
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map(
        (db) =>
          new Promise<void>((resolve) => {
            if (db.name === undefined || db.name === "") {
              resolve();
              return;
            }
            const req = indexedDB.deleteDatabase(db.name);
            // Cap each delete at 3s in case Chromium never fires success/error/blocked.
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
    // eslint-disable-next-line no-restricted-syntax -- full-reset is best-effort; any surviving IDB just means partial baseline. Next boot will still see the new mode settings.
  } catch {
    /* best-effort IDB wipe */
  }
}

async function deleteAllCacheStorage(): Promise<void> {
  try {
    if (typeof caches === "undefined") {
      return;
    }
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    // eslint-disable-next-line no-restricted-syntax -- full-reset is best-effort; partial CacheStorage survival is acceptable.
  } catch {
    /* best-effort CacheStorage wipe */
  }
}

async function unregisterAllServiceWorkers(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    // eslint-disable-next-line no-restricted-syntax -- full-reset is best-effort; surviving SW registration will be replaced on next install.
  } catch {
    /* best-effort SW unregister */
  }
}

// Baked at build time by `apps/host/vite.config.ts` (`define.*`). The
// topbar only ever renders in the host shell so these will always be
// present in practice. `undefined` fallbacks are defensive for tests and
// for any future caller that imports this module from a different bundle.
declare const __DOTLI_VERSION__: string | undefined;
declare const __LIGHT_CLIENT_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSIONS__:
  { name: string; version: string }[] | undefined;
declare const __PARITY_TRUAPI_VERSIONS__:
  { name: string; version: string }[] | undefined;

export function isTruapiDebugEnabled(): boolean {
  try {
    return sessionStorage.getItem("dotli:truapi-debug") === "1";
  } catch {
    // sessionStorage may be unavailable in exotic environments (Safari
    // private mode). Default to "not in debug mode".
    return false;
  }
}

/** Flatten the diagnostics tree into a plain-text block that reads cleanly
 *  both inside a GitHub issue code block and in a Slack message.
 *
 *  Structure (one blank line between sections):
 *    1. Base rows (Site, Build, Chain[, Worker|RPC Node], Content, Browser)
 *    2. Cache: every toggle as on/off. Sourced from persisted settings
 *              so the snapshot matches what's actually live right now.
 *    3. Permissions: per-product, omitted on landing where we don't have
 *                    a scoped label to query.
 *    4. Packages: flat list of smoldot, polkadot-api, and @parity/truapi,
 *                 with the block heights queried at share time. They are
 *                 not rendered in this popover any more, they live in the
 *                 network panel where they can be read live. */
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

  // Cache
  const cache = getCacheSettings();
  lines.push(
    "",
    "Cache:",
    `  dotNS cache: ${cache.skipCidCache ? "off" : "on"}`,
    `  Archive cache: ${cache.skipArchiveCache ? "off" : "on"}`,
    `  Worker cache: ${cache.skipWorkerCache ? "off" : "on"}`,
  );

  // Permissions, only when we know which product label to scope against.
  const product = getProductState();
  if (product.status === "loaded") {
    const productLabel = product.label;
    lines.push("", "Permissions:");
    const statuses = await getPermissionStatuses(
      productLabel,
      ALL_PERMISSIONS.map(({ name }) => name),
    );
    for (const [index, perm] of ALL_PERMISSIONS.entries()) {
      const status = statuses[index] ?? "ask";
      lines.push(`  ${perm.label}: ${status === "granted" ? "on" : "off"}`);
    }
  }

  // Packages, one flat list. smoldot leads because it's the heaviest
  // dependency and the one most issues are ultimately about.
  lines.push("", "Packages:", `  smoldot: ${smoldot.version}`);
  for (const p of polkadotApi) {
    lines.push(`  ${p.name}: ${p.version}`);
  }
  for (const p of parityTruapi) {
    lines.push(`  ${p.name}: ${p.version}`);
  }
  return lines.join("\n");
}

export function buildBaseDiagnosticsRows(): [label: string, value: string][] {
  const version =
    typeof __DOTLI_VERSION__ === "string" ? __DOTLI_VERSION__ : "0.0.0";
  const sha = (import.meta.env.VITE_COMMIT_SHA as string | undefined) ?? "dev";

  const backend = getBackend();
  const network = getNetwork();

  const rows: [string, string][] = [
    // `location.host` includes the port when non-default. Useful on
    // localhost (`hackme3.localhost:5173`), transparent on production
    // (`hackme3.dot.li`).
    ["Site", window.location.host],
    ["Build", `${version} (${shortSha(sha)})`],
    ["Network", NETWORK_NAME_TO_SERVICES_CONFIG[network].label],
    ["Network Transport", backendLabel(backend)],
  ];

  // Sub-row attached to the Network Transport row:
  //   - smoldot-shared-worker: "Worker" label and build SHA. The SharedWorker
  //     is a cached script. If it's running an older bundle than the current
  //     page, this SHA diverges from Build, which is the tell-tale for a stale
  //     worker. (Today the Worker ships embedded in the same bundle, so
  //     the two match. The row still lets us spot a divergence in the
  //     field.)
  //   - smoldot-direct: no sub-row. smoldot is torn down every page load.
  //   - rpc-gateway: both WSS endpoints (Relay and Asset Hub). The curated
  //     lists are candidate endpoints. polkadot-api's ws-provider rotates
  //     on failure, so the Diagnostics component later replaces the Asset Hub
  //     entry with the one the provider is actually connected to. Relay
  //     isn't dialed at all in rpc mode today (dotNS is Asset Hub only),
  //     so it just shows the first candidate for reference.
  if (backend === "smoldot-shared-worker") {
    if (typeof SharedWorker === "undefined") {
      rows.push(["Worker", "unavailable"]);
    } else {
      rows.push(["Worker", shortSha(sha)]);
    }
  } else if (backend === "rpc-gateway") {
    const cfg = getActiveServicesConfig();
    rows.push(["Relay node", cfg.relay.rpcs[0] ?? "n/a"]);
    rows.push(["AssetHub node", cfg.assethub.rpcs[0] ?? "n/a"]);
    rows.push(["Bulletin Node", cfg.bulletin.rpcs[0] ?? "n/a"]);
  }

  // Product manifest snapshot.
  const root = getActiveRootManifest();
  if (root !== null) {
    rows.push(["Manifest", `v${String(root.schemaVersion)}`]);
  }
  const app = getActiveAppManifest();
  if (app !== null) {
    rows.push(["App version", formatAppVersion(app.appVersion)]);
  }

  rows.push(["Browser", summarizeUserAgent(navigator.userAgent)]);
  return rows;
}

export function backendLabel(b: Backend): string {
  return BACKEND_LABELS[b];
}

/** Gather the smoldot readouts a diagnostic report quotes. */
export async function collectSmoldotInfo(): Promise<SmoldotInfo> {
  const info: SmoldotInfo = {
    version: buildLightClientVersionLabel(),
    blocks: { relay: "n/a", assetHub: "n/a", people: "n/a" },
  };
  if (getBackend() === "rpc-gateway") {
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
  /** Human-facing version label, e.g. "3.0.0 (c33c647)". */
  version: string;
  /** Mutable block readouts for the share report. */
  blocks: { relay: string; assetHub: string; people: string };
}

// The light client is smoldot compiled into truapi-provider's wasm, so the
// provider version is what identifies the build. There is no separate smoldot
// version to report.
export function buildLightClientVersionLabel(): string {
  return typeof __LIGHT_CLIENT_VERSION__ === "string"
    ? __LIGHT_CLIENT_VERSION__
    : "unknown";
}

/**
 * Query the finalized block number for a given chain through the protocol
 * iframe's `chainConnect` bridge. Works across all chain backends:
 *   - smoldot-shared-worker / smoldot-direct: goes through smoldot
 *   - rpc: goes through the curated WSS endpoint
 *
 * Returns `null` if the chain isn't supported by the active backend (e.g.
 * asking for relay in rpc mode, which only supports Asset Hub) or if the
 * query doesn't resolve within the timeout. The heavy `polkadot-api` import
 * stays dynamic so opening the popover is cheap when the user doesn't care
 * about blocks.
 */
export async function queryFinalizedBlock(
  genesisHash: string,
): Promise<number | null> {
  try {
    if (!isRemoteChainSupported(genesisHash)) {
      return null;
    }
    const provider = createRemoteChainProvider(genesisHash);
    if (provider === null) {
      return null;
    }
    const papi = await import("polkadot-api");
    const client = papi.createClient(provider);
    try {
      const block = await Promise.race([
        client.getFinalizedBlock(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("timeout"));
          }, 10_000);
        }),
      ]);
      return block.number;
    } finally {
      client.destroy();
    }
  } catch {
    return null;
  }
}

export function formatBlock(n: number | null): string {
  return n === null ? "n/a" : `#${n.toLocaleString("en-US")}`;
}

export function shortSha(sha: string): string {
  if (sha === "dev" || sha.length <= 7) {
    return sha;
  }
  return sha.slice(0, 7);
}

/**
 * Turn a long `navigator.userAgent` string into something compact like
 * "Chrome 147 (macOS)". Heuristic, not a replacement for a real UA parser.
 * Good enough for a debug row that the user can still click-to-copy the
 * full value (the row shows the short version but the UA is stable enough
 * that engineers can recognize the brand without the full payload).
 */
export function summarizeUserAgent(ua: string): string {
  let browser = "Unknown";
  const chromeMatch = /(Chrome|CriOS)\/(\d+)/.exec(ua);
  const firefoxMatch = /Firefox\/(\d+)/.exec(ua);
  const safariMatch = /Version\/(\d+)[^)]+Safari/.exec(ua);
  const edgeMatch = /Edg\/(\d+)/.exec(ua);
  if (edgeMatch) {
    browser = `Edge ${edgeMatch[1]}`;
  } else if (firefoxMatch) {
    browser = `Firefox ${firefoxMatch[1]}`;
  } else if (chromeMatch) {
    browser = `Chrome ${chromeMatch[2]}`;
  } else if (safariMatch) {
    browser = `Safari ${safariMatch[1]}`;
  }

  let os = "Unknown";
  if (ua.includes("Mac OS X") || ua.includes("Macintosh")) {
    os = "macOS";
  } else if (ua.includes("Windows")) {
    os = "Windows";
  } else if (ua.includes("Android")) {
    os = "Android";
  } else if (ua.includes("iPhone") || ua.includes("iPad")) {
    os = "iOS";
  } else if (ua.includes("Linux")) {
    os = "Linux";
  }

  return `${browser} (${os})`;
}

/** A package name and version, as the build-time globals list them. */
export interface PackageVersion {
  name: string;
  version: string;
}

/**
 * The package versions the diagnostics list, from the build-time globals.
 * The unscoped `polkadot-api` package lives in the same visual section as
 * `@polkadot-api/*`. Same ecosystem, same release cadence, users expect to
 * see it with its siblings rather than at the top of the popover.
 */
export function packageVersions(): {
  polkadotApi: PackageVersion[];
  parityTruapi: PackageVersion[];
} {
  const polkadotApi: PackageVersion[] = [];
  if (typeof __POLKADOT_API_VERSION__ === "string") {
    polkadotApi.push({
      name: "polkadot-api",
      version: __POLKADOT_API_VERSION__,
    });
  }
  if (typeof __POLKADOT_API_VERSIONS__ !== "undefined") {
    polkadotApi.push(...__POLKADOT_API_VERSIONS__);
  }
  const parityTruapi =
    typeof __PARITY_TRUAPI_VERSIONS__ === "undefined"
      ? []
      : __PARITY_TRUAPI_VERSIONS__;
  return { polkadotApi, parityTruapi };
}
