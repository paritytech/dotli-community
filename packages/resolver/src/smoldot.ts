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

/**
 * Lifecycle events emitted by smoldot's per-chain broadcaster over the
 * `lifecycle_unstable_follow` JSON-RPC subscription. Smoldot emits more
 * kinds (connecting, modeDecision, warpSyncProgress, warpSyncFinished,
 * stopped); this allowlist covers only what the loading UI consumes.
 */
export type LifecycleKind =
  | "firstPeer"
  | "bootstrapComplete"
  | "stalled"
  | "recovered";
const LIFECYCLE_KINDS: ReadonlySet<string> = new Set([
  "firstPeer",
  "bootstrapComplete",
  "stalled",
  "recovered",
]);
export interface LifecycleEvent {
  /** Logical chain key: "relay", "asset-hub", "bulletin", "people", "custom-relay". */
  chain: string;
  kind: LifecycleKind;
  /** Set on `stalled` (and `recovered` as `previously`): why sync stopped progressing. */
  reason?: string;
}

type LifecycleCallback = (event: LifecycleEvent) => void;
const lifecycleListeners = new Set<LifecycleCallback>();
// Latest event per (chain, kind), insertion-ordered. Bounded, so late
// subscribers replay at most kinds x chains events.
const lifecycleHistory = new Map<string, LifecycleEvent>();

/**
 * Subscribe to smoldot lifecycle events. Late subscribers receive the latest
 * event per chain and kind (snapshot-on-subscribe), then continue with live
 * events. Returns an unsubscribe function.
 */
export function onLifecycle(cb: LifecycleCallback): () => void {
  lifecycleListeners.add(cb);
  for (const event of lifecycleHistory.values()) {
    try {
      cb(event);
      // eslint-disable-next-line no-restricted-syntax -- defensive replay: one buggy late subscriber must not block registration.
    } catch {
      /* listener threw during replay */
    }
  }
  return () => {
    lifecycleListeners.delete(cb);
  };
}

function emitLifecycle(event: LifecycleEvent): void {
  // `stalled` and `recovered` describe one condition; keeping both in the
  // replay history would let a late subscriber end on the outdated half.
  if (event.kind === "stalled") {
    lifecycleHistory.delete(`${event.chain}:recovered`);
  } else if (event.kind === "recovered") {
    lifecycleHistory.delete(`${event.chain}:stalled`);
  }
  lifecycleHistory.set(`${event.chain}:${event.kind}`, event);
  for (const cb of lifecycleListeners) {
    try {
      cb(event);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one buggy subscriber must not block the broadcast.
    } catch {
      /* listener threw */
    }
  }
}

/** A chain's `system_health` sample, polled during bootstrap. */
export interface HealthEvent {
  /** Logical chain key, same namespace as `LifecycleEvent.chain`. */
  chain: string;
  peers: number;
  isSyncing: boolean;
}

type HealthCallback = (event: HealthEvent) => void;
const healthListeners = new Set<HealthCallback>();
const lastHealth = new Map<string, HealthEvent>();

/**
 * Subscribe to chain health samples. Late subscribers receive the last known
 * sample per chain, then live changes. Returns an unsubscribe function.
 */
export function onHealth(cb: HealthCallback): () => void {
  healthListeners.add(cb);
  for (const event of lastHealth.values()) {
    try {
      cb(event);
      // eslint-disable-next-line no-restricted-syntax -- defensive replay: one buggy late subscriber must not block registration.
    } catch {
      /* listener threw during replay */
    }
  }
  return () => {
    healthListeners.delete(cb);
  };
}

function emitHealth(event: HealthEvent): void {
  const prev = lastHealth.get(event.chain);
  if (prev?.peers === event.peers && prev.isSyncing === event.isSyncing) {
    return;
  }
  lastHealth.set(event.chain, event);
  for (const cb of healthListeners) {
    try {
      cb(event);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one buggy subscriber must not block the broadcast.
    } catch {
      /* listener threw */
    }
  }
}

// Health polling is opt-in per process. The protocol iframe's direct mode
// enables it; the SharedWorker never does, so its long-lived smoldot does
// not poll for a UI that cannot observe it.
let healthPollingEnabled = false;

