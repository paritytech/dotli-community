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
  type TapIntercept,
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

/** The chains the resolver runs, named by role rather than by chain spec. */
export const CHAIN_KEYS = [
  "relay",
  "custom-relay",
  "asset-hub",
  "bulletin",
  "people",
] as const;
export type ChainKey = (typeof CHAIN_KEYS)[number];

/**
 * What a chain reports about its own sync.
 *
 * Smoldot emits two more milestones (modeDecision and stopped) that the
 * loading UI has nothing to say about. `peers` is our own addition, sampled
 * while the chain bootstraps rather than reported by smoldot.
 *
 * `warpSyncProgress` is the only true percentage in here, and it only
 * arrives when a relay has a real warp distance to cover. Short-lived test
 * networks jump straight to `warpSyncFinished`.
 */
export const CHAIN_SYNC_KINDS = [
  "firstPeer",
  "bootstrapComplete",
  "stalled",
  "recovered",
  "peers",
  "connecting",
  "warpSyncProgress",
  "warpSyncFinished",
] as const;
export type ChainSyncKind = (typeof CHAIN_SYNC_KINDS)[number];

function isSyncKind(kind: string): kind is ChainSyncKind {
  return (CHAIN_SYNC_KINDS as readonly string[]).includes(kind);
}

export interface ChainSyncEvent {
  chain: ChainKey;
  kind: ChainSyncKind;
  /** Why sync stopped progressing, on `stalled` and `recovered`. */
  reason?: string;
  /** Peer count, on `peers`. */
  peers?: number;
  /** Whether the chain is still catching up, on `peers`. */
  isSyncing?: boolean;
  /** Block the warp has proven so far, on `warpSyncProgress`. */
  at?: number;
  /** Block the warp is heading for, on `warpSyncProgress`. */
  target?: number;
  /** Block the warp settled on, on `warpSyncFinished`. */
  finalized?: number;
}

type SyncCallback = (event: ChainSyncEvent) => void;
const syncListeners = new Set<SyncCallback>();
// Latest event per chain and kind, insertion-ordered. Bounded, so late
// subscribers replay at most kinds x chains events.
const syncHistory = new Map<string, ChainSyncEvent>();

/**
 * Subscribe to what the chains report about their sync.
 *
 * Late subscribers first receive the latest event per chain and kind, then
 * continue with live ones, so a listener that attaches mid-sync still knows
 * where each chain stands. Returns an unsubscribe function.
 */
export function onChainSync(cb: SyncCallback): () => void {
  syncListeners.add(cb);
  for (const event of syncHistory.values()) {
    try {
      cb(event);
      // eslint-disable-next-line no-restricted-syntax -- defensive replay: one buggy late subscriber must not block registration.
    } catch {
      /* listener threw during replay */
    }
  }
  return () => {
    syncListeners.delete(cb);
  };
}

function emitChainSync(event: ChainSyncEvent): void {
  if (event.kind === "peers") {
    // Repeating an unchanged count would wake every listener once a second
    // for nothing.
    const prev = syncHistory.get(`${event.chain}:peers`);
    if (prev !== undefined && prev.peers === event.peers) {
      return;
    }
  } else if (event.kind === "stalled") {
    // `stalled` and `recovered` describe one condition. Keeping both in the
    // replay history would let a late subscriber end on the outdated half.
    syncHistory.delete(`${event.chain}:recovered`);
  } else if (event.kind === "recovered") {
    syncHistory.delete(`${event.chain}:stalled`);
  }
  syncHistory.set(`${event.chain}:${event.kind}`, event);
  for (const cb of syncListeners) {
    try {
      cb(event);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one buggy subscriber must not block the broadcast.
    } catch {
      /* listener threw */
    }
  }
}

/** Which chains report sync, and which of those are sampled for peers. */
export interface SyncReportingConfig {
  milestones: readonly ChainKey[];
  peerCounts: readonly ChainKey[];
}

// Sync reporting is opt-in per process and per chain, because it costs a
// subscription plus an interceptor on every response the chain yields. The
// protocol iframe's direct mode enables it for the chains its loading
// screen actually shows. The SharedWorker never does, so its long-lived
// smoldot does no work for a UI that cannot observe it.
const milestoneChains = new Set<ChainKey>();
const peerCountChains = new Set<ChainKey>();

export function enableSyncReporting(config: SyncReportingConfig): void {
  for (const chain of config.milestones) {
    milestoneChains.add(chain);
  }
  for (const chain of config.peerCounts) {
    peerCountChains.add(chain);
    // A peer count is useless without the milestone that ends it.
    milestoneChains.add(chain);
  }
}

// Smoldot's WASM can panic (e.g., the "Option::unwrap() on a None value"
// crash during relay-chain sync). A panic leaves every chain dead, and any
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

// Reserved id prefixes for our internal JSON-RPC requests. Chosen so they
// cannot collide with the numeric ids polkadot-api uses, and so the chain
// tap can recognize and consume the responses before they reach
// polkadot-api's provider.
const FOLLOW_ID_PREFIX = "__dotli_lifecycle_follow__:";
const HEALTH_ID_PREFIX = "__dotli_health__:";

