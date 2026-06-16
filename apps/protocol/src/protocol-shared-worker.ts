// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Protocol SharedWorker.
//
// Runs smoldot directly on the SharedWorker thread using `start()` from
// `polkadot-api/smoldot` (no sub-Worker needed, because the `Worker`
// constructor is not available in SharedWorkerGlobalScope).
//
// All protocol iframes (across all tabs) connect via MessagePort.
// Smoldot persists as long as at least one tab is open.

/// <reference lib="webworker" />
declare const self: SharedWorkerGlobalScope;

import type { StringJsonRpcConnection } from "@dotli/protocol/broker";
import { MAX_CONNECTIONS_PER_ORIGIN } from "@dotli/config/config";
import {
  isValidNetwork,
  setNetworkOverride,
  getActiveServicesConfig,
} from "@dotli/config/network";
import { createChainProvider, isChainSupported } from "@dotli/resolver/chains";
import {
  getRelayChain,
  getSmoldotDirect,
  resolveDotName,
  resolveExecutableManifest,
  resolveOwner,
  resolveRootManifest,
  setResolverAssetHubProvider,
  setResolverPeopleProvider,
  waitForAssetHubFinalized,
  waitForPeopleFinalized,
} from "@dotli/resolver/resolve";
import { onSmoldotFatal } from "@dotli/resolver/smoldot";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { initSentry, installGlobalErrorHandlers } from "@dotli/metrics/sentry";
import {
  createChainBrokerManager,
  requireBrokerLocalProvider,
} from "@dotli/protocol/broker";
import { serializeError } from "@dotli/shared/errors";

/** Bridge-boundary allowlist for executable-manifest kinds. */
const EXECUTABLE_KINDS = new Set(["app", "widget", "worker"]);

initSentry("worker");
installGlobalErrorHandlers("worker");
// Only ever runs in shared-worker mode. Tag every metric emitted from this
// context so broker/smoldot counters aggregate cleanly with the iframe's.
m.setDefaults({ protocol_mode: "shared-worker" });
import {
  isSharedAuthRequestMethod,
  isSharedModeRequestMethod,
} from "@dotli/protocol/auth-storage";
import type {
  ProtocolRequestEnvelope,
  ProtocolRequestMap,
  ProtocolEnvelope,
} from "@dotli/protocol/messages";

export interface SWRelayRequest {
  type: "relay-request";
  envelope: ProtocolRequestEnvelope;
  origin: string;
}

export interface SWRelayResponse {
  type: "relay-response";
  envelope: ProtocolEnvelope;
}

export interface SWReady {
  type: "ready";
}

export interface SWError {
  type: "error";
  message: string;
}

export type SWInbound = SWRelayRequest;
export type SWOutbound = SWRelayResponse | SWReady | SWError;

const TAG = "[dot.li SW]";

function swLog(...args: unknown[]): void {
  console.warn(TAG, ...args);
}

function swError(...args: unknown[]): void {
  console.error(TAG, ...args);
}

const MAX_CHAIN_CONNECTIONS = 10;
const chainConnections = new Map<string, StringJsonRpcConnection>();
const originConnections = new Map<string, Set<string>>();
const connectionPorts = new Map<string, MessagePort>();
const ports = new Set<MessagePort>();
const pendingPorts: MessagePort[] = [];
let engineReady = false;

const NETWORK_NAME_PREFIX = "dotli-protocol-";
let networkInitFailure: string | null = null;
const requestedNetwork = self.name.startsWith(NETWORK_NAME_PREFIX)
  ? self.name.slice(NETWORK_NAME_PREFIX.length)
  : null;
if (requestedNetwork === null) {
  networkInitFailure = `Unexpected SharedWorker name "${self.name}" — iframe did not encode the active network.`;
} else if (!isValidNetwork(requestedNetwork)) {
  networkInitFailure = `Unknown protocol network: "${requestedNetwork}"`;
} else {
  setNetworkOverride(requestedNetwork);
  m.setDefaults({ network: requestedNetwork });
  swLog(`Active network pinned to ${requestedNetwork}`);
}

