// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Protocol host entry point.
//
// Three modes, selected explicitly via the `?mode=` URL parameter:
//   1. "shared-worker": smoldot runs in a SharedWorker shared across tabs.
//   2. "direct": smoldot runs in this iframe with no cross-tab coordination.
//   3. "rpc": trusted WSS JSON-RPC to a public node (no smoldot), used by
//      gateway mode to bridge sandboxed-app chain calls.

import {
  initSentry,
  installGlobalErrorHandlers,
  captureException,
  m,
  setResolutionId,
  spans as S,
} from '@dotli/metrics';
import {
  chainBytesReceived,
  installByteMeter,
  createCoreRpcChainProvider,
  isCoreRpcChainSupported,
  loadProvider,
  loadResolve,
} from '@dotli/resolver';

// Before anything opens a socket. the smoldot transports are the bulk of
// cold-load traffic and are invisible to resource timing, so the loading
// screen speed readout has no other source for them.
installByteMeter();

// Do NOT silently reload on chunk preload failure. The protocol iframe is
// hidden and has no UI of its own, so it surfaces the failure to the parent
// via the standard error envelope. The parent will render the user-facing
// error.
window.addEventListener('vite:preloadError', event => {
  const evt = event as unknown as { payload?: unknown };
  captureException(evt.payload ?? new Error('vite:preloadError'), {
    kind: 'chunk_preload_error',
    surface: 'protocol_iframe',
  });
  if (window.parent !== window) {
    const msg = evt.payload instanceof Error ? evt.payload.message : 'Asset failed to load';
    window.parent.postMessage(
      {
        namespace: 'dotli:protocol',
        kind: 'fatal',
        message: `Protocol iframe asset failed to load: ${msg}`,
      } as const,
      '*',
    );
  }
});

import { log, errorName, serializeError, fromHex, toHex } from '@dotli/shared';
import {
  DEBUG,
  SITE_ID,
  TIMEOUTS,
  type SiteId,
  getActiveServicesConfig,
  isValidNetwork,
  setNetworkOverride,
  type Network,
} from '@dotli/config';

// Smoldot, relay-chain, and dot-name resolver imports live behind
// `initDirectMode()` (dynamic) so `rpc` mode doesn't drag smoldot into the
// protocol iframe's initial chunk. The SharedWorker path doesn't import
// these either. Smoldot for shared-worker mode lives inside
// `./protocol-shared-worker.ts`, which is already a separate bundle.

import {
  requireBrokerLocalProvider,
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isValidSharedAuthKey,
  isValidSharedModeKey,
  SHARED_CORE_SESSION_KEY,
  isProtocolEnvelope,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  isSharedWalletOperation,
  isSharedWalletState,
  createWalletOwner,
  isWalletOwnerOperation,
  type WalletOwner,
  isCoreCustodyOperation,
} from '@dotli/protocol';
import { handleWalletOperation, WALLET_DB_NAME, withSharedWalletRevision } from './wallet-storage.js';
import { CORE_CUSTODY_DB_NAME, handleCoreCustody } from './core-custody.js';

import type { SWRelayRequest, SWOutbound } from './protocol-shared-worker.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { observeChains } from './observe-chains.js';
import { createEngine, type ProtocolEngine, type ResponseCallback } from './engine.js';
import protocolSharedWorkerUrl from './protocol-shared-worker.ts?sharedworker&url';
import { sharedWorkerGeneration } from './shared-worker-generation.js';

initSentry('host');
installGlobalErrorHandlers('host');

// Adopted at module scope, not inside init(): an auth-only iframe and every
// invalid-mode path return before init() gets far, and those boots still
// belong to the resolution that opened them.
adoptResolutionId();

/** Take the correlation id the host shell put on the URL of this iframe. */
function adoptResolutionId(): void {
  try {
    const id = new URLSearchParams(window.location.search).get('resolutionId');
    if (id !== null && id !== '') {
      setResolutionId(id);
    }
    // eslint-disable-next-line no-restricted-syntax -- telemetry correlation is never a reason to fail a boot. An untagged iframe is the acceptable outcome.
  } catch {
    /* URL unparseable, carry on untagged */
  }
}

// Same trust set as shared auth: host shell plus non-sandbox *.<BASE>, but NOT
// app.<BASE> or *.app.<BASE>. A user-uploaded CID app must never drive the
// chain bridge directly. It goes through the host shell, which relays on
// its behalf. Centralizing on `isSharedAuthOriginAllowed` keeps the two
// allowlists in lockstep.
function isAllowedOrigin(origin: string): boolean {
  return isSharedAuthOriginAllowed(origin);
}

function postToSource(source: MessageEventSource | null, origin: string, message: ProtocolEnvelope): void {
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

const SHARED_AUTH_BROADCAST_CHANNEL = 'dotli:shared-auth';

interface SharedAuthBroadcastMessage {
  siteId: SiteId;
  key: string;
  value: string | null;
}

const sharedAuthChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SHARED_AUTH_BROADCAST_CHANNEL) : null;

