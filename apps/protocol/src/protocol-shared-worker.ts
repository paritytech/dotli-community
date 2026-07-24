// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Protocol SharedWorker — leader-aware message ROUTER.
//
// smoldot no longer runs here. `RTCPeerConnection` does not exist in a
// SharedWorker scope, so a light client running in the worker cannot use its
// WebRTC transport. Instead, exactly one `host.<BASE>` iframe is elected
// leader (via the Web Locks API, see `main.ts`) and runs smoldot on its own
// Window main thread, where WebRTC is available. Every same-origin protocol
// iframe (one per tab) still attaches to this one SharedWorker, but its only
// job now is routing: forward each follower iframe's protocol requests to the
// leader, and route the leader's responses (including async chain-messages)
// back to the originating follower.
//
// Routing is by an integer `clientId`, assigned to each connecting port. A
// follower's requests are forwarded to the leader tagged with its clientId;
// the leader echoes that id on every response so we can post it back to the
// right follower port. The router never inspects request payloads.
//
// Failover: when the leader's port closes (its tab went away), the Web Lock
// releases and a queued follower is promoted; it presyncs a fresh smoldot
// (warm-started from the shared-origin IndexedDB) and registers here with a
// new `leader-ready`. Requests that arrive during the gap are buffered and
// flushed to the new leader.

/// <reference lib="webworker" />
declare const self: SharedWorkerGlobalScope;

import { m } from "@dotli/metrics/metrics";
import { initSentry, installGlobalErrorHandlers } from "@dotli/metrics/sentry";
import type {
  ProtocolRequestEnvelope,
  ProtocolEnvelope,
} from "@dotli/protocol/messages";

initSentry("worker");
installGlobalErrorHandlers("worker");
m.setDefaults({ protocol_mode: "shared-worker" });

const NETWORK_NAME_PREFIX = "dotli-protocol-";
const network = self.name.startsWith(NETWORK_NAME_PREFIX)
  ? self.name.slice(NETWORK_NAME_PREFIX.length)
  : null;
if (network !== null) {
  m.setDefaults({ network });
}

// ---------------------------------------------------------------------------
// Wire envelopes on the iframe <-> SharedWorker MessagePort.
//
// `SWRelayRequest` / `SWRelayResponse` / `SWReady` / `SWError` are the
// follower-facing messages (shapes unchanged from the pre-router protocol, so
// the follower relay in `main.ts` is a near drop-in). The `SWLeader*`
// messages are the router <-> leader control channel.
// ---------------------------------------------------------------------------

/** Follower -> router: a protocol request from the follower's parent tab. */
export interface SWRelayRequest {
  type: "relay-request";
  envelope: ProtocolRequestEnvelope;
  origin: string;
}
/** Router -> follower: a protocol response/notification for its parent tab. */
export interface SWRelayResponse {
  type: "relay-response";
  envelope: ProtocolEnvelope;
}
/** Router -> follower: a leader is presynced; the follower may signal ready. */
export interface SWReady {
  type: "ready";
}
/** Router -> follower: the leader failed to initialize; surface the cause. */
export interface SWError {
  type: "error";
  message: string;
}
/** Leader -> router: "I hold the lock and am presynced; route to me." */
export interface SWLeaderReady {
  type: "leader-ready";
}
/**
 * Leader -> router: posted the instant a (promoted) iframe wins the lock,
 * before it presyncs. Preempts the prior stale leader so follower forwards
 * buffer instead of being posted into the dead port during the gap.
 */
export interface SWLeaderClaiming {
  type: "leader-claiming";
}
/** Leader -> router: presync failed; fail every waiting follower. */
export interface SWLeaderError {
  type: "leader-error";
  message: string;
}
/** Router -> leader: a follower request to handle, tagged with its clientId. */
export interface SWLeaderForward {
  type: "leader-forward";
  clientId: number;
  envelope: ProtocolRequestEnvelope;
  origin: string;
}
/** Leader -> router: a response destined for the follower `clientId`. */
export interface SWLeaderResponse {
  type: "leader-response";
  clientId: number;
  envelope: ProtocolEnvelope;
}
/** Router -> leader: a follower disconnected; release its chain connections. */
export interface SWClientGone {
  type: "client-gone";
  clientId: number;
}
/** Router -> follower: the leader went away; a new one is being elected. */
export interface SWLeaderChanged {
  type: "leader-changed";
}
/** Follower -> router: explicit disconnect from the iframe's `beforeunload`. */
export interface SWDisconnect {
  type: "disconnect";
}