// Placeholder broker manager until pre-sync creates the real one.
let chainBrokerManager: ReturnType<typeof createChainBrokerManager>;

// Smoldot panic broadcast. When smoldot's log callback detects a WASM
// panic, relay a `fatal` envelope to every connected port so the host
// client rejects every in-flight request immediately instead of waiting
// for a per-request timeout. `onSmoldotFatal` is idempotent and replays
// the last panic to late subscribers, so firing this once at module
// load is enough for the lifetime of the SharedWorker.
onSmoldotFatal((message) => {
  swError(
    `Smoldot panic detected, broadcasting fatal to ${String(ports.size)} port(s)`,
  );
  const fatal: ProtocolEnvelope = {
    namespace: "dotli:protocol",
    kind: "fatal",
    message,
  };
  const msg: SWRelayResponse = { type: "relay-response", envelope: fatal };
  for (const port of ports) {
    try {
      port.postMessage(msg);
      // eslint-disable-next-line no-restricted-syntax -- defensive fatal broadcast: one closed port must not prevent delivery to the rest. `removePort` already cleans up ports that throw on later sends.
    } catch {
      /* port already disconnected, ignore on broadcast */
    }
  }
});

// NO retries. NO cleanup-and-retry. NO backoff. The user picked
// smoldot-shared-worker. If presync fails the actual cause is surfaced to
// every waiting port and the engine stays dead until the user reloads.

let presyncFailureMessage: string | null = null;