// The origin of the parent window embedding this host iframe. Populated from
// `document.referrer` at module load (best-effort, may be blank under strict
// referrer policies) and refreshed on every validated shared-auth request.
// Broadcasts are only forwarded to the parent when we know its origin, so
// unrelated embedders never receive a shared-auth change notification.
let parentOrigin: string | null = initialParentOriginFromReferrer();

function initialParentOriginFromReferrer(): string | null {
  try {
    const ref = document.referrer;
    if (ref === '') {
      return null;
    }
    const origin = new URL(ref).origin;
    return isAllowedOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

function broadcastSharedAuthChange(siteId: SiteId, key: string, value: string | null): void {
  if (sharedAuthChannel === null) {
    return;
  }
  try {
    const msg: SharedAuthBroadcastMessage = { siteId, key, value };
    sharedAuthChannel.postMessage(msg);
  } catch (error: unknown) {
    log.warn('[dot.li protocol] Shared auth broadcast failed:', error);
  }
}

function isSharedAuthBroadcastMessage(value: unknown): value is SharedAuthBroadcastMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as {
    siteId?: unknown;
    key?: unknown;
    value?: unknown;
  };
  return (
    typeof obj.siteId === 'string' &&
    typeof obj.key === 'string' &&
    (obj.value === null || typeof obj.value === 'string')
  );
}

function bindSharedAuthBroadcastRelay(): void {
  if (sharedAuthChannel === null) {
    return;
  }
  sharedAuthChannel.addEventListener('message', (event: MessageEvent) => {
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
          namespace: 'dotli:protocol',
          kind: 'auth-storage-changed',
          siteId: data.siteId,
          key: data.key,
          value: data.value,
        } as const,
        parentOrigin,
      );
    } catch (error: unknown) {
      log.warn('[dot.li protocol] Failed to forward shared auth change to parent:', error);
    }
  });
}

type SharedStore = 'auth' | 'mode';
type SharedRejectReason = 'origin' | 'validation';

function countSharedReject(store: SharedStore, reason: SharedRejectReason): void {
  m.count(S.SHARED_STORAGE_REJECTED, { store, reason });
}

function bindSharedAuthListener(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== 'request' || !isSharedAuthRequestMethod(data.method)) {
      return;
    }
    // First gate: the broad protocol origin allowlist (`*.<BASE_DOMAIN>` plus
    // localhost). The narrower shared-auth allowlist, which additionally
    // rejects `app.<BASE_DOMAIN>` and sandboxed SPA subdomains, runs inside
    // `handleSharedAuthRequest` via `assertSharedAuthOrigin`.
    if (!isAllowedOrigin(event.origin)) {
      log.warn(`[dot.li protocol] Rejected shared-auth request from disallowed origin: ${event.origin}`);
      countSharedReject('auth', 'origin');
      return;
    }
    // Remember the parent origin so cross-tab broadcast forwards target a
    // known origin rather than `*`. This runs on every request, not just the
    // first, so we tolerate (unlikely) parent navigations that replace the
    // embedding page.
    parentOrigin = event.origin;

    void handleSharedAuthRequest(data, event.origin, response => {
      postToSource(event.source, event.origin, response);
    }).catch((error: unknown) => {
      countSharedReject('auth', 'validation');
      const name = errorName(error);
      postToSource(event.source, event.origin, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: data.id,
        ok: false,
        error: serializeError(error),
        ...(name !== undefined ? { errorName: name } : {}),
      });
    });
  });
}

