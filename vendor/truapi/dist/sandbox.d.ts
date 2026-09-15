/**
 * Sandbox bootstrap for browser-embedded hosts.
 *
 * Detects whether the app runs inside a TrUAPI host (iframe or webview), builds
 * the matching {@link WireProvider}, and exposes a lazily-created, cached
 * {@link TrUApiClient} via {@link getClientSync} so embedders don't
 * re-implement the wiring. {@link subscribeConnectionStatus} surfaces a
 * connected / disconnected signal over that client.
 *
 * @module
 */
import { type TrUApiClient } from "./generated/index.js";
/**
 * Connection lifecycle state. {@link subscribeConnectionStatus} emits
 * `"connecting"` while the client waits for the host channel, `"connected"`
 * once the channel is established, and `"disconnected"` outside a host or
 * after the channel closes.
 */
export type ConnectionStatus = "disconnected" | "connecting" | "connected";
declare global {
    interface Window {
        /** Set by webview hosts (Polkadot Desktop / Mobile) to mark the embedding. */
        __HOST_WEBVIEW_MARK__?: boolean;
        /** Injected by webview hosts to carry the host-side `MessagePort`. */
        __HOST_API_PORT__?: MessagePort;
    }
}
/**
 * Detect whether the app is running inside a TrUAPI host container: an iframe
 * (including a cross-origin parent), a marked webview, or a window carrying an
 * injected host message port. Synchronous, so it can gate hot paths.
 */
export declare function isCorrectEnvironment(): boolean;
/**
 * Build (or return the cached) {@link TrUApiClient}. Returns `null` outside a
 * host container or if the provider can't be built. A close drops the cache,
 * so the next call renegotiates.
 */
export declare function getClientSync(): TrUApiClient | null;
/**
 * Connect to a host that serves protocol frames over a WebSocket, and return
 * the client for it. From then on this module treats that endpoint as the host:
 * {@link isCorrectEnvironment} reports `true` and {@link getClientSync} returns
 * the same cached client, so product code that already runs inside a webview or
 * an iframe needs no changes.
 *
 * The endpoint is whatever a host exposes on loopback. For local development
 * that is `truapi-host signing-host --frame-listen 127.0.0.1:9955`:
 *
 * ```ts
 * connectWebSocketHost("ws://127.0.0.1:9955");
 * ```
 *
 * Call it before anything else touches the client. It throws while a live
 * client for a different transport exists, because that client is cached and
 * cannot be redirected. Once the pipe closes there is no client to redirect, so
 * a different endpoint is accepted.
 */
export declare function connectWebSocketHost(url: string): TrUApiClient | null;
/**
 * Subscribe to connection-status changes. The callback fires immediately with
 * the current status and on every transition. Status is `"connecting"` while
 * the client waits for the host channel, `"connected"` once the channel is
 * established (`truapi-init` MessagePort handover, first legacy frame, or
 * webview port), and `"disconnected"` outside a host container or when the
 * provider reports the pipe closed. Returns an unsubscribe function.
 */
export declare function subscribeConnectionStatus(callback: (status: ConnectionStatus) => void): () => void;
