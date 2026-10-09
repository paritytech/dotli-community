// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The consumer renders multi-event flows (same `flowId`) as boxes and single-event flows as pills.

export type DotliDebugEvent =
  BootEvent | ResolveEvent | RenderEvent | BridgeEvent | FailoverEvent | MainEvent | SandboxEvent | ChainEvent;

/** Latest PolkaVM runtime diagnostics reported by the product sandbox.
 * Snapshots replace one another in the debug panel instead of entering the
 * event timeline, which keeps continuously sampled FPS data out of the event
 * ring buffer. */
export interface PolkaVmDebugSnapshot {
  backend: 'compiler' | 'interpreter' | 'starting';
  /** Present only when compiler startup failed, not for a forced interpreter. */
  compilerFallbackReason?: string;
  compilerFallbackStage?: string;
  cacheHit: boolean;
  translationMs: number;
  compilationMs: number;
  startupMs: number;
  startupStage: string;
  firstFrameMs: number;
  translatedWasmBytes: number;
  frames: number;
  fps: number;
  updates: number;
  updateP50Ms: number;
  updateP95Ms: number;
  updateMaxMs: number;
  audioChunks: number;
  audioSamples: number;
}

export interface PolkaVmDebugMessage {
  type: 'dotli:polkavm-metrics';
  metrics: PolkaVmDebugSnapshot;
}

/**
 * Forwarded from the sandbox iframe as `postMessage({ type: "dotli:debug-event", event })`.
 * Without them the sandbox's content fetch is a silent gap on the host.
 */
export type SandboxEvent =
  | {
      layer: 'sandbox';
      event: 'started';
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        contentBackend: string;
      };
    }
  | {
      layer: 'sandbox';
      event: 'sw_register_begin';
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        waitForFreshController: boolean;
      };
    }
  | {
      layer: 'sandbox';
      event: 'sw_ready';
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        durationMs: number;
      };
    }
  | {
      layer: 'sandbox';
      event: 'fetch_begin';
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        contentBackend: string;
      };
    }
  | {
      layer: 'sandbox';
      event: 'helia_ready';
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        durationMs: number;
      };
    }
  | {
      layer: 'sandbox';
      event: 'status';
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        /** Mirrors the sandbox's own loading overlay text. */
        message: string;
      };
    }
  | {
      layer: 'sandbox';
      event: 'fetch_complete';
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        kind: 'single' | 'archive';
        durationMs: number;
      };
    }
  | {
      layer: 'sandbox';
      event: 'decrypt_started';
      flowId: string;
      timestamp: number;
      payload: { cid: string };
    }
  | {
      layer: 'sandbox';
      event: 'decrypt_complete';
      flowId: string;
      timestamp: number;
      payload: { cid: string };
    }
  | {
      layer: 'sandbox';
      event: 'archive_stored';
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        fileCount: number;
        durationMs: number;
      };
    }
  | {
      layer: 'sandbox';
      event: 'document_written';
      flowId: string;
      timestamp: number;
      payload: {
        cid: string;
        totalMs: number;
        /** Decoded size across both the cache-hit and fetch paths. */
        bytes?: number;
        fileCount?: number;
      };
    }
  | {
      layer: 'sandbox';
      event: 'failed';
      flowId: string;
      timestamp: number;
      payload: {
        cid: string | null;
        reason: string;
      };
    };

export type MainEvent =
  | {
      layer: 'main';
      event: 'stall_detected';
      flowId: string;
      timestamp: number;
      payload: {
        /** Above about 200ms the main thread was blocked. */
        durationMs: number;
      };
    }
  | {
      layer: 'main';
      event: 'heartbeat';
      flowId: string;
      timestamp: number;
      payload: {
        uptimeSec: number;
      };
    }
  | {
      layer: 'main';
      event: 'monitor_stopped';
      flowId: string;
      timestamp: number;
      payload: {
        reason: 'bridge_ready' | 'max_duration';
      };
    };