/** Messages the router RECEIVES from a port (follower or leader). */
export type SWInbound =
  | SWRelayRequest
  | SWLeaderClaiming
  | SWLeaderReady
  | SWLeaderError
  | SWLeaderResponse
  | SWDisconnect;
/** Messages an iframe may RECEIVE from the router (follower- or leader-role). */
export type SWOutbound =
  | SWRelayResponse
  | SWReady
  | SWError
  | SWLeaderForward
  | SWClientGone
  | SWLeaderChanged;

const TAG = "[dot.li SW router]";
function swLog(...args: unknown[]): void {
  console.warn(TAG, ...args);
}
function swError(...args: unknown[]): void {
  console.error(TAG, ...args);
}

// The single leader port, plus every follower keyed by its clientId. The
// leader's own port is NOT in `clientPorts` (it is not a follower). While no
// leader is registered, follower forwards accumulate in `pendingForwards` and
// flush on the next `leader-ready` — the direct analog of the old presync
// `pendingPorts` queue.
let leaderPort: MessagePort | null = null;
let leaderReady = false;
let leaderError: string | null = null;
let clientIdCounter = 0;
const allPorts = new Set<MessagePort>();
const clientPorts = new Map<number, MessagePort>();
const portToClientId = new Map<MessagePort, number>();
const pendingForwards: SWLeaderForward[] = [];

function postTo(port: MessagePort, msg: SWOutbound): void {
  try {
    port.postMessage(msg);
  } catch (err: unknown) {
    // A closed port throws `InvalidStateError`; drop it. Anything else is a
    // real bug (e.g. a non-cloneable payload) — log it but still remove the
    // port, since we can no longer deliver to it.
    const name = err instanceof Error ? err.name : "";
    if (name !== "InvalidStateError") {
      swError(`postMessage failed (name=${name || "<unknown>"}):`, err);
    }
    removePort(port);
  }
}

function broadcastToFollowers(msg: SWOutbound): void {
  for (const port of clientPorts.values()) {
    postTo(port, msg);
  }
}

function handleLeaderClaiming(port: MessagePort): void {
  // A promotion is underway. Stop routing to any prior (now-stale) leader and
  // buffer follower forwards until this claimant finishes presync and posts
  // `leader-ready`. Drop the claimant's own follower identity.
  const cid = portToClientId.get(port);
  if (cid !== undefined) {
    clientPorts.delete(cid);
    portToClientId.delete(port);
  }
  leaderPort = null;
  leaderReady = false;
  leaderError = null;
  swLog("Leader claiming; buffering forwards until presync completes");
}

function handleLeaderReady(port: MessagePort): void {
  if (leaderPort !== null && leaderPort !== port) {
    // A previous leader crashed without a clean disconnect. Replace it.
    swLog("Replacing a stale leader port");
  }
  // The leader is not a follower: drop the provisional clientId it got on
  // connect so we never route follower traffic (or `client-gone`) to it.
  const cid = portToClientId.get(port);
  if (cid !== undefined) {
    clientPorts.delete(cid);
    portToClientId.delete(port);
  }
  leaderPort = port;
  leaderReady = true;
  leaderError = null;
  swLog(`Leader ready (${String(clientPorts.size)} follower(s) waiting)`);

  // Flush follower requests buffered during the election/presync gap.
  const buffered = pendingForwards.splice(0);
  for (const fwd of buffered) {
    postTo(port, fwd);
  }
  // Release every waiting follower.
  broadcastToFollowers({ type: "ready" });
}

function handleLeaderError(message: string): void {
  leaderError = message;
  leaderReady = false;
  swError(`Leader init failed: ${message}`);
  pendingForwards.length = 0;
  broadcastToFollowers({ type: "error", message });
}

function routeLeaderResponse(data: SWLeaderResponse): void {
  // The follower may have closed between request and response. Drop silently.
  const port = clientPorts.get(data.clientId);
  if (port !== undefined) {
    postTo(port, { type: "relay-response", envelope: data.envelope });
  }
}

