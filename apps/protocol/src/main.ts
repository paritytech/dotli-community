// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Protocol host entry point.
//
// Three modes, selected explicitly via the `?mode=` URL parameter:
//   1. "shared-worker": one iframe is elected leader (Web Locks) and runs
//      smoldot on its own Window main thread — so WebRTC is available — while
//      the SharedWorker routes every other tab's requests to it. Failover is
//      automatic when the leader's tab goes away. See `initLeaderIframeMode`.
//   2. "direct": smoldot runs in this iframe with no cross-tab coordination.
//   3. "rpc": trusted WSS JSON-RPC to a public node (no smoldot), used by
//      gateway mode to bridge sandboxed-app chain calls.

import {
  initSentry,
  installGlobalErrorHandlers,
  captureException,
} from "@dotli/metrics/sentry";

// Do NOT silently reload on chunk preload failure. The protocol iframe is
// hidden and has no UI of its own, so it surfaces the failure to the parent
// via the standard error envelope. The parent will render the user-facing
// error.
window.addEventListener("vite:preloadError", (event) => {
  const evt = event as unknown as { payload?: unknown };
  captureException(evt.payload ?? new Error("vite:preloadError"), {
    kind: "chunk_preload_error",
    surface: "protocol_iframe",
  });
  if (window.parent !== window) {
    const msg =
      evt.payload instanceof Error
        ? evt.payload.message
        : "Asset failed to load";
    window.parent.postMessage(
      {
        namespace: "dotli:protocol",
        kind: "fatal",
        message: `Protocol iframe asset failed to load: ${msg}`,
      } as const,
      "*",
    );
  }
});
import type { JsonRpcProvider } from "@polkadot-api/json-rpc-provider";
import type { StringJsonRpcConnection } from "@dotli/protocol/broker";
import type {
  ExecutableManifest,
  ManifestResult,
  RootManifest,
} from "@dotli/resolver/manifest";
import { isExecutableKind } from "@dotli/shared/executables";
import {
  MAX_CONNECTIONS_PER_ORIGIN,
  SITE_ID,
  type SiteId,
} from "@dotli/config/config";
import {
  getActiveServicesConfig,
  isValidNetwork,
  setNetworkOverride,
  type Network,
} from "@dotli/config/network";
// Smoldot, relay-chain, and dot-name resolver imports live behind
// `initDirectMode()` (dynamic) so `rpc` mode doesn't drag smoldot into the
// protocol iframe's initial chunk. The SharedWorker path doesn't import
// these either. Smoldot for shared-worker mode lives inside
// `./protocol-shared-worker.ts`, which is already a separate bundle.
import {
  createRpcChainProvider,
  isRpcChainSupported,
} from "@dotli/resolver/rpc-chain";
import { log } from "@dotli/shared/log";
import { serializeError } from "@dotli/shared/errors";
import {
  createChainBrokerManager,
  requireBrokerLocalProvider,
  type ChainBrokerManager,
} from "@dotli/protocol/broker";
import {
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  hasStoredSharedAuthSession,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isValidSharedAuthKey,
  isValidSharedModeKey,
  SHARED_AUTH_SESSION_KEY,
} from "@dotli/protocol/auth-storage";
import {
  isProtocolEnvelope,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
} from "@dotli/protocol/messages";
import type {
  SWRelayRequest,
  SWRelayResponse,
  SWOutbound,
  SWError,
  SWLeaderClaiming,
  SWLeaderReady,
  SWLeaderError,
  SWLeaderForward,
  SWLeaderResponse,
  SWClientGone,
  SWDisconnect,
} from "./protocol-shared-worker";

initSentry("host");
installGlobalErrorHandlers("host");

import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

// Same trust set as shared auth: host shell plus non-sandbox *.<BASE>, but NOT
// app.<BASE> or *.app.<BASE>. A user-uploaded CID app must never drive the
// chain bridge directly. It goes through the host shell, which relays on
// its behalf. Centralizing on `isSharedAuthOriginAllowed` keeps the two
// allowlists in lockstep.
function isAllowedOrigin(origin: string): boolean {
  return isSharedAuthOriginAllowed(origin);
}

function postToSource(
  source: MessageEventSource | null,
  origin: string,
  message: ProtocolEnvelope,
): void {
  if (!source) {
    return;
  }
  (source as Window).postMessage(message, origin);
}

// The shared-auth path is intentionally handled on the host window (not in the
// SharedWorker) because it only needs `localStorage`, no smoldot and no chain.
// Each tab embeds its own host iframe, so when tab A writes a session, tab B's
// adapter subscribers need to be notified. We bridge tabs with a
// `BroadcastChannel` scoped to the host origin:
//
//   1. Tab A's host iframe receives an `authStorageWrite` request from its
//      parent and writes to localStorage.
//   2. Tab A's host iframe posts `{ siteId, key, value }` on the
//      `dotli:shared-auth` BroadcastChannel.
//   3. Tab B's host iframe (different window, same origin) receives the
//      broadcast and forwards it to *its* parent window via `postMessage` as
//      an `auth-storage-changed` envelope.
//   4. The parent window's protocol client dispatches to local subscribers.
//
// The originating tab does NOT receive its own BroadcastChannel message, so
// tab A's local subscribers fire via the in-process `emit` in
// `createSharedAuthStorageAdapter`'s `.map(() => emit(...))` chain. There is
// no double-dispatch.

const SHARED_AUTH_BROADCAST_CHANNEL = "dotli:shared-auth";

interface SharedAuthBroadcastMessage {
  siteId: SiteId;
  key: string;
  value: string | null;
}

const sharedAuthChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(SHARED_AUTH_BROADCAST_CHANNEL)
    : null;

// The origin of the parent window embedding this host iframe. Populated from
// `document.referrer` at module load (best-effort, may be blank under strict
// referrer policies) and refreshed on every validated shared-auth request.
// Broadcasts are only forwarded to the parent when we know its origin, so
// unrelated embedders never receive a shared-auth change notification.
let parentOrigin: string | null = initialParentOriginFromReferrer();