export type BootEvent =
  | {
      layer: 'boot';
      event: 'started';
      flowId: string;
      timestamp: number;
      payload: {
        chainBackend: string;
        skipCidCache: boolean;
        skipArchiveCache: boolean;
      };
    }
  | {
      layer: 'boot';
      event: 'protocol_warmup_started';
      flowId: string;
      timestamp: number;
      payload: { subMode: 'shared-worker' | 'direct' | 'rpc' };
    }
  | {
      layer: 'boot';
      event: 'topbar_ready';
      flowId: string;
      timestamp: number;
      payload: Record<string, never>;
    }
  | {
      layer: 'boot';
      event: 'url_parsed';
      flowId: string;
      timestamp: number;
      payload: {
        label: string | null;
        localhostHost: string | null;
        deepPath: string;
      };
    }
  | {
      layer: 'boot';
      event: 'installed_executable_cache_checked';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        hit: boolean;
        contenthash?: string;
      };
    }
  | {
      layer: 'boot';
      event: 'block_cache';
      flowId: string;
      timestamp: number;
      payload: {
        /** Blocks the relay answered from the host's block cache. */
        hits: number;
        misses: number;
      };
    }
  | {
      layer: 'boot';
      event: 'landing_page_shown';
      flowId: string;
      timestamp: number;
      payload: Record<string, never>;
    }
  | {
      layer: 'boot';
      event: 'ready';
      flowId: string;
      timestamp: number;
      payload: {
        label: string | null;
        totalMs: number;
        path: 'fast' | 'slow' | 'localhost';
      };
    }
  | {
      layer: 'boot';
      event: 'failed';
      flowId: string;
      timestamp: number;
      payload: {
        label: string | null;
        reason: string;
        dependency: string;
      };
    };

export type ResolveEvent =
  | {
      layer: 'resolve';
      event: 'started';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        source: 'smoldot' | 'rpc-gateway';
      };
    }
  | {
      layer: 'resolve';
      event: 'phase';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        phase: string;
        message: string;
      };
    }
  | {
      layer: 'resolve';
      event: 'storage_read';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        bytes: number;
        durationMs: number;
      };
    }
  | {
      layer: 'resolve';
      event: 'completed';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        source: 'smoldot' | 'rpc-gateway';
        cid: string | null;
        durationMs: number;
      };
    }
  | {
      layer: 'resolve';
      event: 'failed';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        source: 'smoldot' | 'rpc-gateway';
        reason: string;
      };
    };

export type RenderEvent =
  | {
      layer: 'render';
      event: 'iframe_begin';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        url: string;
        mode: 'iframe' | 'subdomain' | 'localhost';
      };
    }
  | {
      layer: 'render';
      event: 'iframe_ready';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        mode: 'iframe' | 'subdomain' | 'localhost';
      };
    };

export type BridgeEvent =
  | {
      layer: 'bridge';
      event: 'setup_begin';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        productId: string;
      };
    }
  | {
      layer: 'bridge';
      event: 'setup_ready';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        productId: string;
      };
    }
  | {
      layer: 'bridge';
      event: 'iframe_load';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        productId: string;
        mode: 'iframe' | 'subdomain';
      };
    }
  | {
      layer: 'bridge';
      event: 'first_inbound';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        productId: string;
      };
    }
  | {
      layer: 'bridge';
      event: 'first_outbound';
      flowId: string;
      timestamp: number;
      payload: {
        label: string;
        productId: string;
      };
    };

/** A chain backend switch after a resolution error. */
export interface FailoverEvent {
  layer: 'failover';
  event: 'chain_backend';
  flowId: string;
  timestamp: number;
  payload: {
    from: string;
    to: string;
    reason: string;
  };
}

/**
 * Emitted only by smoldot, so a gateway load has none.
 * `phase` is the loading screen's derived milestone, emitted on change, not smoldot's raw state.
 * `bytes` carries the cumulative received total, sampled on a tick.
 */
export type ChainEvent =
  | {
      layer: 'chain';
      event: 'phase';
      flowId: string;
      timestamp: number;
      payload: {
        chain: string;
        phase: string;
        peers?: number;
        warpAt?: number;
        warpTarget?: number;
        reason?: string;
      };
    }
  | {
      layer: 'chain';
      event: 'dbcache';
      flowId: string;
      timestamp: number;
      payload: {
        chain: string;
        dbCache: 'hit' | 'miss';
      };
    }
  | {
      layer: 'chain';
      event: 'peers';
      flowId: string;
      timestamp: number;
      payload: {
        chain: string;
        peers: number;
      };
    }
  | {
      layer: 'chain';
      event: 'bytes';
      flowId: string;
      timestamp: number;
      payload: {
        received: number;
      };
    };
