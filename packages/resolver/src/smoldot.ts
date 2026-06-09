// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Smoldot lifecycle management.
//
// Single shared smoldot instance plus a small set of provider factories.
// The protocol host can override the resolver's Asset Hub provider so
// `.dot` resolution and remote dApp clients share one upstream JSON-RPC
// loop through a broker.
//
// Chain DB persistence lives in `./smoldot-db`. Each chain loads any
// saved blob and passes it as `addChain.databaseContent`, then snapshots
// back into IDB on a timer. Keys are scoped by network + chain.

import { start as startSmoldotDirect } from "polkadot-api/smoldot";
import { startFromWorker } from "polkadot-api/smoldot/from-worker";
import SmWorker from "polkadot-api/smoldot/worker?worker";
import {
  getPaseoChainSpec,
  getAssetHubPaseoChainSpec,
  getBulletinPaseoChainSpec,
  getPeopleChainSpec,
  getCustomRelayChainSpec,
} from "./chain-specs";
import { getSmProvider } from "polkadot-api/sm-provider";
import type { JsonRpcProvider } from "polkadot-api";
import { log } from "@dotli/shared/log";
import { getNetwork } from "@dotli/config/network";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import {
  loadChainDb,
  saveChainDb,
  tapChain,
  type ChainDbTap,
} from "./smoldot-db";

/** The smoldot Client type (shared by `start()` and `startFromWorker()`). */
export type SmoldotClient = ReturnType<typeof startFromWorker>;

export type SmoldotChain = Awaited<ReturnType<SmoldotClient["addChain"]>>;

// Smoldot's logCallback fires for all internal events. We watch for
// connection-related errors/warnings and notify subscribers so the UI
// can surface bootnode issues to the user.

type ConnectionIssueCallback = (message: string) => void;
const connectionIssueListeners = new Set<ConnectionIssueCallback>();

/**
 * Subscribe to smoldot connection issues (bootnode drops, timeouts, etc.).
 * Returns an unsubscribe function.
 */
export function onConnectionIssue(cb: ConnectionIssueCallback): () => void {
  connectionIssueListeners.add(cb);
  return () => {
    connectionIssueListeners.delete(cb);
  };
}

// Smoldot's WASM can panic (e.g. the "Option::unwrap() on a None value"
// crash during relay-chain sync). A panic leaves every chain dead and any
// in-flight request would hang forever. The log callback catches the
// panic line so the surrounding layers can broadcast a fatal signal out
// to the host client and reject pending requests immediately instead of
// relying on a per-request timeout.

type FatalCallback = (message: string) => void;
const fatalListeners = new Set<FatalCallback>();
let smoldotFatalMessage: string | null = null;

export function onSmoldotFatal(cb: FatalCallback): () => void {
  fatalListeners.add(cb);
  // Replay the panic message for listeners registered after the crash so
  // a late subscriber still sees the failure instead of silently waiting.
  if (smoldotFatalMessage !== null) {
    try {
      cb(smoldotFatalMessage);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast replay: one buggy late subscriber must not prevent the caller from registering.
    } catch {
      /* listener threw, safe to ignore on replay */
    }
  }
  return () => {
    fatalListeners.delete(cb);
  };
}

function markSmoldotFatal(message: string): void {
  if (smoldotFatalMessage !== null) {
    return;
  }
  smoldotFatalMessage = message;
  for (const cb of fatalListeners) {
    try {
      cb(message);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one buggy subscriber must not block the fatal broadcast to all others.
    } catch {
      /* listener threw, do not let one listener break the broadcast */
    }
  }
}

// Patterns that indicate a bootnode or peer connection problem.
const CONNECTION_ISSUE_PATTERNS = [
  "reset by remote",
  "refused",
  "closed",
  "timeout",
  "no longer reachable",
  "handshake",
  "all bootnodes",
];

