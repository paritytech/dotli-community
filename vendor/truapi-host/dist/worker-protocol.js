// Wire format between the main thread (`createWebWorkerPairingHostRuntime`) and the
// Web Worker that hosts the truapi WASM runtime.
//
//   Main window / host JS
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ createWebWorkerPairingHostRuntime                               │
//   │ host callbacks: storage, DOM prompts, chain provider, logging   │
//   └───────────────┬─────────────────────────────────────────────────┘
//                   │ MainToWorker: init, createCore, frame,
//                   │               callbackResponse, subscriptionItem,
//                   │               chainResponse
//                   v
//   Dedicated Worker
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ shared truapi WASM PairingHostRuntime + product runtimes        │
//   │ generated raw-callback proxy                                    │
//   └───────────────┬─────────────────────────────────────────────────┘
//                   │ WorkerToMain: coreReady, frame, callbackRequest,
//                   │               subscriptionStart, chainConnect
//                   v
//   Main window dispatches those requests to the actual host callbacks.
//
// Frames (`kind: 'frame'`) carry SCALE-encoded `ProtocolMessage` bytes
// untouched in either direction. Everything else is a control message
// for callback dispatch, subscription bookkeeping, or chain connections.
//
// Frame bytes cross the boundary by structured clone, deliberately not as
// transferables: the sender keeps using its buffer (the worker side posts
// views into WASM memory) and frames are small, so the copy is the simpler
// safe choice.
/** Shared cap includes connections still opening or closing during an open. */
export const MAX_JSON_RPC_CONNECTIONS = 64;
/** Wallet custody belongs to the runtime, never a product-specific callback bundle. */
export const COINAGE_WALLET_CALLBACKS = {
    nativeCoinage: true,
};
/**
 * Is `url` a `ws://` URL on a loopback host? The tap forwards every frame
 * verbatim, key material included, and redacts nothing, so loopback is the whole
 * confinement story.
 *
 * `ws://` only, matching the native sink. A loopback socket has no path for TLS
 * to defend, so `wss://` would buy nothing and cost a certificate `localhost`
 * cannot get from a real CA.
 *
 * `WsDebugSink::connect` resolves the host and checks every address; this matches
 * the normalized hostname. A Worker has no resolver and needs none, since this
 * same string is handed to `new WebSocket`, so the native "validate one string,
 * dial another" gap cannot open here.
 *
 * Accepts what the native sink accepts: `localhost`, 127.0.0.0/8 and `::1`. An
 * IPv4-mapped literal is refused in both, since `Ipv6Addr::is_loopback` matches
 * only `::1`.
 */
export function isLoopbackWsUrl(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== "ws:")
            return false;
        const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        return (host === "localhost" ||
            host === "::1" ||
            /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host));
    }
    catch {
        return false;
    }
}