/** Debug-only secret RPC. Only the validated trusted parent may use it. */
function bindSharedWalletListener(): void {
  if (!DEBUG) {
    return;
  }
  const channel = new BroadcastChannel('dotli:shared-wallet');
  let walletOwner: WalletOwner | undefined;
  channel.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      !isProtocolEnvelope(data) ||
      data.kind !== 'wallet-storage-changed' ||
      data.siteId !== SITE_ID ||
      !isSharedWalletState(data.state) ||
      parentOrigin === null ||
      !isSharedAuthOriginAllowed(parentOrigin) ||
      window.parent === window
    ) {
      return;
    }
    // Explicit construction ensures no secret-bearing extra fields get relayed.
    window.parent.postMessage(
      {
        namespace: 'dotli:protocol',
        kind: 'wallet-storage-changed',
        siteId: SITE_ID,
        state: {
          version: data.state.version,
          revision: data.state.revision,
          enabled: data.state.enabled,
          hasWallet: data.state.hasWallet,
          storedInOtherApp: data.state.storedInOtherApp,
        },
      },
      parentOrigin,
    );
  });
  window.addEventListener('message', (event: MessageEvent) => {
    const request: unknown = event.data;
    if (
      !isProtocolEnvelope(request) ||
      request.kind !== 'request' ||
      (request.method !== 'walletStorage' && request.method !== 'coreCustody' && request.method !== 'walletOwner')
    ) {
      return;
    }
    if (event.source !== window.parent || !isSharedAuthOriginAllowed(event.origin)) {
      return;
    }
    parentOrigin = event.origin;
    void (async () => {
      const payload: unknown = request.payload;
      if (typeof payload !== 'object' || payload === null || !('siteId' in payload) || !('operation' in payload)) {
        throw new Error('Invalid wallet operation');
      }
      assertSharedAuthSiteId(payload.siteId);
      if (request.method === 'walletOwner') {
        if (!isWalletOwnerOperation(payload.operation)) {
          throw new Error('Invalid wallet owner operation');
        }
        walletOwner ??= createPageWalletOwner();
        const lease = await walletOwner.handle(payload.operation, request.deadlineMs);
        postToSource(event.source, event.origin, {
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result: lease,
        });
        return;
      }
      if (request.method === 'coreCustody') {
        if (!isCoreCustodyOperation(payload.operation)) {
          throw new Error('Invalid private custody operation');
        }
        const result = await handleCoreCustody(payload.operation, request.deadlineMs);
        postToSource(event.source, event.origin, {
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result,
        });
        return;
      }
      if (!isSharedWalletOperation(payload.operation)) {
        throw new Error('Invalid wallet operation');
      }
      const result = await handleWalletOperation(
        payload.operation,
        state => {
          try {
            channel.postMessage({
              namespace: 'dotli:protocol',
              kind: 'wallet-storage-changed',
              siteId: SITE_ID,
              state,
            });
          } catch (error: unknown) {
            log.warn('[dot.li protocol] Wallet revision broadcast failed:', error);
          }
        },
        request.deadlineMs,
      );
      try {
        postToSource(event.source, event.origin, {
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result,
        });
      } finally {
        result.secret?.fill(0);
      }
    })().catch((error: unknown) => {
      const name = errorName(error);
      postToSource(event.source, event.origin, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: false,
        error: serializeError(error),
        ...(name !== undefined ? { errorName: name } : {}),
      });
    });
  });
}

// One tab of the profile runs the test wallet. The lease lives here, on the
// host origin every app page shares, and ends when this page goes away.
function createPageWalletOwner(): WalletOwner {
  if (typeof navigator.locks === 'undefined') {
    throw new Error('Shared wallets require secure-context Web Locks');
  }
  const owner = createWalletOwner({
    locks: navigator.locks,
    channel: new BroadcastChannel('dotli:test-wallet-owner'),
    randomId: () => crypto.randomUUID(),
  });
  owner.onRevoked(lease => {
    if (parentOrigin === null || window.parent === window) {
      void owner.handle({ action: 'release', lease });
      return;
    }
    // The page stops its wallet workers, then releases the lease itself.
    window.parent.postMessage(
      {
        namespace: 'dotli:protocol',
        kind: 'wallet-owner-revoked',
        siteId: SITE_ID,
        lease,
      },
      parentOrigin,
    );
  });
  window.addEventListener('pagehide', () => {
    owner.releaseAll();
  });
  return owner;
}

function signalReady(): void {
  if (window.parent !== window) {
    window.parent.postMessage({ namespace: 'dotli:protocol', kind: 'ready' } as const, '*');
  }
}

type RequestedMode = 'shared-worker' | 'direct' | 'rpc' | null;

/**
 * Distinguish "no mode requested" (auth-only iframe, legitimate) from
 * "mode requested but unrecognized" (host bug or URL-tampering, which must
 * surface to the parent so the user sees a real error instead of a silent
 * downgrade to auth-only behavior).
 */
function getRequestedMode(): RequestedMode | 'invalid' {
  let raw: string | null;
  try {
    raw = new URLSearchParams(window.location.search).get('mode');
  } catch {
    return 'invalid';
  }
  if (raw === null) {
    return null;
  }
  if (raw === 'shared-worker' || raw === 'direct' || raw === 'rpc') {
    return raw;
  }
  return 'invalid';
}

function getSkipWorkerCache(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('skipWorkerCache') === '1';
  } catch {
    return false;
  }
}

type RequestedNetwork = { kind: 'ok'; network: Network } | { kind: 'missing' } | { kind: 'invalid'; raw: string };

/**
 * The protocol iframe runs on a different origin than the host shell and
 * cannot read the host's `dotli:network` from `localStorage`.
 */