function smoldotLogCallback(
  level: number,
  target: string,
  message: string,
): void {
  // Level 1 = Error, 2 = Warn, 3 = Info, 4 = Debug, 5 = Trace
  if (level <= 2) {
    log.warn(`[smoldot:${target}] ${message}`);
  } else {
    log.debug(`[smoldot:${target}] ${message}`);
  }

  // A panic is terminal with no recovery. Smoldot's log message starts
  // with "Smoldot has panicked while executing task …". Surface as fatal.
  if (
    message.includes("Smoldot has panicked") ||
    message.includes("panicked at")
  ) {
    markSmoldotFatal(message);
  }

  if (connectionIssueListeners.size === 0) {
    return;
  }

  // Only surface connection-related messages
  const lower = message.toLowerCase();
  const isConnectionIssue =
    CONNECTION_ISSUE_PATTERNS.some((p) => lower.includes(p)) ||
    (level === 1 && target.includes("network"));

  if (isConnectionIssue) {
    for (const cb of connectionIssueListeners) {
      cb(message);
    }
  }
}

let smoldotInstance: SmoldotClient | null = null;
let relayChainPromise: Promise<SmoldotChain> | null = null;

interface PersistenceEntry {
  tap: ChainDbTap;
  initialTimer: ReturnType<typeof setTimeout>;
  periodicTimer: ReturnType<typeof setInterval>;
}
const persistence = new Map<string, PersistenceEntry>();

function dbKeyFor(chainName: string): string {
  return `${getNetwork()}:${chainName}`;
}

function unrefHandle(handle: ReturnType<typeof setTimeout>): void {
  // Node-only no-op in browsers, lets vitest exit instead of hanging on timers.
  const h = handle as unknown as { unref?: () => void };
  if (typeof h.unref === "function") {
    h.unref();
  }
}

function schedulePersistence(chainName: string, tap: ChainDbTap): void {
  if (persistence.has(chainName)) {
    return;
  }
  const key = dbKeyFor(chainName);
  let inFlight = false;
  async function persist(): Promise<void> {
    // The chain may have been removed through a path that didn't call
    // `teardownPersistence` directly (e.g. a `getSmProvider` disconnect on the
    // resolver chain). Self-heal so the interval doesn't leak for the life of
    // the SharedWorker.
    if (tap.isStopped()) {
      teardownPersistence(chainName);
      return;
    }
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const content = await tap.extractDb();
      if (content !== null && (await saveChainDb(key, content))) {
        log.debug(
          `[dot.li smoldot] persisted ${chainName} DB (${String(content.length)} bytes)`,
        );
      }
    } catch (err: unknown) {
      log.warn(
        `[dot.li smoldot] persist ${chainName} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      inFlight = false;
    }
  }
  const initialTimer = setTimeout(() => {
    void persist();
  }, 30_000);
  const periodicTimer = setInterval(() => {
    void persist();
  }, 60_000);
  unrefHandle(initialTimer);
  unrefHandle(periodicTimer);
  persistence.set(chainName, { tap, initialTimer, periodicTimer });
}

function teardownPersistence(chainName: string): void {
  const entry = persistence.get(chainName);
  if (entry === undefined) {
    return;
  }
  clearTimeout(entry.initialTimer);
  clearInterval(entry.periodicTimer);
  entry.tap.stop();
  persistence.delete(chainName);
}

function teardownAllPersistence(): void {
  for (const name of [...persistence.keys()]) {
    teardownPersistence(name);
  }
}

function attachPersistence(
  chainName: string,
  underlying: SmoldotChain,
): SmoldotChain {
  teardownPersistence(chainName);
  const tap = tapChain(underlying);
  schedulePersistence(chainName, tap);
  return tap.chain;
}

/**
 * Create smoldot using `start()`, which runs on the current thread.
 *
 * Used in SharedWorker context where the `Worker` constructor is unavailable.
 * Smoldot networking (WebSocket) is async; occasional CPU bursts for block
 * verification (~2-10ms per block) are acceptable on the SharedWorker thread.
 */
export function getSmoldotDirect(): SmoldotClient {
  if (smoldotInstance !== null) {
    return smoldotInstance;
  }
  log.warn("[dot.li smoldot] Creating smoldot via start() (current thread)");
  smoldotInstance = startSmoldotDirect({
    maxLogLevel: 5,
    logCallback: smoldotLogCallback,
    // Smoldot's own auto-detection (no-auto-bytecode-browser.js) is buggy
    // and never sets this in browsers, so peer-gossipped `ws://[ip]` addrs
    // get attempted and tripped by the browser's mixed-content rules. They
    // are either blocked (public) or surfaced as deprecation warnings
    // (link-local), and either way the page is demoted from secure context
    // (which breaks SW registration).
    forbidNonLocalWs: true,
  });
  log.warn("[dot.li smoldot] Smoldot client ready (direct mode)");
  return smoldotInstance;
}