function initialParentOriginFromReferrer(): string | null {
  try {
    const ref = document.referrer;
    if (ref === "") {
      return null;
    }
    const origin = new URL(ref).origin;
    return isAllowedOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

function broadcastSharedAuthChange(
  siteId: SiteId,
  key: string,
  value: string | null,
): void {
  if (sharedAuthChannel === null) {
    return;
  }
  try {
    const msg: SharedAuthBroadcastMessage = { siteId, key, value };
    sharedAuthChannel.postMessage(msg);
  } catch (error: unknown) {
    log.warn("[dot.li protocol] Shared auth broadcast failed:", error);
  }
}

function isSharedAuthBroadcastMessage(
  value: unknown,
): value is SharedAuthBroadcastMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as {
    siteId?: unknown;
    key?: unknown;
    value?: unknown;
  };
  return (
    typeof obj.siteId === "string" &&
    typeof obj.key === "string" &&
    (obj.value === null || typeof obj.value === "string")
  );
}

function bindSharedAuthBroadcastRelay(): void {
  if (sharedAuthChannel === null) {
    return;
  }
  sharedAuthChannel.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isSharedAuthBroadcastMessage(data)) {
      return;
    }
    // Only the current host's SiteId is valid (see `isSharedAuthSiteId`). We
    // still defensively filter here so stale broadcasts from a different
    // root domain (which shouldn't happen, the channel is origin-scoped)
    // cannot leak across trust boundaries.
    if (data.siteId !== SITE_ID) {
      return;
    }
    if (parentOrigin === null || window.parent === window) {
      return;
    }
    try {
      window.parent.postMessage(
        {
          namespace: "dotli:protocol",
          kind: "auth-storage-changed",
          siteId: data.siteId,
          key: data.key,
          value: data.value,
        } as const,
        parentOrigin,
      );
    } catch (error: unknown) {
      log.warn(
        "[dot.li protocol] Failed to forward shared auth change to parent:",
        error,
      );
    }
  });
}

type SharedStore = "auth" | "mode";
type SharedRejectReason = "origin" | "validation";

function countSharedReject(
  store: SharedStore,
  reason: SharedRejectReason,
): void {
  m.count(S.SHARED_STORAGE_REJECTED, { store, reason });
}

function bindSharedAuthListener(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      !isProtocolEnvelope(data) ||
      data.kind !== "request" ||
      !isSharedAuthRequestMethod(data.method)
    ) {
      return;
    }
    // First gate: the broad protocol origin allowlist (`*.<BASE_DOMAIN>` plus
    // localhost). The narrower shared-auth allowlist, which additionally
    // rejects `app.<BASE_DOMAIN>` and sandboxed SPA subdomains, runs inside
    // `handleSharedAuthRequest` via `assertSharedAuthOrigin`.
    if (!isAllowedOrigin(event.origin)) {
      log.warn(
        `[dot.li protocol] Rejected shared-auth request from disallowed origin: ${event.origin}`,
      );
      countSharedReject("auth", "origin");
      return;
    }
    // Remember the parent origin so cross-tab broadcast forwards target a
    // known origin rather than `*`. This runs on every request, not just the
    // first, so we tolerate (unlikely) parent navigations that replace the
    // embedding page.
    parentOrigin = event.origin;

    try {
      handleSharedAuthRequest(data, event.origin, (response) => {
        postToSource(event.source, event.origin, response);
      });
    } catch (error: unknown) {
      countSharedReject("auth", "validation");
      postToSource(event.source, event.origin, {
        namespace: "dotli:protocol",
        kind: "response",
        id: data.id,
        ok: false,
        error: serializeError(error),
      });
    }
  });
}

function signalReady(): void {
  if (window.parent !== window) {
    window.parent.postMessage(
      { namespace: "dotli:protocol", kind: "ready" } as const,
      "*",
    );
  }
}

type RequestedMode = "shared-worker" | "direct" | "rpc" | null;

/**
 * Distinguish "no mode requested" (auth-only iframe, legitimate) from
 * "mode requested but unrecognized" (host bug or URL-tampering, which must
 * surface to the parent so the user sees a real error instead of a silent
 * downgrade to auth-only behavior).
 */
function getRequestedMode(): RequestedMode | "invalid" {
  let raw: string | null;
  try {
    raw = new URLSearchParams(window.location.search).get("mode");
  } catch {
    return "invalid";
  }
  if (raw === null) {
    return null;
  }
  if (raw === "shared-worker" || raw === "direct" || raw === "rpc") {
    return raw;
  }
  return "invalid";
}

function getSkipWorkerCache(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("skipWorkerCache") === "1";
  } catch {
    return false;
  }
}

type RequestedNetwork =
  | { kind: "ok"; network: Network }
  | { kind: "missing" }
  | { kind: "invalid"; raw: string };

/**
 * The protocol iframe runs on a different origin than the host shell and
 * cannot read the host's `dotli:network` from `localStorage`.
 */
function getRequestedNetwork(): RequestedNetwork {
  let raw: string | null;
  try {
    raw = new URLSearchParams(window.location.search).get("network");
  } catch {
    return { kind: "invalid", raw: "<unparseable>" };
  }
  if (raw === null) {
    return { kind: "missing" };
  }
  if (isValidNetwork(raw)) {
    return { kind: "ok", network: raw };
  }
  return { kind: "invalid", raw };
}

/**
 * Purge every IndexedDB on this origin that isn't one of ours. Covers
 * smoldot's internal chain DB and polkadot-api's caches, anything persisted
 * across page loads that could warm-start the runtime. The dot.li-owned
 * stores (`dotli`, `dotli-sw`) are preserved because they hold user state
 * (CID cache, shared auth), which is orthogonal to worker bootstrapping.
 *
 * Best-effort: some browsers don't expose `indexedDB.databases()` (Firefox
 * historically, Safari pre-17). On those, the skip still takes effect for
 * future writes but we can't proactively clear prior state.
 */