export function enableHealthPolling(): void {
  healthPollingEnabled = true;
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
// cannot collide with the numeric ids polkadot-api uses, and so responses
// can be recognized in the log stream. The suffix after ":" is the logical
// chain key, which is how responses are attributed to chains without
// relying on smoldot's internal chain id.
const LIFECYCLE_FOLLOW_REQUEST_ID = "__dotli_lifecycle_follow__";
const HEALTH_REQUEST_ID = "__dotli_health__";

// smoldot's log target is `json-rpc-<chain id from the chain spec>`, while
// requests are attributed by our logical keys ("relay", "asset-hub", ...).
// The reply to our follow request carries the logical key in its id and
// arrives on the chain's log target, which lets us learn the mapping
// without hardcoding chain-spec ids per network.
const chainKeyByLogName = new Map<string, string>();

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

  // Lifecycle and health payloads flow through the chain's JSON-RPC pipe,
  // which is owned by polkadot-api. Rather than wrap the chain and race for
  // messages, we observe the payloads passing through smoldot's own debug
  // log stream: every response is logged on the `json-rpc-<chain>` target
  // as `json-rpc-response-yielded; response=<json, truncated at 250 chars>`.
  // We match schemas we ourselves define (our reserved request ids and the
  // followEvent notification), so this is a structured side-channel, not
  // prose scraping.
  if (
    target.startsWith("json-rpc-") &&
    (message.includes("lifecycle_unstable_followEvent") ||
      message.includes("__dotli_"))
  ) {
    handleSideChannelLine(target, message);
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

function handleSideChannelLine(target: string, message: string): void {
  // Smoldot emits the response JSON verbatim after a literal `response=`
  // key in the log line. Request echoes use `request=` and fall out here.
  const responseStart = message.indexOf("response=");
  if (responseStart === -1) {
    return;
  }
  const jsonPart = message.slice(responseStart + "response=".length);
  const logName = target.slice("json-rpc-".length);
  try {
    const parsed = JSON.parse(jsonPart) as {
      id?: string;
      method?: string;
      result?: unknown;
      params?: {
        result?: { kind?: string; reason?: string; previously?: string };
      };
    };
    if (parsed.method === "lifecycle_unstable_followEvent") {
      emitLifecycleNotification(logName, parsed.params?.result);
      return;
    }
    if (typeof parsed.id !== "string") {
      return;
    }
    if (parsed.id.startsWith(`${LIFECYCLE_FOLLOW_REQUEST_ID}:`)) {
      // Reply to our follow request: learn which logical chain owns this
      // log target so notifications (which carry no id) can be attributed.
      chainKeyByLogName.set(
        logName,
        parsed.id.slice(LIFECYCLE_FOLLOW_REQUEST_ID.length + 1),
      );
      return;
    }
    if (parsed.id.startsWith(`${HEALTH_REQUEST_ID}:`)) {
      handleHealthResponse(parsed.id, parsed.result);
    }
    // eslint-disable-next-line no-restricted-syntax -- best-effort parse of a smoldot debug log line: non-JSON or truncated payloads are expected and must not spam log.error.
  } catch {
    /* malformed or truncated response payload, skip */
  }
}

function emitLifecycleNotification(
  logName: string,
  result: { kind?: string; reason?: string; previously?: string } | undefined,
): void {
  const kind = result?.kind;
  if (kind === undefined || !LIFECYCLE_KINDS.has(kind)) {
    return;
  }
  const chain = chainKeyByLogName.get(logName) ?? logName;
  if (kind === "bootstrapComplete") {
    // The chain is usable; peer-count polling has served its purpose.
    healthPollers.get(chain)?.stop();
  }
  const reason =
    kind === "stalled"
      ? result?.reason
      : kind === "recovered"
        ? result?.previously
        : undefined;
  emitLifecycle({
    chain,
    kind: kind as LifecycleKind,
    ...(typeof reason === "string" ? { reason } : {}),
  });
}

function handleHealthResponse(id: string, result: unknown): void {
  const rest = id.slice(HEALTH_REQUEST_ID.length + 1);
  const chain = rest.slice(0, rest.lastIndexOf(":"));
  if (chain === "") {
    return;
  }
  healthPollers.get(chain)?.noteResponse();
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
  emitHealth({ chain, peers: health.peers, isSyncing: health.isSyncing });
}

let smoldotInstance: SmoldotClient | null = null;
let relayChainPromise: Promise<SmoldotChain> | null = null;

interface PersistenceEntry {
  tap: ChainDbTap;
  initialTimer: ReturnType<typeof setTimeout>;
  periodicTimer: ReturnType<typeof setInterval>;
  healthPoller: HealthPoller | null;
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
  persistence.set(chainName, {
    tap,
    initialTimer,
    periodicTimer,
    healthPoller: null,
  });
}

function teardownPersistence(chainName: string): void {
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
  chainName: string,
  underlying: SmoldotChain,
): SmoldotChain {
  teardownPersistence(chainName);
  const tap = tapChain(underlying);
  schedulePersistence(chainName, tap);
  // Fire the lifecycle subscription without wrapping the chain object.
  // Polkadot-api consumes `jsonRpcResponses` iteratively and interposing on
  // that path is racy. Notifications are read back from smoldot's own
  // json-rpc log stream instead (see handleSideChannelLine).
  attachLifecycleFollow(chainName, tap.chain);
  if (healthPollingEnabled) {
    const entry = persistence.get(chainName);
    if (entry !== undefined) {
      entry.healthPoller = startHealthPolling(chainName, tap);
    }
  }
  return tap.chain;
}

function attachLifecycleFollow(chainName: string, chain: SmoldotChain): void {
  try {
    chain.sendJsonRpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `${LIFECYCLE_FOLLOW_REQUEST_ID}:${chainName}`,
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
const healthPollers = new Map<string, HealthPoller>();

const HEALTH_POLL_INTERVAL_MS = 1_000;
const HEALTH_POLL_TIMEOUT_MS = 2_000;
const HEALTH_POLL_MAX = 120;

let healthWatchdogArmed = false;
let healthResponseSeen = false;

/**
 * Poll `system_health` on a chain's JSON-RPC pipe during bootstrap so the
 * loading UI can show a live peer count. Sequential by design: the next
 * poll goes out one interval after the previous response is observed in
 * the log stream, so a busy chain is never flooded; a 2s timeout resends
 * when a response never surfaces. Stops on `bootstrapComplete` for the
 * chain (see emitLifecycleNotification), chain teardown, a dead chain, or
 * a hard poll cap.
 */
function startHealthPolling(chainName: string, tap: ChainDbTap): HealthPoller {
  let stopped = false;
  let polls = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    healthPollers.delete(chainName);
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
          id: `${HEALTH_REQUEST_ID}:${chainName}:${String(polls)}`,
          method: "system_health",
          params: [],
        }),
      );
    } catch {
      // The chain was destroyed under us (terminate/remove); polling is
      // best-effort and simply ends.
      stop();
      return;
    }
    schedule(HEALTH_POLL_TIMEOUT_MS);
  };

  const noteResponse = (): void => {
    healthResponseSeen = true;
    if (stopped) {
      return;
    }
    schedule(HEALTH_POLL_INTERVAL_MS);
  };

  // The side-channel depends on smoldot's debug log format staying stable.
  // If it breaks, lifecycle and health both go silently dead, so surface
  // one warning per session when the first poll gets no observable reply.
  if (!healthWatchdogArmed) {
    healthWatchdogArmed = true;
    const watchdog = setTimeout(() => {
      if (!healthResponseSeen) {
        log.warn(
          "[dot.li smoldot] health side-channel not observed within 5s; loading detail will not update",
        );
      }
    }, 5_000);
    unrefHandle(watchdog);
  }

  const poller = { stop, noteResponse };
  healthPollers.set(chainName, poller);
  // Poll immediately: on a warm start the chain bootstraps in well under a
  // second and a delayed first poll would never produce a sample.
  send();
  return poller;
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
    // Lifecycle detection reads JSON-RPC payloads out of the debug log
    // stream (parseAndEmitLifecycle). Lowering this level silently
    // disables lifecycle events.
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
    // Lifecycle detection reads JSON-RPC payloads out of the debug log
    // stream (parseAndEmitLifecycle). Lowering this level silently
    // disables lifecycle events.
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
  // The next smoldot instance re-learns chain identities and re-emits its
  // own lifecycle; stale mappings or replayed events from the dead session
  // would mislabel or suppress the new one's signals.
  chainKeyByLogName.clear();
  lifecycleHistory.clear();
  lastHealth.clear();
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