function forwardToLeader(
  clientId: number,
  envelope: ProtocolRequestEnvelope,
  origin: string,
): void {
  const fwd: SWLeaderForward = {
    type: "leader-forward",
    clientId,
    envelope,
    origin,
  };
  if (leaderPort !== null && leaderReady) {
    postTo(leaderPort, fwd);
    return;
  }
  if (leaderError !== null) {
    // Election already failed; reject fast instead of hanging the follower.
    const port = clientPorts.get(clientId);
    if (port !== undefined) {
      postTo(port, {
        type: "relay-response",
        envelope: {
          namespace: "dotli:protocol",
          kind: "response",
          id: envelope.id,
          ok: false,
          error: `Protocol leader unavailable: ${leaderError}`,
        },
      });
    }
    return;
  }
  // Election/presync in progress. Buffer; flushed on `leader-ready`.
  pendingForwards.push(fwd);
}

function removePort(port: MessagePort): void {
  if (!allPorts.delete(port)) {
    return;
  }
  const cid = portToClientId.get(port);
  if (cid !== undefined) {
    clientPorts.delete(cid);
    portToClientId.delete(port);
    // Drop any of this follower's forwards still buffered for the next
    // leader. Flushing them would make that leader open connections for a
    // tab that no longer exists — and since this clientId is forgotten here,
    // no `client-gone` could ever release them (a leak against the cap).
    for (let i = pendingForwards.length - 1; i >= 0; i--) {
      if (pendingForwards[i]?.clientId === cid) {
        pendingForwards.splice(i, 1);
      }
    }
    // Tell the leader to release this follower's chain connections so they
    // don't leak against the global connection cap.
    if (leaderPort !== null && leaderPort !== port) {
      postTo(leaderPort, { type: "client-gone", clientId: cid });
    }
  }
  if (port === leaderPort) {
    swLog("Leader port closed; awaiting re-election");
    leaderPort = null;
    leaderReady = false;
    // Followers' connections are now dead. A queued follower will win the
    // Web Lock and re-register; meanwhile new forwards buffer.
    broadcastToFollowers({ type: "leader-changed" });
  }
}

// Ping every port; a throwing post means the port is dead. Runs on each new
// connection so reloaded iframes don't linger in the registries.
function cleanStalePorts(): void {
  for (const port of [...allPorts]) {
    try {
      port.postMessage({ type: "ping" });
    } catch {
      swLog("Reaping a stale port");
      removePort(port);
    }
  }
}

function routeInbound(port: MessagePort, clientId: number, data: unknown): void {
  const type = (data as { type?: string } | null)?.type;
  // if/else (not switch) because these are loosely-typed wire messages and we
  // deliberately ignore "ping" and anything unrecognized.
  if (type === "disconnect") {
    removePort(port);
  } else if (type === "leader-claiming") {
    handleLeaderClaiming(port);
  } else if (type === "leader-ready") {
    handleLeaderReady(port);
  } else if (type === "leader-error") {
    handleLeaderError((data as SWLeaderError).message);
  } else if (type === "leader-response") {
    routeLeaderResponse(data as SWLeaderResponse);
  } else if (type === "relay-request") {
    const req = data as SWRelayRequest;
    forwardToLeader(clientId, req.envelope, req.origin);
  }
}

self.addEventListener("connect", (event) => {
  const port = event.ports[0];
  cleanStalePorts();

  const clientId = clientIdCounter++;
  allPorts.add(port);
  // Register provisionally as a follower. If this port turns out to be the
  // leader, `handleLeaderReady` removes it from `clientPorts`.
  clientPorts.set(clientId, port);
  portToClientId.set(port, clientId);

  port.addEventListener("message", (e: MessageEvent) => {
    routeInbound(port, clientId, e.data);
  });
  port.start();

  swLog(
    `Port connected (clientId=${String(clientId)}, ${String(allPorts.size)} total, leader ${leaderReady ? "ready" : "pending"})`,
  );

  // If a leader is already serving, this connector is a follower: release it
  // immediately. Otherwise it waits for the leader-ready broadcast (or the
  // leader-error path).
  if (leaderReady) {
    postTo(port, { type: "ready" });
  } else if (leaderError !== null) {
    postTo(port, { type: "error", message: leaderError });
  }
});

swLog(`Router initialized (network=${network ?? "<unknown>"})`);