async function purgeWorkerCaches(): Promise<void> {
  // Throw on enumeration failure and await each delete: a silent log-and-
  // continue would let smoldot boot against the still-present stale DB.
  const KEEP = new Set(["dotli", "dotli-sw"]);
  if (
    typeof indexedDB === "undefined" ||
    typeof indexedDB.databases !== "function"
  ) {
    throw new Error(
      "Browser does not expose indexedDB.databases() — cannot fully purge worker caches. " +
        "Please clear site data manually before retrying.",
    );
  }
  const dbs = await indexedDB.databases();
  const targets = dbs
    .map((db) => db.name)
    .filter(
      (name): name is string =>
        name !== undefined && name !== "" && !KEEP.has(name),
    );
  await Promise.all(
    targets.map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => {
            resolve();
          };
          req.onerror = () => {
            reject(
              new Error(
                `Failed to delete IDB ${name}: ${req.error?.name ?? "unknown"}`,
                req.error ? { cause: req.error } : undefined,
              ),
            );
          };
          req.onblocked = () => {
            reject(
              new Error(`Delete of IDB ${name} blocked by another connection`),
            );
          };
        }),
    ),
  );
  log.warn("[dot.li protocol] Purged worker caches (skipWorkerCache)");
}

async function init(): Promise<void> {
  const mode = getRequestedMode();

  if (mode === "invalid") {
    let raw: string | null = null;
    try {
      raw = new URLSearchParams(window.location.search).get("mode");
      // eslint-disable-next-line no-restricted-syntax -- best-effort extraction of the offending mode value for the error message; the error is already signalled below regardless.
    } catch {
      /* URL parse failed, fall through with raw=null */
    }
    const message = `Unknown protocol mode: ${raw === null ? "<unparseable>" : `"${raw}"`}`;
    log.error(`[dot.li protocol] ${message}`);
    signalError(message);
    return;
  }

  // When no mode is requested, the iframe is only serving shared auth
  // storage requests (localStorage). No chain provider needed.
  if (mode === null) {
    log.warn(
      "[dot.li protocol] No mode requested — auth-only iframe, skipping chain provider",
    );
    signalReady();
    return;
  }
  const requestedNetwork = getRequestedNetwork();
  if (requestedNetwork.kind === "invalid") {
    const message = `Unknown protocol network: "${requestedNetwork.raw}"`;
    log.error(`[dot.li protocol] ${message}`);
    signalError(message);
    return;
  }
  if (requestedNetwork.kind === "missing") {
    const message =
      "Missing required `network` URL param — host shell did not propagate the active network.";
    log.error(`[dot.li protocol] ${message}`);
    signalError(message);
    return;
  }
  setNetworkOverride(requestedNetwork.network);
  m.setDefaults({ network: requestedNetwork.network });
  log.warn(
    `[dot.li protocol] Active network pinned to ${requestedNetwork.network}`,
  );

  // Worker-cache purge runs *before* any broker/smoldot init so the clean
  // state is what the chain client opens against. A purge failure when the
  // user explicitly requested skipWorkerCache MUST abort init. Proceeding
  // against a stale DB would silently violate the user's setting.
  if (getSkipWorkerCache()) {
    try {
      await purgeWorkerCaches();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[dot.li protocol] purgeWorkerCaches failed:", err);
      signalError(`Failed to reset chain DB: ${message}`);
      return;
    }
  }

  const stopInit = m.timer(S.PROTOCOL_INIT);
  log.warn(`[dot.li protocol] Requested mode: ${mode}`);

  if (mode === "shared-worker") {
    if (typeof SharedWorker === "undefined") {
      const msg = "SharedWorker is not available in this browser";
      log.error(`[dot.li protocol] ${msg}`);
      signalError(msg);
      stopInit();
      return;
    }
    // Register protocol_mode as a session default before any further metrics
    // so bootnode errors, chain-connect failures etc. all carry the mode tag.
    // Values are kebab-case to match `DotliMode` and the `?mode=` URL
    // convention, keeping one naming scheme across host and protocol.
    m.setDefaults({ protocol_mode: "shared-worker" });
    await initLeaderIframeMode(requestedNetwork.network);
    m.count(S.PROTOCOL_MODE, { mode: "shared-worker" });
  } else if (mode === "rpc") {
    m.setDefaults({ protocol_mode: "rpc" });
    initRpcMode();
    m.count(S.PROTOCOL_MODE, { mode: "rpc" });
  } else {
    m.setDefaults({ protocol_mode: "direct" });
    await initDirectMode();
    m.count(S.PROTOCOL_MODE, { mode: "direct" });
  }

  stopInit();
}

function signalError(message: string): void {
  // `init-failed` is a dedicated envelope. It has no `id` because no
  // request was in flight when init died. The client listens for this
  // alongside `fatal`, rejects every pending request, and blocks new
  // work until the user reloads. The old `id: "__init__"` sentinel was
  // a collision hazard (any real request using that id would alias).
  if (window.parent !== window) {
    window.parent.postMessage(
      {
        namespace: "dotli:protocol",
        kind: "init-failed",
        message,
      } as const,
      "*",
    );
  }
}

// ---------------------------------------------------------------------------
// shared-worker backend = leader-elected iframe + SharedWorker router.
//
// smoldot runs in exactly ONE iframe (the "leader"), chosen via the Web Locks
// API, on that iframe's Window main thread so it can use WebRTC. Every other
// same-origin iframe is a "follower" that relays its parent tab's chain and
// resolve requests through the SharedWorker (a pure router — see
// ./protocol-shared-worker.ts) to the leader. The leader also serves its own
// parent tab directly. If the leader's tab closes/crashes, its Web Lock
// releases and a queued follower is promoted, warm-starting a fresh smoldot
// from the shared-origin IndexedDB.
// ---------------------------------------------------------------------------