function getRequestedNetwork(): RequestedNetwork {
  let raw: string | null;
  try {
    raw = new URLSearchParams(window.location.search).get('network');
  } catch {
    return { kind: 'invalid', raw: '<unparseable>' };
  }
  if (raw === null) {
    return { kind: 'missing' };
  }
  if (isValidNetwork(raw)) {
    return { kind: 'ok', network: raw };
  }
  return { kind: 'invalid', raw };
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
  const keep: Record<string, true> = {
    dotli: true,
    'dotli-sw': true,
    [WALLET_DB_NAME]: true,
    [CORE_CUSTODY_DB_NAME]: true,
    'dotli-core': true,
  };
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    throw new Error(
      'Browser does not expose indexedDB.databases() — cannot fully purge worker caches. ' +
        'Please clear site data manually before retrying.',
    );
  }
  const dbs = await indexedDB.databases();
  const targets = dbs
    .map(db => db.name)
    .filter((name): name is string => name !== undefined && name !== '' && !Object.hasOwn(keep, name));
  await Promise.all(
    targets.map(
      name =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => {
            resolve();
          };
          req.onerror = () => {
            reject(
              new Error(
                `Failed to delete IDB ${name}: ${req.error?.name ?? 'unknown'}`,
                req.error ? { cause: req.error } : undefined,
              ),
            );
          };
          req.onblocked = () => {
            reject(new Error(`Delete of IDB ${name} blocked by another connection`));
          };
        }),
    ),
  );
  log.warn('[dot.li protocol] Purged worker caches (skipWorkerCache)');
}

async function init(): Promise<void> {
  const mode = getRequestedMode();

  if (mode === 'invalid') {
    let raw: string | null = null;
    try {
      raw = new URLSearchParams(window.location.search).get('mode');
      // eslint-disable-next-line no-restricted-syntax -- best-effort extraction of the offending mode value for the error message; the error is already signalled below regardless.
    } catch {
      /* URL parse failed, fall through with raw=null */
    }
    const message = `Unknown protocol mode: ${raw === null ? '<unparseable>' : `"${raw}"`}`;
    log.error(`[dot.li protocol] ${message}`);
    signalError(message);
    return;
  }

  // When no mode is requested, the iframe is only serving shared auth
  // storage requests (localStorage). No chain provider needed.
  if (mode === null) {
    log.warn('[dot.li protocol] No mode requested — auth-only iframe, skipping chain provider');
    signalReady();
    return;
  }
  const requestedNetwork = getRequestedNetwork();
  if (requestedNetwork.kind === 'invalid') {
    const message = `Unknown protocol network: "${requestedNetwork.raw}"`;
    log.error(`[dot.li protocol] ${message}`);
    signalError(message);
    return;
  }
  if (requestedNetwork.kind === 'missing') {
    const message = 'Missing required `network` URL param — host shell did not propagate the active network.';
    log.error(`[dot.li protocol] ${message}`);
    signalError(message);
    return;
  }
  setNetworkOverride(requestedNetwork.network);
  m.setDefaults({ network: requestedNetwork.network });
  log.warn(`[dot.li protocol] Active network pinned to ${requestedNetwork.network}`);

  // Worker-cache purge runs *before* any broker/smoldot init so the clean
  // state is what the chain client opens against. A purge failure when the
  // user explicitly requested skipWorkerCache MUST abort init. Proceeding
  // against a stale DB would silently violate the user's setting.
  if (getSkipWorkerCache()) {
    try {
      await purgeWorkerCaches();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('[dot.li protocol] purgeWorkerCaches failed:', err);
      signalError(`Failed to reset chain DB: ${message}`);
      return;
    }
  }

  const stopInit = m.timer(S.PROTOCOL_INIT);
  log.warn(`[dot.li protocol] Requested mode: ${mode}`);

  if (mode === 'shared-worker') {
    if (typeof SharedWorker === 'undefined') {
      const msg = 'SharedWorker is not available in this browser';
      log.error(`[dot.li protocol] ${msg}`);
      signalError(msg);
      stopInit();
      return;
    }
    // Register protocol_mode as a session default before any further metrics
    // so bootnode errors, chain-connect failures etc. all carry the mode tag.
    // Values are kebab-case to match `DotliMode` and the `?mode=` URL
    // convention, keeping one naming scheme across host and protocol.
    m.setDefaults({ protocol_mode: 'shared-worker' });
    await initSharedWorkerMode(requestedNetwork.network);
    m.count(S.PROTOCOL_MODE, { mode: 'shared-worker' });
  } else if (mode === 'rpc') {
    m.setDefaults({ protocol_mode: 'rpc' });
    initRpcMode();
    m.count(S.PROTOCOL_MODE, { mode: 'rpc' });
  } else {
    m.setDefaults({ protocol_mode: 'direct' });
    await initDirectMode();
    m.count(S.PROTOCOL_MODE, { mode: 'direct' });
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
        namespace: 'dotli:protocol',
        kind: 'init-failed',
        message,
      } as const,
      '*',
    );
  }
}

