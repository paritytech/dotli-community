// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dotli-internal debug events
//
// Events emitted by dotli host-side logic that is independent of the
// TrUAPI transport: boot orchestration, resolver phases, render +
// bridge-setup lifecycles, and backend failover decisions. These
// complement the TrUAPI host-to-product message events.
//
// Events are point-in-time OR paired start/end. The consumer decides
// rendering: multi-event flows (same `flowId`) become boxes, single-
// event flows become pills.

export type DotliDebugEvent =
  | BootEvent
  | ResolveEvent
  | RenderEvent
  | BridgeEvent
  | FailoverEvent
  | MainEvent
  | SandboxEvent;

/** Sandbox (<label>.app.dot.li) lifecycle. These events originate in the
 *  sandbox iframe and are forwarded to the host's debug bus via
 *  `postMessage({ type: "dotli:debug-event", event })`.
 *
 *  The sandbox-side flow is opaque to the host otherwise: the host
 *  creates the iframe, sets `iframe.src`, and then has to wait for the
 *  product to finish loading and start talking over the TrUAPI bridge.
 *  Typical "host is silent for 15 seconds" windows are actually the
 *  sandbox fetching the CID's archive from the bulletin chain and
 *  staging it in the service worker, fully invisible from the host
 *  unless these events are surfaced. */
export type SandboxEvent =
  | {
      layer: "sandbox";
      event: "started";
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        contentBackend: string;
      };
    }
  | {
      layer: "sandbox";
      event: "sw_register_begin";
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        waitForFreshController: boolean;
      };
    }
  | {
      layer: "sandbox";
      event: "sw_ready";
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        durationMs: number;
      };
    }
  | {
      layer: "sandbox";
      event: "cache_checked";
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        hit: boolean;
        fileCount?: number;
      };
    }
  | {
      layer: "sandbox";
      event: "fetch_begin";
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        contentBackend: string;
      };
    }
  | {
      layer: "sandbox";
      event: "helia_ready";
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        durationMs: number;
      };
    }
  | {
      layer: "sandbox";
      event: "status";
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        /** Human-readable status string that the sandbox uses to
         *  update its own loading overlay; mirrored here so the
         *  progress stream is visible in the system swimlane. */
        message: string;
      };
    }
  | {
      layer: "sandbox";
      event: "fetch_complete";
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        kind: "single" | "archive";
        durationMs: number;
      };
    }
  | {
      layer: "sandbox";
      event: "decrypt_started";
      flowId: string;
      timestamp: number;
      payload: { cid: string };
    }
  | {
      layer: "sandbox";
      event: "decrypt_complete";
      flowId: string;
      timestamp: number;
      payload: { cid: string };
    }
  | {
      layer: "sandbox";
      event: "archive_stored";
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        fileCount: number;
        durationMs: number;
      };
    }
  | {
      layer: "sandbox";
      event: "document_written";
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        totalMs: number;
      };
    }
  | {
      layer: "sandbox";
      event: "failed";
      flowId: string;
      timestamp: number;
      payload: {
        cid: string | null;
        reason: string;
      };
    };

/** Host main-thread diagnostics. Intended to reveal "what is the host
 *  doing right now" windows that would otherwise show as empty in the
 *  system swimlane. */
export type MainEvent =
  | {
      layer: "main";
      event: "stall_detected";
      flowId: string;
      timestamp: number;
      payload: {
        /** How long the event loop was unable to service the tick
         *  timer. Values above ~200ms mean the main thread was
         *  blocked (synchronous work, frozen microtask chain,
         *  heavy WASM init, etc.). */
        durationMs: number;
      };
    }
  | {
      layer: "main";
      event: "heartbeat";
      flowId: string;
      timestamp: number;
      payload: {
        /** Seconds since the monitor started. Useful for visualising
         *  "we got this far without stalling". */
        uptimeSec: number;
      };
    }
  | {
      layer: "main";
      event: "monitor_stopped";
      flowId: string;
      timestamp: number;
      payload: {
        reason: "bridge_ready" | "max_duration";
      };
    };

/** High-level orchestration of the host's boot sequence (per tab). */
export type BootEvent =
  | {
      layer: "boot";
      event: "started";
      flowId: string;
      timestamp: number;
      payload: {
        chainBackend: string;
        skipCidCache: boolean;
        skipArchiveCache: boolean;
      };
    }
  | {
      layer: "boot";
      event: "protocol_warmup_started";
      flowId: string;
      timestamp: number;
      payload: { subMode: "shared-worker" | "direct" | "rpc" };
    }
  | {
      layer: "boot";
      event: "topbar_ready";
      flowId: string;
      timestamp: number;
      payload: Record<string, never>;
    }
  | {
      layer: "boot";
      event: "url_parsed";
      flowId: string;
      timestamp: number;
      payload: {
        label: string | null;
        localhostHost: string | null;
        deepPath: string;
      };
    }
  | {
      layer: "boot";
      event: "cid_cache_checked";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        hit: boolean;
        cid?: string;
      };
    }
  | {
      layer: "boot";
      event: "landing_page_shown";
      flowId: string;
      timestamp: number;
      payload: Record<string, never>;
    }
  | {
      layer: "boot";
      event: "ready";
      flowId: string;
      timestamp: number;
      payload: {
        label: string | null;
        totalMs: number;
        path: "fast" | "slow" | "localhost";
      };
    }
  | {
      layer: "boot";
      event: "failed";
      flowId: string;
      timestamp: number;
      payload: {
        label: string | null;
        reason: string;
        dependency: string;
      };
    };

/** Dot-name resolution. Covers both smoldot (P2P) and RPC paths. */
export type ResolveEvent =
  | {
      layer: "resolve";
      event: "started";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        source: "smoldot" | "rpc-gateway";
      };
    }
  | {
      layer: "resolve";
      event: "phase";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        phase: string;
        message: string;
      };
    }
  | {
      layer: "resolve";
      event: "storage_read";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        bytes: number;
        durationMs: number;
      };
    }
  | {
      layer: "resolve";
      event: "completed";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        source: "smoldot" | "rpc-gateway";
        cid: string | null;
        durationMs: number;
      };
    }
  | {
      layer: "resolve";
      event: "failed";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        source: "smoldot" | "rpc-gateway";
        reason: string;
      };
    };

/** Iframe render lifecycle (renderIframe / renderAppSubdomain). */
export type RenderEvent =
  | {
      layer: "render";
      event: "iframe_begin";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        url: string;
        mode: "iframe" | "subdomain" | "localhost";
      };
    }
  | {
      layer: "render";
      event: "iframe_ready";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        mode: "iframe" | "subdomain" | "localhost";
      };
    };

/** Container bridge setup (TrUAPI bridge, per dApp iframe). */
export type BridgeEvent =
  | {
      layer: "bridge";
      event: "setup_begin";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        productId: string;
      };
    }
  | {
      layer: "bridge";
      event: "setup_ready";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        productId: string;
      };
    }
  | {
      layer: "bridge";
      event: "iframe_load";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        productId: string;
        mode: "iframe" | "subdomain";
      };
    }
  | {
      layer: "bridge";
      event: "first_inbound";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        productId: string;
      };
    }
  | {
      layer: "bridge";
      event: "first_outbound";
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        productId: string;
      };
    };

/** Backend failover decisions (chain backend switch on resolution error). */
export interface FailoverEvent {
  layer: "failover";
  event: "chain_backend";
  flowId: string;
  timestamp: number;
  payload: {
    from: string;
    to: string;
    reason: string;
  };
}