async function initLeaderIframeMode(network: Network): Promise<void> {
  // One SharedWorker per network routes between all same-origin iframes. The
  // `new URL(...)` MUST stay a literal argument for Vite's worker rewrite
  // (assigning it to a variable breaks the static rewrite and 404s in prod).
  // Network travels via the worker name, read from `self.name` in the worker.
  const worker = new SharedWorker(
    new URL("./protocol-shared-worker.ts", import.meta.url),
    { type: "module", name: `dotli-protocol-${network}` },
  );
  const port = worker.port;
  worker.addEventListener("error", (event) => {
    log.error("[dot.li protocol] SharedWorker (router) error:", event);
    m.count(S.BOOTNODE_ERROR, { source: "shared-worker" });
  });
  // NOTE: `port.start()` is deliberately NOT called here. Each role
  // (`runAsLeader` / `runAsFollower`) attaches its message listener first and
  // then starts the port, so an early message from the router (e.g. `ready`)
  // is queued and delivered rather than dispatched to no listener.
  await electLeader(port, network);
}

/** Never resolves — held inside a Web Lock callback to keep the lock for this
 *  iframe's lifetime. The browser frees the lock when the tab is torn down,
 *  which is our failover trigger. */
function holdUntilUnload(): Promise<never> {
  return new Promise<never>(() => {
    /* held until this context is destroyed */
  });
}

/**
 * Elect a single leader across all same-origin iframes with the Web Locks API.
 *
 * Every iframe starts as a follower AND queues for one exclusive lock. Whoever
 * holds it — the first tab immediately, or a follower later when the current
 * leader's tab closes and the browser frees the lock — sheds its follower
 * wiring and runs smoldot. The lock guarantees exactly one holder, so there is
 * never more than one leader, and failover needs no explicit signalling.
 */
async function electLeader(port: MessagePort, network: Network): Promise<void> {
  const lockName = `dotli-leader:${network}`;

  if (!("locks" in navigator)) {
    // No Web Locks: degrade to "this iframe is the sole leader". Cross-tab
    // sharing is lost, but chain access still works.
    log.warn("[dot.li protocol] Web Locks unavailable; running as sole leader");
    await runAsLeader(port);
    return;
  }

  const follower = runAsFollower(port);
  void navigator.locks
    .request(lockName, { mode: "exclusive" }, async () => {
      // Stop relaying — we are the leader now. From here until `runAsLeader`
      // binds the engine listeners (one dynamic import later), parent
      // requests are dropped and surface via their normal request timeouts —
      // consistent with the reset-on-failover semantics. The router side has
      // no such gap: `leader-claiming` makes it buffer follower forwards.
      follower.detach();
      log.warn(
        "[dot.li protocol] Won leader lock; running smoldot in this iframe",
      );
      await runAsLeader(port);
      await holdUntilUnload();
    })
    .catch((err: unknown) => {
      log.error("[dot.li protocol] Leader lock request failed:", err);
    });
}

/**
 * Lazily load the resolver + smoldot modules (dynamic import). The return type
 * is inferred on purpose: naming it would require an `import(...)` type
 * annotation, which the repo's `consistent-type-imports` rule forbids, so
 * `ResolverModules` is derived from it below.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- inferred module-namespace tuple; see doc above
async function loadResolverModules() {
  // Dynamic imports so iframes that never host smoldot (rpc submode, or a
  // follower that is never promoted) don't pay the smoldot / chain-spec bundle.
  const [chains, resolve, smoldotMod] = await Promise.all([
    import("@dotli/resolver/chains"),
    import("@dotli/resolver/resolve"),
    import("@dotli/resolver/smoldot"),
  ]);
  return { chains, resolve, smoldotMod };
}
type ResolverModules = Awaited<ReturnType<typeof loadResolverModules>>;

/**
 * Build the chain engine shared by `direct` mode and the leader iframe. Both
 * wire the broker's shared Asset Hub / People follows, forward smoldot panics
 * to the parent, flush the persisted DB when the tab is hidden, and tear down
 * on unload — identically. They differ only in the smoldot factory (`onInit`:
 * a dedicated Worker for `direct`, this Window's main thread for the leader)
 * and, for `direct` mode, a lazy `onWarmup`.
 */
function makeResolverEngine(
  mods: ResolverModules,
  opts: { onInit: () => void; onWarmup?: () => Promise<void> },
): ProtocolEngine {
  const { chains, resolve, smoldotMod } = mods;
  const engine = createEngine({
    createChainProvider: chains.createChainProvider,
    isChainSupported: chains.isChainSupported,
    onBrokerReady: (broker) => {
      // Route the resolver's Asset Hub reads AND the People warm-keep through
      // the broker's shared follow (object-wire) so there is one shared Asset
      // Hub follow, never released mid-read.
      resolve.setResolverAssetHubProvider(() =>
        requireBrokerLocalProvider(
          broker,
          getActiveServicesConfig().assethub.genesis,
          "Asset Hub",
        ),
      );
      resolve.setResolverPeopleProvider(() =>
        requireBrokerLocalProvider(
          broker,
          getActiveServicesConfig().people.genesis,
          "People",
        ),
      );
    },
    onInit: opts.onInit,
    onCleanup: () => {
      smoldotMod.terminateSmoldot();
    },
    onWarmup: opts.onWarmup,
    resolveDotName: resolve.resolveDotName,
    resolveOwner: resolve.resolveOwner,
    resolveExecutableManifest: resolve.resolveExecutableManifest,
    resolveRootManifest: resolve.resolveRootManifest,
  });

  smoldotMod.onSmoldotFatal((message) => {
    log.error("[dot.li protocol] Smoldot panic detected, signaling fatal");
    if (window.parent !== window) {
      window.parent.postMessage(
        { namespace: "dotli:protocol", kind: "fatal", message } as const,
        "*",
      );
    }
  });

  // Flush a DB snapshot whenever this (smoldot-hosting) iframe is hidden — a
  // tab switch, or right before the tab closes. Paired with the short persist
  // interval, this keeps the shared-origin IndexedDB checkpoint fresh so a
  // leader handoff warm-starts with only seconds of catch-up.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void smoldotMod.flushPersistence();
    }
  });

  window.addEventListener("beforeunload", () => {
    engine.cleanup();
  });

  return engine;
}