async function initSharedWorkerMode(network: Network): Promise<void> {
  const swStartTime = performance.now();

  // The URL import keeps Vite's worker bundling while allowing a fresh URL
  // after a crash. Reusing the closed worker's exact URL/name can attach to a
  // retired Chromium worker without starting it. All tabs share this network
  // generation; the name still supplies the worker's validated network.
  const generation = await sharedWorkerGeneration(network);
  const workerUrl = new URL(protocolSharedWorkerUrl, import.meta.url);
  workerUrl.searchParams.set('generation', generation);
  const worker = new SharedWorker(workerUrl, {
    type: 'module',
    name: `dotli-protocol-${network}`,
  });
  const port = worker.port;
  let halted = false;
  let rejectReady: ((error: Error) => void) | null = null;
  const halt = (message: string): void => {
    if (halted) {
      return;
    }
    halted = true;
    port.close();
    // Commit the replacement identity before the host can boot another
    // frame. The lock serializes simultaneous fatals from every attached tab.
    void sharedWorkerGeneration(network, generation)
      .catch((error: unknown) => {
        message = `${message}; SharedWorker generation retirement failed: ${serializeError(error)}`;
      })
      .then(() => {
        rejectReady?.(new Error(message));
        rejectReady = null;
        if (window.parent !== window) {
          window.parent.postMessage({ namespace: 'dotli:protocol', kind: 'fatal', message }, '*');
        }
      });
  };

  // Script-load and runtime worker failures must reach the host's typed
  // frame halt path; logging alone leaves its native consumer on a dead lease.
  worker.addEventListener('error', event => {
    log.error('[dot.li protocol] SharedWorker error event:', event);
    m.count(S.BOOTNODE_ERROR, { source: 'shared-worker' });
    halt(event.message || 'Protocol SharedWorker failed');
  });

  // Relay SharedWorker responses up to the parent from the first moment the
  // port exists. The worker broadcasts `smoldot-db` during pre-sync, long
  // before `ready`, and MessagePort events are not replayed: registering this
  // after the ready wait would silently drop everything sent in between.
  port.addEventListener('message', (event: MessageEvent) => {
    if (halted) {
      return;
    }
    const data = event.data as SWOutbound | null;
    if (data?.type === 'relay-response' && (data.envelope.kind === 'fatal' || data.envelope.kind === 'init-failed')) {
      halt(data.envelope.message);
      return;
    }
    if (data?.type === 'error') {
      halt(data.message);
      return;
    }
    if (data?.type === 'relay-response' && window.parent !== window) {
      window.parent.postMessage(data.envelope, '*');
    }
  });

  // Wait for SharedWorker to signal ready (or error)
  await new Promise<void>((resolve, reject) => {
    if (halted) {
      reject(new Error('Protocol SharedWorker failed before ready'));
      return;
    }
    const timer = setTimeout(() => {
      const waitMs = performance.now() - swStartTime;
      m.distribution(S.PROTOCOL_SW_READY, waitMs, 'millisecond', {
        outcome: 'timeout',
      });
      reject(new Error(PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT));
    }, TIMEOUTS.SHARED_WORKER_READY);
    rejectReady = error => {
      clearTimeout(timer);
      port.removeEventListener('message', onMessage);
      reject(error);
    };

    function onMessage(event: MessageEvent): void {
      if (halted) {
        return;
      }
      const data = event.data as SWOutbound | null;
      if (data?.type === 'ready') {
        clearTimeout(timer);
        port.removeEventListener('message', onMessage);
        rejectReady = null;
        const readyMs = performance.now() - swStartTime;
        m.measure(S.PROTOCOL_SW_READY, readyMs);
        m.distribution(S.PROTOCOL_SW_READY, readyMs, 'millisecond', {
          outcome: 'ok',
        });
        resolve();
      }
    }

    port.addEventListener('message', onMessage);
    port.start();
  });

  log.warn('[dot.li protocol] === SHARED WORKER MODE ACTIVE ===');
  log.warn('[dot.li protocol] Smoldot runs in SharedWorker, persists across navigations');

  // Relay parent postMessage requests into the SharedWorker.
  window.addEventListener('message', (event: MessageEvent) => {
    if (halted) {
      return;
    }
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== 'request') {
      return;
    }
    if (
      isSharedAuthRequestMethod(data.method) ||
      isSharedModeRequestMethod(data.method) ||
      data.method === 'walletStorage' ||
      data.method === 'coreCustody' ||
      data.method === 'walletOwner'
    ) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(`[dot.li protocol] Rejected request from disallowed origin: ${event.origin}`);
      return;
    }

    const msg: SWRelayRequest = {
      type: 'relay-request',
      envelope: data,
      origin: event.origin,
    };
    port.postMessage(msg);
  });

  signalReady();

  window.addEventListener('beforeunload', () => {
    if (halted) {
      return;
    }
    halted = true;
    log.warn('[dot.li protocol] Iframe unloading, sending disconnect to SharedWorker');
    try {
      port.postMessage({ type: 'disconnect' });
      // eslint-disable-next-line no-restricted-syntax -- best-effort unload signal to the SharedWorker; the port may already be closed (browser tab unloading), which is the expected terminal state.
    } catch {
      /* port already closed on unload, safe */
    }
    port.close();
  });
}