export function getSmoldot(): SmoldotClient {
  if (smoldotInstance !== null) {
    return smoldotInstance;
  }
  log.warn("[dot.li smoldot] Creating smoldot via startFromWorker()");
  smoldotInstance = startFromWorker(new SmWorker(), {
    maxLogLevel: 5,
    logCallback: smoldotLogCallback,
    forbidNonLocalWs: true,
  });
  return smoldotInstance;
}

/**
 * Tear down every cached singleton bound to the shared smoldot instance.
 *
 * When smoldot itself is terminated (user switched chain backend, panic
 * broadcast, etc.) every chain promise we had cached is pointing at a
 * dead `SmoldotChain`. If any of them survive, the next call to e.g.
 * `getBulletinChain()` would return a promise that resolves to a chain
 * whose `sendJsonRpc` is a no-op, and the user would see a silent hang.
 * Clear them all atomically so the next access re-creates against the
 * freshly booted smoldot.
 */
export function terminateSmoldot(): void {
  if (smoldotInstance === null) {
    return;
  }
  log.warn("[dot.li smoldot] Terminating smoldot instance");
  try {
    void smoldotInstance.terminate();
    // eslint-disable-next-line no-restricted-syntax -- best-effort teardown: smoldot may already be dead (panic or prior terminate); surfacing the error would block the subsequent promise cleanup which is the important step here.
  } catch {
    /* already destroyed or crashed, safe to ignore */
  }
  teardownAllPersistence();
  smoldotInstance = null;
  relayChainPromise = null;
  resolverAssetHubPromise = null;
  assetHubProvider = null;
  dappAssetHubPromise = null;
  bulletinChainPromise = null;
  peopleChainPromise = null;
  customRelayChainPromise = null;
}

export function getRelayChain(): Promise<SmoldotChain> {
  // Clear the cached promise on rejection so the next call retries
  // against a fresh smoldot / chain-spec fetch instead of handing the
  // same dead rejection to every caller forever.
  relayChainPromise ??= Promise.all([
    getPaseoChainSpec(),
    loadChainDb(dbKeyFor("relay")),
  ])
    .then(([chainSpec, databaseContent]) => {
      const warm = databaseContent !== null;
      log.warn(
        `[dot.li smoldot] Adding relay chain (${warm ? "WARM" : "COLD"} start${warm ? `, ${String(databaseContent.length)} bytes` : ""})`,
      );
      m.breadcrumb("Adding relay chain", { warm: String(warm) });
      return getSmoldot().addChain({
        chainSpec,
        ...(databaseContent !== null ? { databaseContent } : {}),
      });
    })
    .then((chain) => attachPersistence("relay", chain))
    .catch((error: unknown) => {
      relayChainPromise = null;
      m.count(S.BOOTNODE_ERROR, { chain: "relay" });
      throw error;
    });
  return relayChainPromise;
}

// Long-lived singleton with no mutex conflict with Asset Hub.

let bulletinChainPromise: Promise<SmoldotChain> | null = null;

/**
 * Get or create the Bulletin Paseo parachain singleton.
 * Used for preimage submission via TransactionStorage.
 *
 * Rejections clear the cached promise so a subsequent call re-creates
 * the chain instead of permanently caching the failure.
 */
export function getBulletinChain(): Promise<SmoldotChain> {
  bulletinChainPromise ??= Promise.all([
    getRelayChain(),
    getBulletinPaseoChainSpec(),
    loadChainDb(dbKeyFor("bulletin")),
  ])
    .then(([relayChain, chainSpec, databaseContent]) => {
      const warm = databaseContent !== null;
      log.warn(
        `[dot.li smoldot] Adding Bulletin parachain (${warm ? "WARM" : "COLD"} start${warm ? `, ${String(databaseContent.length)} bytes` : ""})`,
      );
      m.breadcrumb("Adding Bulletin parachain", { warm: String(warm) });
      return getSmoldot().addChain({
        chainSpec,
        potentialRelayChains: [relayChain],
        ...(databaseContent !== null ? { databaseContent } : {}),
      });
    })
    .then((chain) => attachPersistence("bulletin", chain))
    .catch((error: unknown) => {
      bulletinChainPromise = null;
      m.count(S.BOOTNODE_ERROR, { chain: "bulletin" });
      throw error;
    });
  return bulletinChainPromise;
}