/**
 * Run smoldot + the chain broker in THIS iframe, serving both our own parent
 * tab and every follower (via the router). Resolves once set up and presynced;
 * the Web Lock callback keeps holding the lock afterwards.
 */
async function runAsLeader(port: MessagePort): Promise<void> {
  log.warn("[dot.li protocol] === LEADER: smoldot runs in this iframe ===");
  m.setDefaults({ protocol_role: "leader" });

  // Preempt any stale leader immediately (before the async import + presync)
  // so the router buffers follower forwards during the gap instead of posting
  // them into a dead port.
  port.postMessage({ type: "leader-claiming" } satisfies SWLeaderClaiming);

  const mods = await loadResolverModules();
  const { resolve } = mods;
  const engine = makeResolverEngine(mods, {
    // CRUCIAL: `getSmoldotDirect()` runs smoldot on THIS Window's main thread,
    // where `RTCPeerConnection` exists. `getSmoldot()` (the dedicated-Worker
    // variant `direct` mode uses) would put smoldot back in a Worker and
    // silently lose WebRTC — the whole reason for this mode. smoldot is a
    // singleton, so this first call fixes the instance every later
    // `getSmoldot()` / `getRelayChain()` call reuses.
    onInit: () => {
      resolve.getSmoldotDirect();
    },
    // No `onWarmup`: the leader presyncs eagerly below, before it signals
    // ready. Gating presync on the parent's `warmup` would deadlock — the
    // parent only sends `warmup` after it sees `ready`, and `ready` is gated
    // on presync.
  });

  // Serve our own parent tab directly (no router hop) and every follower via
  // the router. Bind both before presync so requests the router buffered are
  // handled the moment we post `leader-ready`, and start the port only after
  // the router-forward listener is attached (see `initLeaderIframeMode`).
  bindEngineToMessages(engine);
  bindLeaderRouterForward(engine, port);
  port.start();

  // Eager presync (mirrors the former SharedWorker `presync()`): relay chain,
  // then Asset Hub to a finalized block; warm People in the background.
  try {
    await resolve.getRelayChain();
    await resolve.waitForAssetHubFinalized((msg) => {
      log.warn(`[dot.li protocol] leader presync: ${msg}`);
    });
    void resolve.waitForPeopleFinalized().catch((err: unknown) => {
      log.warn(
        `[dot.li protocol] People warm failed (retried on demand): ${serializeError(err)}`,
      );
    });
  } catch (err: unknown) {
    const message = serializeError(err);
    log.error("[dot.li protocol] Leader presync failed:", message);
    // Surface to followers (via the router) and our own parent, then stay
    // dead — matching the no-auto-retry policy of the old presync path.
    port.postMessage({ type: "leader-error", message } satisfies SWLeaderError);
    signalError(message);
    return;
  }

  // Register as leader (the router flushes any buffered follower forwards to
  // us) and release our own parent tab.
  port.postMessage({ type: "leader-ready" } satisfies SWLeaderReady);
  signalReady();
  log.warn("[dot.li protocol] Leader ready");
}

/**
 * On the leader, handle requests the router forwards on behalf of followers.
 * Each forward carries the follower's `clientId`; responses (and async
 * chain-messages) are posted back tagged with that id so the router can route
 * them to the right follower. Per-follower connection tracking lets us tear
 * down a follower's chain connections when the router reports it gone.
 */
function bindLeaderRouterForward(
  engine: ProtocolEngine,
  port: MessagePort,
): void {
  const clientConnections = new Map<number, Set<string>>();

  const disconnectClient = (clientId: number): void => {
    const conns = clientConnections.get(clientId);
    if (!conns) {
      return;
    }
    clientConnections.delete(clientId);
    for (const connectionId of conns) {
      void engine
        .handleRequest(
          {
            namespace: "dotli:protocol",
            kind: "request",
            id: `client-gone:${connectionId}`,
            method: "chainDisconnect",
            payload: { connectionId },
          },
          "leader-cleanup",
          () => {
            /* teardown ack; nothing to route back */
          },
        )
        .catch(() => {
          /* best-effort teardown */
        });
    }
  };

  port.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as SWLeaderForward | SWClientGone | null;
    if (data?.type === "client-gone") {
      disconnectClient(data.clientId);
      return;
    }
    if (data?.type !== "leader-forward") {
      return;
    }
    const { clientId, envelope, origin } = data;
    if (!isAllowedOrigin(origin)) {
      log.warn(
        `[dot.li protocol] Leader rejecting forwarded request from disallowed origin: ${origin}`,
      );
      return;
    }
    // Track chain-connection lifecycle so `client-gone` can release them.
    if (envelope.method === "chainConnect") {
      const payload = envelope.payload as ProtocolRequestMap["chainConnect"];
      let set = clientConnections.get(clientId);
      if (!set) {
        set = new Set<string>();
        clientConnections.set(clientId, set);
      }
      set.add(payload.connectionId);
    } else if (envelope.method === "chainDisconnect") {
      const payload = envelope.payload as ProtocolRequestMap["chainDisconnect"];
      clientConnections.get(clientId)?.delete(payload.connectionId);
    }
    void engine
      .handleRequest(envelope, origin, (responseEnvelope) => {
        port.postMessage({
          type: "leader-response",
          clientId,
          envelope: responseEnvelope,
        } satisfies SWLeaderResponse);
      })
      .catch((error: unknown) => {
        port.postMessage({
          type: "leader-response",
          clientId,
          envelope: {
            namespace: "dotli:protocol",
            kind: "response",
            id: envelope.id,
            ok: false,
            error: serializeError(error),
          },
        } satisfies SWLeaderResponse);
      });
  });
}

/**
 * Relay this iframe's parent-tab requests to the leader via the router, and
 * relay the leader's responses back up to the parent. Returns a handle whose
 * `detach()` removes all listeners — used when this iframe is promoted to
 * leader and must stop relaying on the same port.
 */