async function initDirectMode(): Promise<void> {
  log.warn('[dot.li protocol] === DIRECT MODE ===');
  log.warn('[dot.li protocol] Smoldot runs in this iframe with no cross-tab coordination');

  // Dynamic imports so users in `rpc` or `shared-worker` submode don't pay
  // the chain-provider bundle cost (D-1).
  const [provider, resolve] = await Promise.all([loadProvider(), loadResolve()]);
  const { createChainProvider, isChainSupported, onProviderFatal, onSmoldotDbOutcome } = provider;
  const {
    resolveDotName,
    resolveExecutableManifest,
    resolveOwner,
    resolveRootManifest,
    resolveSeitySlot,
    setResolverAssetHubProvider,
    setResolverPeopleProvider,
    waitForPeopleFinalized,
  } = resolve;
  // Sync reporting is only worth its cost when a loading UI can observe it.
  // Direct mode is that case and the SharedWorker never enables it.
  //
  // Enabled before the first `createChainProvider` call: a connection that
  // opens without it carries no lifecycle watch.
  resolve.enableSyncReporting([
    // The chains the load waits on, in the order it waits on them. The relay
    // warps, the Asset Hub bootstraps on top of it, and Bulletin serves the
    // content over bitswap. Bulletin is not even created until after the
    // content phase begins, and takes roughly another second and a half to
    // find a peer, which is a gap the loading screen has to cover.
    'relay',
    'asset-hub',
    'bulletin',
    // People is not on the loading path, but the network panel lists its
    // peer count.
    'people',
  ]);
  const { onChainSync } = resolve;

  const services = getActiveServicesConfig();

  // Direct mode has no SharedWorker in the loop, so a light client that cannot
  // connect a chain is posted straight up to the host shell.
  onProviderFatal(message => {
    log.error('[dot.li protocol] Chain death detected, signaling fatal');
    if (window.parent !== window) {
      window.parent.postMessage(
        {
          namespace: 'dotli:protocol',
          kind: 'fatal',
          message,
        },
        '*',
      );
    }
  });

  // Forward what the chains report about their sync to the host shell, so
  // the loading screen moves on real signals instead of log-scraped prose.
  // This iframe owns the smoldot instance. The host has no handle on it.
  onChainSync(event => {
    if (window.parent === window) {
      return;
    }
    const { chain, kind, ...rest } = event;
    window.parent.postMessage(
      {
        namespace: 'dotli:protocol',
        kind: 'chain-sync',
        chain,
        syncKind: kind,
        ...rest,
      },
      '*',
    );
  });

  // Telemetry-only facts, forwarded on the same window as the sync stream so
  // the host can hang them off the resolution it is already tracing.
  resolve.onChainDetail(detail => {
    if (window.parent === window) {
      return;
    }
    window.parent.postMessage({ namespace: 'dotli:protocol', kind: 'chain-detail', ...detail }, '*');
  });

  // Feed the host speed readout. Cumulative totals on a fixed tick rather
  // than a rate, so the host owns the averaging and a dropped message just
  // widens one window.
  if (window.parent !== window) {
    const postBytes = (): void => {
      window.parent.postMessage(
        {
          namespace: 'dotli:protocol',
          kind: 'net-bytes',
          received: chainBytesReceived(),
        },
        '*',
      );
    };
    // Send a baseline straight away. A rate needs two readings, so waiting a
    // full tick for the first one delayed the whole readout by 500ms on top
    // of the time this iframe took to boot.
    postBytes();
    const reportBytes = setInterval(postBytes, 500);
    window.addEventListener('pagehide', () => {
      clearInterval(reportBytes);
    });
  }

  // Direct mode owns its light client, so its warm-start outcome goes straight
  // up to the host shell that tags resolution telemetry with it.
  onSmoldotDbOutcome((chain, outcome) => {
    if (window.parent !== window) {
      window.parent.postMessage(
        {
          namespace: 'dotli:protocol',
          kind: 'smoldot-db',
          chain,
          outcome,
        },
        '*',
      );
    }
  });

  const engine = createEngine({
    createChainProvider,
    isChainSupported,
    // Releasing a smoldot chain makes the light client drop it and re-sync later.
    destroyDelay: Infinity,
    onBrokerReady: broker => {
      // Two chains nothing else opens in time, for two different reasons.
      //
      // The relay reports the warp progress the loading bar moves on, but papi
      // never reads it: smoldot runs it as the parent of the parachains, so
      // without this no tap ever attaches to it.
      //
      // Bulletin serves the content, and is otherwise created by the first
      // `bitswap_v1_get` after the name resolves. That request goes out before
      // the chain has a single peer and always loses its first attempt to
      // "No Bitswap peers connected". Opening it here lets it find peers while
      // the name is still resolving, so the content fetch starts against a warm
      // chain. The cost is one chain connection on loads that turn out to be
      // served from the archive cache and never needed Bulletin at all.
      //
      // Leases on the pool, so the watched chains are the very connections
      // everything else on these chains shares.
      const stopWatching = observeChains(broker, [services.relay.genesis, services.bulletin.genesis]);
      window.addEventListener('pagehide', stopWatching);
      // Route the resolver's Asset Hub reads AND the People warm-keep through
      // the broker's shared follows so they reuse the broker's single follow per
      // chain instead of opening their own (see protocol-shared-worker).
      setResolverAssetHubProvider(() =>
        requireBrokerLocalProvider(broker, getActiveServicesConfig().assethub.genesis, 'Asset Hub'),
      );
      setResolverPeopleProvider(() =>
        requireBrokerLocalProvider(broker, getActiveServicesConfig().people.genesis, 'People'),
      );
    },
    onWarmup: () => {
      // Warm People in the background so legacy-account auth reads do not race
      // a cold parachain warp sync. Not needed for resolution, so do not await.
      // The shared worker does the same at its own pre-sync.
      void waitForPeopleFinalized().catch((err: unknown) => {
        log.warn(`[dot.li protocol] People chain warm failed (retried on demand): ${String(err)}`);
      });
      return Promise.resolve();
    },
    resolveDotName,
    resolveOwner,
    resolveSeitySlot,
    resolveExecutableManifest,
    resolveRootManifest,
  });

  bindEngineToMessages(engine);
  signalReady();

  window.addEventListener('beforeunload', () => {
    engine.cleanup();
  });
}