/**
 * Wrap a chain so `.remove()` is a no-op.
 * Used for shared singletons (e.g. bulletin chain) where a polkadot-api
 * client must not tear down the underlying chain on disconnect.
 */
export function makeNonRemovingChain(chain: SmoldotChain): SmoldotChain {
  return {
    sendJsonRpc: chain.sendJsonRpc.bind(chain),
    nextJsonRpcResponse: chain.nextJsonRpcResponse.bind(chain),
    jsonRpcResponses: chain.jsonRpcResponses,
    remove: () => {
      /* intentional no-op: chain is a shared singleton */
    },
  };
}

// Long-lived singleton used by the auth module for statement store
// operations via smoldot. The active chain spec follows the user's
// network selection (`@dotli/config/mode#getNetwork`) and is resolved
// inside `@dotli/resolver/chain-specs`.

import { SS_RELAY_CHAIN } from "@dotli/config/config";

let customRelayChainPromise: Promise<SmoldotChain> | null = null;
let peopleChainPromise: Promise<SmoldotChain> | null = null;

/**
 * Get or create the People Chain parachain singleton.
 * Enables the statement store protocol for P2P statement distribution.
 *
 * Both the custom-relay and people-chain promises clear themselves on
 * rejection so the failure isn't permanently cached across a live
 * session. The next access rebuilds against a fresh smoldot chain.
 */
export function getPeopleChain(): Promise<SmoldotChain> {
  if (peopleChainPromise !== null) {
    return peopleChainPromise;
  }

  const relayPromise =
    SS_RELAY_CHAIN !== undefined && SS_RELAY_CHAIN !== ""
      ? (customRelayChainPromise ??= Promise.all([
          getCustomRelayChainSpec(),
          loadChainDb(dbKeyFor("custom-relay")),
        ])
          .then(([spec, databaseContent]) => {
            const warm = databaseContent !== null;
            log.warn(
              `[dot.li smoldot] Adding custom relay chain (${warm ? "WARM" : "COLD"} start${warm ? `, ${String(databaseContent.length)} bytes` : ""})`,
            );
            m.breadcrumb("Adding custom relay chain", { warm: String(warm) });
            return getSmoldot().addChain({
              chainSpec: spec,
              ...(databaseContent !== null ? { databaseContent } : {}),
            });
          })
          .then((chain) => attachPersistence("custom-relay", chain))
          .catch((error: unknown) => {
            customRelayChainPromise = null;
            m.count(S.BOOTNODE_ERROR, { chain: "custom-relay" });
            throw error;
          }))
      : getRelayChain();

  peopleChainPromise = Promise.all([
    relayPromise,
    getPeopleChainSpec(),
    loadChainDb(dbKeyFor("people")),
  ])
    .then(([relayChain, chainSpec, databaseContent]) => {
      const warm = databaseContent !== null;
      log.warn(
        `[dot.li smoldot] Adding People parachain (${warm ? "WARM" : "COLD"} start${warm ? `, ${String(databaseContent.length)} bytes` : ""})`,
      );
      m.breadcrumb("Adding People parachain", { warm: String(warm) });
      return getSmoldot().addChain({
        chainSpec,
        potentialRelayChains: [relayChain],
        statementStore: { maxSeenStatements: 65536 },
        ...(databaseContent !== null ? { databaseContent } : {}),
      });
    })
    .then((chain) => attachPersistence("people", chain))
    .catch((error: unknown) => {
      peopleChainPromise = null;
      m.count(S.BOOTNODE_ERROR, { chain: "people" });
      throw error;
    });
  return peopleChainPromise;
}

let resolverAssetHubPromise: Promise<SmoldotChain> | null = null;
let assetHubProvider: JsonRpcProvider | null = null;