function runAsFollower(port: MessagePort): { detach: () => void } {
  log.warn("[dot.li protocol] === FOLLOWER: relaying to the leader ===");
  m.setDefaults({ protocol_role: "follower" });
  const ac = new AbortController();
  const { signal } = ac;

  // Parent -> router.
  window.addEventListener(
    "message",
    (event: MessageEvent) => {
      const data: unknown = event.data;
      if (!isProtocolEnvelope(data) || data.kind !== "request") {
        return;
      }
      if (
        isSharedAuthRequestMethod(data.method) ||
        isSharedModeRequestMethod(data.method)
      ) {
        return; // handled locally by the shared-auth / shared-mode listeners
      }
      if (!isAllowedOrigin(event.origin)) {
        log.warn(
          `[dot.li protocol] Rejected request from disallowed origin: ${event.origin}`,
        );
        return;
      }
      port.postMessage({
        type: "relay-request",
        envelope: data,
        origin: event.origin,
      } satisfies SWRelayRequest);
    },
    { signal },
  );

  // Router -> parent, plus lifecycle signals.
  port.addEventListener(
    "message",
    (event: MessageEvent) => {
      const data = event.data as SWOutbound | { type?: string } | null;
      const type = data?.type;
      // if/else (not switch): loosely-typed wire messages; unrecognized types
      // (e.g. the router's "ping") are ignored.
      if (type === "relay-response") {
        if (window.parent !== window) {
          window.parent.postMessage((data as SWRelayResponse).envelope, "*");
        }
      } else if (type === "ready") {
        // The leader presynced. Release our parent tab.
        signalReady();
      } else if (type === "error") {
        signalError(`Protocol leader failed: ${(data as SWError).message}`);
      } else if (type === "leader-changed") {
        // The leader's tab went away. This iframe stays alive (it may be the
        // one promoted). Existing chain connections are dead; the next request
        // each polkadot-api consumer sends is rejected by the fresh leader
        // ("Unknown chain connection"), surfacing as a normal chain error, and
        // the consumer reconnects. (Seamless per-connection re-subscribe is a
        // planned follow-up.)
        log.warn(
          "[dot.li protocol] Leader changed; chain connections reconnect on next use",
        );
      }
    },
    { signal },
  );

  // Best-effort disconnect so the router releases our chain connections
  // promptly (rather than waiting for the next stale-port sweep). Removed on
  // promotion via `detach()` — the promoted leader's own teardown takes over.
  window.addEventListener(
    "pagehide",
    () => {
      try {
        port.postMessage({ type: "disconnect" } satisfies SWDisconnect);
        // eslint-disable-next-line no-restricted-syntax -- best-effort unload signal; the port may already be closing as the tab unloads.
      } catch {
        /* port already closing on unload */
      }
    },
    { signal },
  );

  // Listeners are attached; now start the port so any message the router
  // already queued (e.g. an early `ready`) is delivered.
  port.start();

  return {
    detach: () => {
      ac.abort();
    },
  };
}

async function initDirectMode(): Promise<void> {
  log.warn("[dot.li protocol] === DIRECT MODE ===");
  log.warn(
    "[dot.li protocol] Smoldot runs in this iframe with no cross-tab coordination",
  );

  const mods = await loadResolverModules();
  const { resolve } = mods;
  const engine = makeResolverEngine(mods, {
    // `direct` mode runs smoldot in a dedicated Worker: no cross-tab sharing,
    // and no WebRTC (see `runAsLeader` for why the leader uses the main thread
    // instead).
    onInit: () => {
      resolve.getSmoldot();
    },
    // Lazy: start smoldot + relay sync on the first `warmup`, and warm People
    // in the background so legacy-account auth reads don't race a cold
    // parachain warp sync.
    onWarmup: async () => {
      resolve.getSmoldot();
      await resolve.getRelayChain();
      void resolve.waitForPeopleFinalized().catch((err: unknown) => {
        log.warn(
          `[dot.li protocol] People chain warm failed (retried on demand): ${String(err)}`,
        );
      });
    },
  });

  bindEngineToMessages(engine);
  signalReady();
}

// No smoldot. Sandboxed app chain requests are bridged to a trusted WSS
// JSON-RPC endpoint via the shared broker. Name resolution in gateway mode
// happens in the host process (see `@dotli/resolver/rpc-resolve`), not via
// this iframe, so `resolveDotName` and `resolveOwner` requests aren't wired
// up here. The host never sends them when gateway is active.

function initRpcMode(): void {
  log.warn("[dot.li protocol] === RPC MODE ===");
  log.warn(
    "[dot.li protocol] Chain calls routed via WSS JSON-RPC (no smoldot)",
  );

  const engine = createEngine({
    createChainProvider: createRpcChainProvider,
    isChainSupported: isRpcChainSupported,
    // No onInit / onCleanup: the WS provider lifecycle is owned by the
    // broker's `ensureUpstream` / `disconnectAll`.
    // No resolver: gateway-mode resolution doesn't go through this iframe.
  });

  bindEngineToMessages(engine);
  signalReady();

  window.addEventListener("beforeunload", () => {
    engine.cleanup();
  });
}

function bindEngineToMessages(engine: ProtocolEngine): void {
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== "request") {
      return;
    }
    if (
      isSharedAuthRequestMethod(data.method) ||
      isSharedModeRequestMethod(data.method)
    ) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(
        `[dot.li protocol] Rejected request from disallowed origin: ${event.origin}`,
      );
      return;
    }

    void engine
      .handleRequest(data, event.origin, (response) => {
        postToSource(event.source, event.origin, response);
      })
      .catch((error: unknown) => {
        log.error("[dot.li protocol] Request failed:", error);
        postToSource(event.source, event.origin, {
          namespace: "dotli:protocol",
          kind: "response",
          id: data.id,
          ok: false,
          error: serializeError(error),
        });
      });
  });
}

type ResponseCallback = (envelope: ProtocolEnvelope) => void;