async function presync(): Promise<void> {
  const t0 = performance.now();
  m.breadcrumb("smoldot presync starting");

  try {
    // 1. Create smoldot on the SharedWorker's own thread.
    //
    // `getSmoldotDirect()` is the in-thread smoldot bootstrap helper. The
    // name is a polkadot-api convention meaning "run smoldot on the
    // current execution context", NOT the dot.li chain backend named
    // "smoldot-direct". Inside a SharedWorker the `Worker` constructor
    // is unavailable, so this is the only option. The chain backend the
    // user picked is still honored via the iframe's `?mode=` param.
    swLog("Creating smoldot on SharedWorker thread...");
    getSmoldotDirect();
    m.measure(S.SMOLDOT_CREATE, performance.now() - t0);
    swLog(
      `Smoldot client created (${String(Math.round(performance.now() - t0))}ms)`,
    );

    // 2. Add relay chain
    swLog("Adding relay chain...");
    const relayT0 = performance.now();
    await getRelayChain();
    m.measure(S.SMOLDOT_RELAY_CHAIN, performance.now() - relayT0);
    swLog(
      `Relay chain added (${String(Math.round(performance.now() - t0))}ms)`,
    );

    // 3. Create the broker FIRST and route the resolver's Asset Hub reads
    // through it as a local session, so there is one shared Asset Hub follow
    // (never removed mid-read) instead of a separate resolver chain the first
    // dApp connection would release — the `ChainHead disjointed` load failure.
    chainBrokerManager = createChainBrokerManager(createChainProvider);
    setResolverAssetHubProvider(() =>
      requireBrokerLocalProvider(
        chainBrokerManager,
        getActiveServicesConfig().assethub.genesis,
        "Asset Hub",
      ),
    );
    // The People warm-keep must share this same broker follow. A separate
    // getSmProvider on the People chain would race the broker's follow (one
    // shared smoldot JSON-RPC queue) and have its events misrouted, so the
    // broker drops People follow events as "unknown token" and reads hang.
    setResolverPeopleProvider(() =>
      requireBrokerLocalProvider(
        chainBrokerManager,
        getActiveServicesConfig().people.genesis,
        "People",
      ),
    );

    // 4. Wait for Asset Hub to sync to a finalized block via the
    // explicit presync primitive (no more overloading `resolveDotName`
    // with a sentinel label). This now syncs the broker's shared chain.
    swLog("Waiting for Asset Hub to reach finalized block...");
    await waitForAssetHubFinalized((msg) => {
      swLog(`Pre-sync status: ${msg}`);
    });
    const totalMs = performance.now() - t0;
    m.measure(S.SMOLDOT_PRESYNC, totalMs);
    m.distribution(S.SMOLDOT_PRESYNC, totalMs);
    swLog(`Asset Hub synced (${String(Math.round(totalMs))}ms total)`);

    // 5. Success: mark ready.
    swLog("Pre-sync complete, engine ready");
    engineReady = true;

    // Signal ready to any ports that connected during pre-sync
    for (const port of pendingPorts) {
      const readyMsg: SWReady = { type: "ready" };
      port.postMessage(readyMsg);
    }
    pendingPorts.length = 0;

    // Warm the People chain in the background. Legacy-account auth reads the
    // username -> account map on People, and on a cold start that read races
    // the parachain warp sync (the source of the intermittent failures). Start
    // syncing it now so it is ready by the time auth runs. People is not needed
    // for resolution, so this must not gate the ready signal above.
    swLog("Warming People chain in background...");
    // Route the People warm-up through the broker's shared follow (mirrors
    // Asset Hub above) so it doesn't open a second competing smoldot follow.
    setResolverPeopleProvider(() =>
      requireBrokerLocalProvider(
        chainBrokerManager,
        getActiveServicesConfig().people.genesis,
        "People",
      ),
    );
    void waitForPeopleFinalized((msg) => {
      swLog(`People warm status: ${msg}`);
    })
      .then(() => {
        swLog("People chain warmed");
      })
      .catch((err: unknown) => {
        swLog(
          `People chain warm failed (retried on demand): ${serializeError(err)}`,
        );
      });
  } catch (err: unknown) {
    const msg = serializeError(err);
    swError(`Pre-sync failed: ${msg}`);
    m.count(S.SMOLDOT_PRESYNC, {
      outcome: "error",
      reason: err instanceof Error ? err.name : "unknown",
    });
    m.breadcrumb("smoldot presync failed", { reason: msg });

    // Surface the actual cause to every waiting port. Engine remains
    // permanently dead. The user must reload to retry.
    presyncFailureMessage = msg;
    for (const port of pendingPorts) {
      const errorMsg: SWError = { type: "error", message: msg };
      port.postMessage(errorMsg);
    }
    pendingPorts.length = 0;
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
}

function sendToPort(port: MessagePort, envelope: ProtocolEnvelope): void {
  try {
    const msg: SWRelayResponse = { type: "relay-response", envelope };
    port.postMessage(msg);
  } catch (err: unknown) {
    // Distinguish "port closed" (expected on tab navigation) from any
    // other postMessage failure. Closed ports throw `InvalidStateError`
    // or `DataCloneError` with `name === "InvalidStateError"`. Any other
    // cause (a structured-clone failure on an un-transferable payload,
    // for example) is a real bug and we want it visible instead of
    // silently removing an otherwise-healthy port.
    const name =
      err instanceof Error && typeof err.name === "string" ? err.name : "";
    if (name === "InvalidStateError") {
      swLog("Port closed, cleaning up");
      removePort(port);
      return;
    }
    swError(
      `sendToPort unexpected failure (name=${name || "<unknown>"}):`,
      err,
    );
    // Remove the port regardless, since we can't deliver to it. The
    // error log above preserves the real cause for triage.
    removePort(port);
  }
}

function removePort(port: MessagePort): void {
  ports.delete(port);
  let cleaned = 0;
  for (const [connId, connPort] of connectionPorts) {
    if (connPort === port) {
      const connection = chainConnections.get(connId);
      connection?.disconnect();
      chainConnections.delete(connId);
      connectionPorts.delete(connId);
      for (const [orig, conns] of originConnections) {
        conns.delete(connId);
        if (conns.size === 0) {
          originConnections.delete(orig);
        }
      }
      cleaned++;
    }
  }
  swLog(
    `Port removed (cleaned ${String(cleaned)} connections, ${String(ports.size)} ports remaining)`,
  );
}

async function handleRequest(
  port: MessagePort,
  request: ProtocolRequestEnvelope,
  origin: string,
): Promise<void> {
  const t = performance.now();
  if (isSharedAuthRequestMethod(request.method)) {
    throw new Error(
      `Shared auth requests must be handled on host.dot.li, not the SharedWorker: ${request.method}`,
    );
  }
  if (isSharedModeRequestMethod(request.method)) {
    throw new Error(
      `Shared mode-storage requests must be handled on host.dot.li, not the SharedWorker: ${request.method}`,
    );
  }

  switch (request.method) {
    case "warmup": {
      // Pre-sync already started smoldot, the relay chain, and periodic
      // saves. Just confirm it's done.
      swLog(
        `Warmup acknowledged (engine already pre-synced) (${String(Math.round(performance.now() - t))}ms)`,
      );
      sendToPort(port, {
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case "resolveDotName": {
      const payload = request.payload as ProtocolRequestMap["resolveDotName"];
      assertString(payload.label, "label");
      const result = await resolveDotName(payload.label, (message) => {
        sendToPort(port, {
          namespace: "dotli:protocol",
          kind: "progress",
          id: request.id,
          message,
        });
      });
      swLog(
        `Resolved "${payload.label}" → ${result ?? "null"} (${String(Math.round(performance.now() - t))}ms)`,
      );
      sendToPort(port, {
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result,
      });
      return;
    }

    case "resolveOwner": {
      const payload = request.payload as ProtocolRequestMap["resolveOwner"];
      assertString(payload.label, "label");
      const result = await resolveOwner(payload.label);
      swLog(
        `Owner "${payload.label}" → ${result ?? "null"} (${String(Math.round(performance.now() - t))}ms)`,
      );
      sendToPort(port, {
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result,
      });
      return;
    }

    case "resolveExecutableManifest": {
      const payload =
        request.payload as ProtocolRequestMap["resolveExecutableManifest"];
      assertString(payload.label, "label");
      // postMessage payloads are untrusted strings even though TS narrows
      // `payload.kind` to the union. Widening through Set.has keeps the
      // runtime check intact under strict TS rules.
      if (!(EXECUTABLE_KINDS as ReadonlySet<string>).has(payload.kind)) {
        throw new Error(`Unsupported executable kind: ${payload.kind}`);
      }
      const result = await resolveExecutableManifest(
        payload.label,
        payload.kind,
      );
      sendToPort(port, {
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result,
      });
      return;
    }

    case "resolveRootManifest": {
      const payload =
        request.payload as ProtocolRequestMap["resolveRootManifest"];
      assertString(payload.label, "label");
      const result = await resolveRootManifest(payload.label);
      sendToPort(port, {
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
      assertString(payload.genesisHash, "genesisHash");
      assertString(payload.connectionId, "connectionId");
      if (chainConnections.size >= MAX_CHAIN_CONNECTIONS) {
        throw new Error(
          `Connection limit reached (max ${String(MAX_CHAIN_CONNECTIONS)})`,
        );
      }
      const originConns = originConnections.get(origin) ?? new Set<string>();
      if (originConns.size >= MAX_CONNECTIONS_PER_ORIGIN) {
        throw new Error(
          `Per-origin connection limit reached (max ${String(MAX_CONNECTIONS_PER_ORIGIN)})`,
        );
      }
      if (!isChainSupported(payload.genesisHash)) {
        throw new Error(`Unsupported chain: ${payload.genesisHash}`);
      }
      // The resolver and all dApp sessions share one Asset Hub chain via the
      // broker, so there is no resolver chain to release here; connect
      // directly.
      let chainMsgCount = 0;
      const connection = chainBrokerManager.connectRemote(
        payload.genesisHash,
        payload.connectionId,
        (message) => {
          chainMsgCount++;
          if (chainMsgCount <= 5 || chainMsgCount % 100 === 0) {
            swLog(
              `Chain message #${String(chainMsgCount)} for ${payload.connectionId} (${String(message.length)} bytes)`,
            );
          }
          sendToPort(port, {
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
      chainConnections.set(payload.connectionId, connection);
      connectionPorts.set(payload.connectionId, port);
      originConns.add(payload.connectionId);
      originConnections.set(origin, originConns);
      swLog(
        `Chain connected: ${payload.connectionId} (${String(chainConnections.size)} total)`,
      );
      sendToPort(port, {
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
      assertString(payload.connectionId, "connectionId");
      assertString(payload.message, "message");
      const connection = chainConnections.get(payload.connectionId);
      if (connection === undefined) {
        throw new Error(`Unknown chain connection: ${payload.connectionId}`);
      }
      connection.send(payload.message);
      sendToPort(port, {
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case "chainDisconnect": {
      const payload = request.payload as ProtocolRequestMap["chainDisconnect"];
      assertString(payload.connectionId, "connectionId");
      const connection = chainConnections.get(payload.connectionId);
      connection?.disconnect();
      chainConnections.delete(payload.connectionId);
      connectionPorts.delete(payload.connectionId);
      for (const [orig, conns] of originConnections) {
        conns.delete(payload.connectionId);
        if (conns.size === 0) {
          originConnections.delete(orig);
        }
      }
      swLog(
        `Chain disconnected: ${payload.connectionId} (${String(chainConnections.size)} remaining)`,
      );
      sendToPort(port, {
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

// Proactively clean up stale ports by sending a ping.
// Posting to a closed port throws, and we catch that to detect dead ports.
function cleanStalePorts(): void {
  for (const p of [...ports]) {
    try {
      p.postMessage({ type: "ping" });
    } catch {
      swLog("Detected stale port during cleanup");
      removePort(p);
    }
  }
}

self.addEventListener("connect", (event) => {
  const port = event.ports[0];

  // Clean up any stale ports from previous iframe reloads
  cleanStalePorts();

  ports.add(port);
  swLog(
    `Port connected (${String(ports.size)} total, engine ${engineReady ? "ready" : "syncing"})`,
  );

  port.addEventListener("message", (msgEvent: MessageEvent) => {
    const data = msgEvent.data as { type?: string } | null;

    // Handle disconnect signal from iframe beforeunload
    if (data?.type === "disconnect") {
      swLog("Port sent disconnect signal, cleaning up");
      removePort(port);
      return;
    }

    if (data?.type !== "relay-request") {
      return;
    }

    const relayData = data as SWRelayRequest;
    const { envelope, origin } = relayData;
    void handleRequest(port, envelope, origin).catch((error: unknown) => {
      const msg = serializeError(error);
      swError(`Request ${envelope.method} failed:`, msg);
      sendToPort(port, {
        namespace: "dotli:protocol",
        kind: "response",
        id: envelope.id,
        ok: false,
        error: msg,
      });
    });
  });

  port.start();

  if (engineReady) {
    // Engine already synced, signal ready immediately.
    const readyMsg: SWReady = { type: "ready" };
    port.postMessage(readyMsg);
  } else if (presyncFailureMessage !== null) {
    // Pre-sync already failed. Surface the original cause immediately
    // instead of queuing this port forever.
    const errorMsg: SWError = {
      type: "error",
      message: presyncFailureMessage,
    };
    port.postMessage(errorMsg);
  } else {
    // Engine still syncing. Queue the port and signal when pre-sync completes.
    swLog("Engine not ready yet, queuing port for ready signal");
    pendingPorts.push(port);
  }
});

if (networkInitFailure !== null) {
  swError(networkInitFailure);
  presyncFailureMessage = networkInitFailure;
} else {
  swLog("SharedWorker initialized, starting pre-sync...");
  void presync();
}