function createAssetHubChain(
  relay: Promise<SmoldotChain>,
): Promise<SmoldotChain> {
  const t0 = performance.now();
  return Promise.all([
    relay,
    getAssetHubPaseoChainSpec(),
    loadChainDb(dbKeyFor("asset-hub")),
  ])
    .then(([relayChain, chainSpec, databaseContent]) => {
      const warm = databaseContent !== null;
      log.warn(
        `[dot.li smoldot] Adding Asset Hub parachain (${warm ? "WARM" : "COLD"} start${warm ? `, ${String(databaseContent.length)} bytes` : ""})`,
      );
      m.breadcrumb("Adding Asset Hub parachain", { warm: String(warm) });
      return getSmoldot().addChain({
        chainSpec,
        potentialRelayChains: [relayChain],
        ...(databaseContent !== null ? { databaseContent } : {}),
      });
    })
    .then((chain) => attachPersistence("asset-hub", chain))
    .then((chain) => {
      m.measure(S.SMOLDOT_ASSET_HUB, performance.now() - t0);
      m.distribution(S.SMOLDOT_ASSET_HUB, performance.now() - t0);
      return chain;
    })
    .catch((error: unknown) => {
      m.count(S.BOOTNODE_ERROR, { chain: "asset-hub" });
      throw error;
    });
}

function getResolverAssetHubChain(): Promise<SmoldotChain> {
  resolverAssetHubPromise ??= createAssetHubChain(getRelayChain()).catch(
    (error: unknown) => {
      resolverAssetHubPromise = null;
      throw error;
    },
  );
  return resolverAssetHubPromise;
}

export function getResolverAssetHubProvider(): JsonRpcProvider {
  assetHubProvider ??= getSmProvider(() => getResolverAssetHubChain());
  return assetHubProvider;
}

// After the resolver finishes dotNS resolution, its chain can be released.
// dApp connections then use a FRESH chain that has no "announced blocks"
// history, avoiding smoldot's per-connection block deduplication.

let dappAssetHubPromise: Promise<SmoldotChain> | null = null;

/**
 * Release the resolver's Asset Hub chain so a fresh chain can be created
 * for dApp connections. After calling this, the resolver's polkadot-api
 * client is no longer usable (CID is already cached).
 */
export function releaseResolverAssetHubChain(): void {
  if (resolverAssetHubPromise === null) {
    return;
  }
  log.warn("[dot.li smoldot] Releasing resolver Asset Hub chain");
  teardownPersistence("asset-hub");
  void resolverAssetHubPromise
    .then((chain) => {
      chain.remove();
      log.warn("[dot.li smoldot] Resolver Asset Hub chain removed");
    })
    .catch(() => {
      /* already dead or not yet created */
    });
  resolverAssetHubPromise = null;
  assetHubProvider = null;
}

/**
 * Get or create a fresh Asset Hub chain for dApp connections.
 *
 * This chain is separate from the resolver's chain and has no
 * "announced blocks" history. Smoldot will send complete newBlock
 * events for all non-finalized blocks on new subscriptions.
 *
 * The returned chain wraps `remove()` to clear the cached promise,
 * so the next call creates a fresh chain. This is necessary because
 * `getSmProvider` calls `chain.remove()` on disconnect. Without
 * cache invalidation, subsequent providers would reference a
 * destroyed chain.
 */
export function getDappAssetHubChain(): Promise<SmoldotChain> {
  dappAssetHubPromise ??= createAssetHubChain(getRelayChain())
    .then((chain) => ({
      sendJsonRpc: chain.sendJsonRpc.bind(chain),
      nextJsonRpcResponse: chain.nextJsonRpcResponse.bind(chain),
      jsonRpcResponses: chain.jsonRpcResponses,
      remove() {
        dappAssetHubPromise = null;
        teardownPersistence("asset-hub");
        chain.remove();
      },
    }))
    .catch((error: unknown) => {
      dappAssetHubPromise = null;
      throw error;
    });
  return dappAssetHubPromise;
}

/**
 * Return a provider backed by the dApp's fresh Asset Hub chain.
 * Used by `createChainProvider()` for remote dApp connections.
 */
export function getDappAssetHubProvider(): JsonRpcProvider {
  return getSmProvider(() => getDappAssetHubChain());
}