function assertSharedAuthSiteId(value: unknown): asserts value is SiteId {
  if (typeof value !== "string" || !isSharedAuthSiteId(value)) {
    throw new Error(`Invalid siteId: ${String(value)}`);
  }
}

function assertSharedAuthKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isValidSharedAuthKey(value)) {
    throw new Error(`Invalid shared auth key: ${String(value)}`);
  }
}

function assertSharedAuthOrigin(origin: string): void {
  if (!isSharedAuthOriginAllowed(origin)) {
    throw new Error(`Shared auth request denied from origin: ${origin}`);
  }
}

function assertSharedModeKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isValidSharedModeKey(value)) {
    throw new Error(`Invalid shared mode key: ${String(value)}`);
  }
}

/**
 * The shared mode-storage trust boundary is identical to shared auth: any
 * subdomain of the registrable root may read/write, sandboxed app
 * subdomains may not, and the siteId must match `SITE_ID`. Re-using the
 * auth checks keeps the gate consistent and avoids drift.
 */
function handleSharedModeRequest(
  request: ProtocolRequestEnvelope,
  origin: string,
  respond: ResponseCallback,
): void {
  if (!isSharedModeRequestMethod(request.method)) {
    throw new Error(`Not a shared mode request: ${request.method as string}`);
  }

  assertSharedAuthOrigin(origin);

  switch (request.method) {
    case "modeStorageRead": {
      const payload = request.payload as ProtocolRequestMap["modeStorageRead"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedModeKey(payload.key);
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: localStorage.getItem(
          buildSharedModeStorageKey(payload.siteId, payload.key),
        ),
      });
      return;
    }

    case "modeStorageWrite": {
      const payload = request.payload as ProtocolRequestMap["modeStorageWrite"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedModeKey(payload.key);
      if (typeof payload.value !== "string") {
        throw new Error("Invalid shared mode value");
      }
      localStorage.setItem(
        buildSharedModeStorageKey(payload.siteId, payload.key),
        payload.value,
      );
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case "modeStorageClear": {
      const payload = request.payload as ProtocolRequestMap["modeStorageClear"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedModeKey(payload.key);
      localStorage.removeItem(
        buildSharedModeStorageKey(payload.siteId, payload.key),
      );
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }
  }
}

function bindSharedModeListener(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      !isProtocolEnvelope(data) ||
      data.kind !== "request" ||
      !isSharedModeRequestMethod(data.method)
    ) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(
        `[dot.li protocol] Rejected shared-mode request from disallowed origin: ${event.origin}`,
      );
      countSharedReject("mode", "origin");
      return;
    }

    try {
      handleSharedModeRequest(data, event.origin, (response) => {
        postToSource(event.source, event.origin, response);
      });
    } catch (error: unknown) {
      countSharedReject("mode", "validation");
      postToSource(event.source, event.origin, {
        namespace: "dotli:protocol",
        kind: "response",
        id: data.id,
        ok: false,
        error: serializeError(error),
      });
    }
  });
}