// No smoldot. Sandboxed app chain requests are bridged to a trusted WSS
// JSON-RPC endpoint via the shared broker. Name resolution in gateway mode
// happens in the host process (see `@dotli/resolver/rpc-resolve`), not via
// this iframe, so `resolveDotName` and `resolveOwner` requests aren't wired
// up here. The host never sends them when gateway is active.

function initRpcMode(): void {
  log.warn('[dot.li protocol] === RPC MODE ===');
  log.warn('[dot.li protocol] Chain calls routed via WSS JSON-RPC (no smoldot)');

  const engine = createEngine({
    // The core set rather than the advertised one, so the network panel can
    // watch Bulletin blocks over its configured RPC. Advertisement to dApps
    // stays curated separately in `isRemoteChainSupported`.
    createChainProvider: createCoreRpcChainProvider,
    isChainSupported: isCoreRpcChainSupported,
    // An unused RPC chain's socket closes a minute after its last connection.
    destroyDelay: 60_000,
    // No resolver: gateway-mode resolution doesn't go through this iframe.
  });

  bindEngineToMessages(engine);
  signalReady();

  window.addEventListener('beforeunload', () => {
    engine.cleanup();
  });
}

function bindEngineToMessages(engine: ProtocolEngine): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== 'request') {
      return;
    }
    if (
      isSharedAuthRequestMethod(data.method) ||
      isSharedModeRequestMethod(data.method) ||
      data.method === 'walletStorage' ||
      data.method === 'coreCustody' ||
      data.method === 'walletOwner'
    ) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(`[dot.li protocol] Rejected request from disallowed origin: ${event.origin}`);
      return;
    }

    void engine
      .handleRequest(data, event.origin, response => {
        postToSource(event.source, event.origin, response);
      })
      .catch((error: unknown) => {
        log.error('[dot.li protocol] Request failed:', error);
        const name = errorName(error);
        postToSource(event.source, event.origin, {
          namespace: 'dotli:protocol',
          kind: 'response',
          id: data.id,
          ok: false,
          error: serializeError(error),
          ...(name !== undefined ? { errorName: name } : {}),
        });
      });
  });
}

function assertSharedAuthSiteId(value: unknown): asserts value is SiteId {
  if (typeof value !== 'string' || !isSharedAuthSiteId(value)) {
    throw new Error(`Invalid siteId: ${String(value)}`);
  }
}

function assertSharedAuthKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isValidSharedAuthKey(value)) {
    throw new Error(`Invalid shared auth key: ${String(value)}`);
  }
}

function assertSharedAuthOrigin(origin: string): void {
  if (!isSharedAuthOriginAllowed(origin)) {
    throw new Error(`Shared auth request denied from origin: ${origin}`);
  }
}

function assertSharedModeKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isValidSharedModeKey(value)) {
    throw new Error(`Invalid shared mode key: ${String(value)}`);
  }
}

/**
 * The shared mode-storage trust boundary is identical to shared auth: any
 * subdomain of the registrable root may read/write, sandboxed app
 * subdomains may not, and the siteId must match `SITE_ID`. Re-using the
 * auth checks keeps the gate consistent and avoids drift.
 */