// Subscription id of each chain's `lifecycle_unstable_follow`, learned from
// the follow reply. Notifications carry no request id, so this is how the
// tap tells our subscription's events apart from any other traffic.
const followSubscriptions = new Map<ChainKey, string>();

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

  // Only warnings and errors describe a problem. Everything below that is
  // smoldot's structured operational logging, and the patterns below match
  // substrings anywhere in a line, including inside key-value payloads. A
  // successful `handshake-finished` matched "handshake", a routine
  // `connection-activity` matched "closed" through its `write_closed=`
  // field, and `foreground-runtime-call-start` matched too. All three
  // reached the user as "Bootnode connection issue, <200 chars of smoldot
  // internals>" in the loading headline on a normal cold start.
  if (level > 2) {
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

/**
 * Build the tap interceptor that claims one chain's sync traffic.
 *
 * It runs inside the chain tap's pump, so it sees every response in order
 * and untruncated, and it consumes our reserved-id traffic before
 * polkadot-api's provider can see it.
 */
function makeSideChannelIntercept(chain: ChainKey): TapIntercept {
  return (parsed) => {
    if (typeof parsed.id === "string") {
      if (parsed.id.startsWith(FOLLOW_ID_PREFIX)) {
        // Reply to our follow request: remember the subscription id so
        // notifications (which carry no request id) can be matched below.
        if (typeof parsed.result === "string") {
          followSubscriptions.set(chain, parsed.result);
        }
        return true;
      }
      if (parsed.id.startsWith(HEALTH_ID_PREFIX)) {
        handleHealthResponse(chain, parsed.result);
        return true;
      }
      return false;
    }
    if (parsed.method === "lifecycle_unstable_followEvent") {
      const params = parsed.params as
        | {
            subscription?: unknown;
            result?: { kind?: string; reason?: string; previously?: string };
          }
        | undefined;
      // The follow reply always precedes its notifications, so an unknown
      // subscription id means the event belongs to someone else: forward it.
      const subscription = followSubscriptions.get(chain);
      if (
        params === undefined ||
        subscription === undefined ||
        params.subscription !== subscription
      ) {
        return false;
      }
      emitMilestone(chain, params.result);
      return true;
    }
    return false;
  };
}

function emitMilestone(
  chain: ChainKey,
  result: { kind?: string; reason?: string; previously?: string } | undefined,
): void {
  const kind = result?.kind;
  if (kind === undefined || kind === "peers" || !isSyncKind(kind)) {
    return;
  }
  if (kind === "bootstrapComplete") {
    // The chain is usable, so peer-count polling has served its purpose.
    persistence.get(chain)?.healthPoller?.stop();
  }
  const reason = kind === "stalled" ? result?.reason : result?.previously;
  const heights = result as unknown as Record<string, unknown>;
  emitChainSync({
    chain,
    kind,
    ...(typeof reason === "string" ? { reason } : {}),
    ...(typeof heights.at === "number" ? { at: heights.at } : {}),
    ...(typeof heights.target === "number" ? { target: heights.target } : {}),
    ...(typeof heights.finalized === "number"
      ? { finalized: heights.finalized }
      : {}),
  });
}

function handleHealthResponse(chain: ChainKey, result: unknown): void {
  healthResponseSeen = true;
  persistence.get(chain)?.healthPoller?.noteResponse();
  const health = result as { peers?: unknown; isSyncing?: unknown } | null;
  if (
    health === null ||
    typeof health !== "object" ||
    typeof health.peers !== "number" ||
    !Number.isInteger(health.peers) ||
    health.peers < 0 ||
    typeof health.isSyncing !== "boolean"
  ) {
    return;
  }
  emitChainSync({
    chain,
    kind: "peers",
    peers: health.peers,
    isSyncing: health.isSyncing,
  });
}

let smoldotInstance: SmoldotClient | null = null;
let relayChainPromise: Promise<SmoldotChain> | null = null;

interface PersistenceEntry {
  tap: ChainDbTap;
  initialTimer: ReturnType<typeof setTimeout>;
  periodicTimer: ReturnType<typeof setInterval>;
  healthPoller: HealthPoller | null;
}
const persistence = new Map<ChainKey, PersistenceEntry>();

function dbKeyFor(chainName: ChainKey): string {
  return `${getNetwork()}:${chainName}`;
}

function unrefHandle(handle: ReturnType<typeof setTimeout>): void {
  // Node-only no-op in browsers, lets vitest exit instead of hanging on timers.
  const h = handle as unknown as { unref?: () => void };
  if (typeof h.unref === "function") {
    h.unref();
  }
}

function schedulePersistence(chainName: ChainKey, tap: ChainDbTap): void {
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
  persistence.set(chainName, {
    tap,
    initialTimer,
    periodicTimer,
    healthPoller: null,
  });
}

function teardownPersistence(chainName: ChainKey): void {
  const entry = persistence.get(chainName);
  if (entry === undefined) {
    return;
  }
  clearTimeout(entry.initialTimer);
  clearInterval(entry.periodicTimer);
  entry.healthPoller?.stop();
  entry.tap.stop();
  persistence.delete(chainName);
}

function teardownAllPersistence(): void {
  for (const name of [...persistence.keys()]) {
    teardownPersistence(name);
  }
}

function attachPersistence(
  chainName: ChainKey,
  underlying: SmoldotChain,
): SmoldotChain {
  teardownPersistence(chainName);
  // Reporting costs an interceptor on every response this chain yields, so
  // chains nobody watches are tapped for persistence alone. When it is on,
  // the interceptor consumes our reserved-id traffic in-band, leaving
  // polkadot-api's provider with only its own requests and subscriptions.
  const reports = milestoneChains.has(chainName);
  const tap = tapChain(
    underlying,
    reports ? makeSideChannelIntercept(chainName) : undefined,
  );
  schedulePersistence(chainName, tap);
  if (reports) {
    followMilestones(chainName, tap.chain);
  }
  if (peerCountChains.has(chainName)) {
    const entry = persistence.get(chainName);
    if (entry !== undefined) {
      entry.healthPoller = startHealthPolling(chainName, tap);
    }
  }
  return tap.chain;
}

function followMilestones(chainName: ChainKey, chain: SmoldotChain): void {
  try {
    chain.sendJsonRpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `${FOLLOW_ID_PREFIX}${chainName}`,
        method: "lifecycle_unstable_follow",
        params: [],
      }),
    );
  } catch (err: unknown) {
    log.warn(
      `[dot.li smoldot] lifecycle follow send failed for ${chainName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface HealthPoller {
  stop(): void;
  noteResponse(): void;
}

const HEALTH_POLL_INTERVAL_MS = 1_000;
const HEALTH_POLL_TIMEOUT_MS = 2_000;
const HEALTH_POLL_MAX = 120;

let healthResponseSeen = false;

/**
 * Warn once per session if our reserved-id requests go unanswered.
 *
 * The whole side-channel depends on smoldot replying to them. If a smoldot
 * bump breaks that, milestones and peer counts both go silently dead.
 */
const armSideChannelWatchdog = (() => {
  let armed = false;
  return (): void => {
    if (armed) {
      return;
    }
    armed = true;
    const watchdog = setTimeout(() => {
      if (!healthResponseSeen) {
        log.warn(
          "[dot.li smoldot] sync side-channel not observed within 5s, loading detail will not update",
        );
      }
    }, 5_000);
    unrefHandle(watchdog);
  };
})();

/**
 * Poll `system_health` during bootstrap so the UI can show a live peer count.
 *
 * Polling is sequential by design. The next poll goes out one interval
 * after the previous response arrives, so a busy chain is never flooded,
 * and a 2s timeout resends when a response never surfaces. Stops on
 * `bootstrapComplete` for the chain (see `emitMilestone`), chain teardown,
 * a dead chain, or a hard poll cap.
 */
function startHealthPolling(chain: ChainKey, tap: ChainDbTap): HealthPoller {
  let stopped = false;
  let polls = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number): void => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(send, delayMs);
    unrefHandle(timer);
  };

  const send = (): void => {
    if (stopped) {
      return;
    }
    if (tap.isStopped() || polls >= HEALTH_POLL_MAX) {
      stop();
      return;
    }
    polls += 1;
    try {
      tap.chain.sendJsonRpc(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `${HEALTH_ID_PREFIX}${chain}:${String(polls)}`,
          method: "system_health",
          params: [],
        }),
      );
    } catch {
      // The chain was destroyed under us by a terminate or a remove.
      // Polling is best-effort and simply ends.
      stop();
      return;
    }
    schedule(HEALTH_POLL_TIMEOUT_MS);
  };

  const noteResponse = (): void => {
    if (stopped) {
      return;
    }
    schedule(HEALTH_POLL_INTERVAL_MS);
  };

  armSideChannelWatchdog();
  // Poll immediately: on a warm start the chain bootstraps in well under a
  // second and a delayed first poll would never produce a sample.
  send();
  return { stop, noteResponse };
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
    // smoldot 3.3.1 advertises WebRTC even though `RTCPeerConnection` is
    // unavailable in worker scopes. Dialing a discovered `/webrtc-direct/`
    // peer then throws through WASM and leaves the client unusable.
    // Remove this workaround once the upstream fix is released:
    // https://github.com/paritytech/smoldot/pull/3303
    forbidWebRtc: true,
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
  // The next smoldot instance re-subscribes and re-emits its own
  // lifecycle. Stale subscription ids or replayed events from the dead
  // session would mislabel or suppress the new one's signals.
  followSubscriptions.clear();
  syncHistory.clear();
  smoldotInstance = null;
  relayChainPromise = null;
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

// The single Asset Hub chain, shared by the resolver and all dApp sessions
// via the broker (one follow, never removed mid-read).
let dappAssetHubPromise: Promise<SmoldotChain> | null = null;

/**
 * Get or create the shared Asset Hub chain.
 *
 * The wrapped `remove()` clears the cached promise so the next call creates a
 * fresh chain — `getSmProvider` calls `chain.remove()` on disconnect, and
 * without this subsequent providers would reference a destroyed chain.
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