function handleSharedAuthRequest(
  request: ProtocolRequestEnvelope,
  origin: string,
  respond: ResponseCallback,
): void {
  if (!isSharedAuthRequestMethod(request.method)) {
    throw new Error(`Not a shared auth request: ${request.method as string}`);
  }

  assertSharedAuthOrigin(origin);

  switch (request.method) {
    case "authHasSession": {
      const payload = request.payload as ProtocolRequestMap["authHasSession"];
      assertSharedAuthSiteId(payload.siteId);
      const value = localStorage.getItem(
        buildSharedAuthStorageKey(payload.siteId, SHARED_AUTH_SESSION_KEY),
      );
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: hasStoredSharedAuthSession(value),
      });
      return;
    }

    case "authStorageRead": {
      const payload = request.payload as ProtocolRequestMap["authStorageRead"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: localStorage.getItem(
          buildSharedAuthStorageKey(payload.siteId, payload.key),
        ),
      });
      return;
    }

    case "authStorageWrite": {
      const payload = request.payload as ProtocolRequestMap["authStorageWrite"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      if (typeof payload.value !== "string") {
        throw new Error("Invalid shared auth value");
      }
      localStorage.setItem(
        buildSharedAuthStorageKey(payload.siteId, payload.key),
        payload.value,
      );
      broadcastSharedAuthChange(payload.siteId, payload.key, payload.value);
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case "authStorageClear": {
      const payload = request.payload as ProtocolRequestMap["authStorageClear"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      localStorage.removeItem(
        buildSharedAuthStorageKey(payload.siteId, payload.key),
      );
      broadcastSharedAuthChange(payload.siteId, payload.key, null);
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }
  }
}

interface ProtocolEngine {
  handleRequest: (
    request: ProtocolRequestEnvelope,
    origin: string,
    respond: ResponseCallback,
  ) => Promise<void>;
  cleanup: () => void;
}

interface EngineOptions {
  /** Factory for a `JsonRpcProvider` keyed by genesis hash. */
  createChainProvider: (genesisHash: string) => JsonRpcProvider | null;
  /** Whether the given genesis hash is handled by this engine. */
  isChainSupported: (genesisHash: string) => boolean;
  /** Called once at engine creation, e.g. to kick off smoldot pre-sync. */
  onInit?: () => void;
  /**
   * Called once right after the broker is created. Smoldot modes use this to
   * route the resolver's Asset Hub reads through the broker's shared follow.
   */
  onBrokerReady?: (broker: ChainBrokerManager) => void;
  /** Called at cleanup time after broker teardown. */
  onCleanup?: () => void;
  /** Called on `warmup` requests. If omitted, `warmup` resolves immediately. */
  onWarmup?: () => Promise<void>;
  /** Resolver implementations. If omitted, resolution methods reject with a
   *  clear error so hanging callers surface fast. */
  resolveDotName?: (
    label: string,
    onStatus: (message: string) => void,
  ) => Promise<string | null>;
  resolveOwner?: (label: string) => Promise<string | null>;
  /**
   * Product-manifest readers.
   *
   * `rpc-gateway` mode resolves manifests in the host process, not via the
   * iframe engine, so these stay unwired there.
   */
  resolveExecutableManifest?: (
    label: string,
    kind: "app" | "widget" | "worker",
  ) => Promise<ManifestResult<ExecutableManifest>>;
  resolveRootManifest?: (
    label: string,
  ) => Promise<ManifestResult<RootManifest>>;
}

function createEngine(options: EngineOptions): ProtocolEngine {
  // Aggregate cap across every connection this engine serves. In leader mode
  // one engine serves all tabs' followers, so the former per-tab value of 10
  // was too low; the real abuse guard is the per-origin cap enforced below.
  const MAX_CONNS = 100;
  const connections = new Map<string, StringJsonRpcConnection>();
  const originConns = new Map<string, Set<string>>();
  const broker = createChainBrokerManager(options.createChainProvider);
  options.onBrokerReady?.(broker);
  options.onInit?.();

  function assertStr(value: unknown, name: string): asserts value is string {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Invalid ${name}: expected non-empty string`);
    }
  }

  async function handleRequest(
    request: ProtocolRequestEnvelope,
    origin: string,
    respond: ResponseCallback,
  ): Promise<void> {
    // Both engine-facing listeners filter shared-auth/shared-mode out;
    // reaching the engine means one of those filters is broken.
    if (
      isSharedAuthRequestMethod(request.method) ||
      isSharedModeRequestMethod(request.method)
    ) {
      throw new Error(
        `Shared storage request reached the chain engine: ${request.method}`,
      );
    }

    switch (request.method) {
      case "warmup": {
        if (options.onWarmup) {
          await options.onWarmup();
        }
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case "resolveDotName": {
        if (!options.resolveDotName) {
          throw new Error("resolveDotName is not served by this protocol mode");
        }
        const payload = request.payload as ProtocolRequestMap["resolveDotName"];
        assertStr(payload.label, "label");
        const result = await options.resolveDotName(
          payload.label,
          (message) => {
            respond({
              namespace: "dotli:protocol",
              kind: "progress",
              id: request.id,
              message,
            });
          },
        );
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case "resolveOwner": {
        if (!options.resolveOwner) {
          throw new Error("resolveOwner is not served by this protocol mode");
        }
        const payload = request.payload as ProtocolRequestMap["resolveOwner"];
        assertStr(payload.label, "label");
        const result = await options.resolveOwner(payload.label);
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case "resolveExecutableManifest": {
        if (!options.resolveExecutableManifest) {
          throw new Error(
            "resolveExecutableManifest is not served by this protocol mode",
          );
        }
        const payload =
          request.payload as ProtocolRequestMap["resolveExecutableManifest"];
        assertStr(payload.label, "label");
        const kind: string = payload.kind;
        if (!isExecutableKind(kind)) {
          throw new Error(`Unsupported executable kind: ${kind}`);
        }
        const result = await options.resolveExecutableManifest(
          payload.label,
          payload.kind,
        );
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case "resolveRootManifest": {
        if (!options.resolveRootManifest) {
          throw new Error(
            "resolveRootManifest is not served by this protocol mode",
          );
        }
        const payload =
          request.payload as ProtocolRequestMap["resolveRootManifest"];
        assertStr(payload.label, "label");
        const result = await options.resolveRootManifest(payload.label);
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case "chainConnect": {
        const payload = request.payload as ProtocolRequestMap["chainConnect"];
        assertStr(payload.genesisHash, "genesisHash");
        assertStr(payload.connectionId, "connectionId");
        if (connections.size >= MAX_CONNS) {
          throw new Error(
            `Connection limit reached (max ${String(MAX_CONNS)})`,
          );
        }
        const oc = originConns.get(origin) ?? new Set<string>();
        if (oc.size >= MAX_CONNECTIONS_PER_ORIGIN) {
          throw new Error(
            `Per-origin connection limit reached (max ${String(MAX_CONNECTIONS_PER_ORIGIN)})`,
          );
        }
        if (!options.isChainSupported(payload.genesisHash)) {
          throw new Error(`Unsupported chain: ${payload.genesisHash}`);
        }
        const connection = broker.connectRemote(
          payload.genesisHash,
          payload.connectionId,
          (message) => {
            respond({
              namespace: "dotli:protocol",
              kind: "chain-message",
              connectionId: payload.connectionId,
              message,
            });
          },
        );
        if (connection === null) {
          throw new Error("Failed to create chain broker");
        }
        connections.set(payload.connectionId, connection);
        oc.add(payload.connectionId);
        originConns.set(origin, oc);
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case "chainSend": {
        const payload = request.payload as ProtocolRequestMap["chainSend"];
        assertStr(payload.connectionId, "connectionId");
        assertStr(payload.message, "message");
        const conn = connections.get(payload.connectionId);
        if (conn === undefined) {
          throw new Error(`Unknown chain connection: ${payload.connectionId}`);
        }
        conn.send(payload.message);
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case "chainDisconnect": {
        const payload =
          request.payload as ProtocolRequestMap["chainDisconnect"];
        assertStr(payload.connectionId, "connectionId");
        const conn = connections.get(payload.connectionId);
        conn?.disconnect();
        connections.delete(payload.connectionId);
        for (const [orig, conns] of originConns) {
          conns.delete(payload.connectionId);
          if (conns.size === 0) {
            originConns.delete(orig);
          }
        }
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      default: {
        const _method: never = request.method;
        throw new Error(`Unknown protocol method: ${_method as string}`);
      }
    }
  }

  function cleanup(): void {
    for (const conn of connections.values()) {
      conn.disconnect();
    }
    connections.clear();
    originConns.clear();
    broker.disconnectAll();
    options.onCleanup?.();
  }

  return { handleRequest, cleanup };
}

bindSharedAuthListener();
bindSharedAuthBroadcastRelay();
bindSharedModeListener();

void init().catch((err: unknown) => {
  log.error("[dot.li protocol] Init failed:", err);
  signalError(err instanceof Error ? err.message : String(err));
});