function handleSharedModeRequest(request: ProtocolRequestEnvelope, origin: string, respond: ResponseCallback): void {
  if (!isSharedModeRequestMethod(request.method)) {
    throw new Error(`Not a shared mode request: ${request.method as string}`);
  }

  assertSharedAuthOrigin(origin);

  switch (request.method) {
    case 'modeStorageRead': {
      const payload = request.payload as ProtocolRequestMap['modeStorageRead'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedModeKey(payload.key);
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: localStorage.getItem(buildSharedModeStorageKey(payload.siteId, payload.key)),
      });
      return;
    }

    case 'modeStorageWrite': {
      const payload = request.payload as ProtocolRequestMap['modeStorageWrite'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedModeKey(payload.key);
      if (typeof payload.value !== 'string') {
        throw new Error(PROTOCOL_APP_ERRORS.INVALID_SHARED_MODE_VALUE);
      }
      localStorage.setItem(buildSharedModeStorageKey(payload.siteId, payload.key), payload.value);
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case 'modeStorageClear': {
      const payload = request.payload as ProtocolRequestMap['modeStorageClear'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedModeKey(payload.key);
      localStorage.removeItem(buildSharedModeStorageKey(payload.siteId, payload.key));
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }
  }
}

function bindSharedModeListener(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== 'request' || !isSharedModeRequestMethod(data.method)) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(`[dot.li protocol] Rejected shared-mode request from disallowed origin: ${event.origin}`);
      countSharedReject('mode', 'origin');
      return;
    }

    try {
      handleSharedModeRequest(data, event.origin, response => {
        postToSource(event.source, event.origin, response);
      });
    } catch (error: unknown) {
      countSharedReject('mode', 'validation');
      const name = errorName(error);
      postToSource(event.source, event.origin, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: data.id,
        ok: false,
        error: serializeError(error),
        ...(name !== undefined ? { errorName: name } : {}),
      });
    }
  });
}

function withSharedAuthSlot<T>(siteId: SiteId, key: string, operation: () => T | Promise<T>): Promise<T> {
  if (typeof navigator.locks === 'undefined') {
    return Promise.reject(new Error('Atomic shared auth storage is unavailable'));
  }
  return navigator.locks.request(`dotli:core-slot:${buildSharedAuthStorageKey(siteId, key)}`, operation);
}

async function handleSharedAuthRequest(
  request: ProtocolRequestEnvelope,
  origin: string,
  respond: ResponseCallback,
): Promise<void> {
  if (!isSharedAuthRequestMethod(request.method)) {
    throw new Error(`Not a shared auth request: ${request.method as string}`);
  }

  assertSharedAuthOrigin(origin);

  switch (request.method) {
    case 'authStorageRead': {
      const payload = request.payload as ProtocolRequestMap['authStorageRead'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: localStorage.getItem(buildSharedAuthStorageKey(payload.siteId, payload.key)),
      });
      return;
    }

    case 'authStorageWrite': {
      const payload = request.payload as ProtocolRequestMap['authStorageWrite'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      if (typeof payload.value !== 'string') {
        throw new Error(PROTOCOL_APP_ERRORS.INVALID_SHARED_AUTH_VALUE);
      }
      const { siteId, key, value } = payload;
      const commit = (): void => {
        localStorage.setItem(buildSharedAuthStorageKey(siteId, key), value);
        broadcastSharedAuthChange(siteId, key, value);
      };
      await withSharedAuthSlot(siteId, key, async () => {
        if (payload.walletRevision !== undefined) {
          if (!DEBUG) {
            throw new Error('Experimental wallets require a debug build');
          }
          await withSharedWalletRevision(payload.walletRevision, commit, request.deadlineMs);
        } else {
          commit();
        }
      });
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case 'authStorageClear': {
      const payload = request.payload as ProtocolRequestMap['authStorageClear'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      await withSharedAuthSlot(payload.siteId, payload.key, () => {
        localStorage.removeItem(buildSharedAuthStorageKey(payload.siteId, payload.key));
        broadcastSharedAuthChange(payload.siteId, payload.key, null);
      });
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }
    case 'authStorageCompareExchange': {
      const payload = request.payload as ProtocolRequestMap['authStorageCompareExchange'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      if (
        payload.key !== SHARED_CORE_SESSION_KEY ||
        !(payload.replacement instanceof Uint8Array) ||
        (payload.expected !== null && !(payload.expected instanceof Uint8Array))
      ) {
        throw new Error('Invalid shared core storage compare-exchange');
      }
      const { expected, replacement } = payload;
      const result = await withSharedAuthSlot(payload.siteId, payload.key, () => {
        const slot = buildSharedAuthStorageKey(payload.siteId, payload.key);
        const raw = localStorage.getItem(slot);
        const current = raw === null ? null : fromHex(raw);
        const matches =
          current === null || expected === null
            ? current === expected
            : current.length === expected.length && current.every((byte, index) => byte === expected[index]);
        if (!matches) {
          return false;
        }
        const value = toHex(replacement);
        localStorage.setItem(slot, value);
        broadcastSharedAuthChange(payload.siteId, payload.key, value);
        return true;
      });
      respond({ namespace: 'dotli:protocol', kind: 'response', id: request.id, ok: true, result });
      return;
    }
  }
}

bindSharedAuthListener();
bindSharedAuthBroadcastRelay();
bindSharedModeListener();
bindSharedWalletListener();

void init().catch((err: unknown) => {
  log.error('[dot.li protocol] Init failed:', err);
  signalError(err instanceof Error ? err.message : String(err));
});
