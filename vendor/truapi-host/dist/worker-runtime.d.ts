/**
 * Is `url` a `ws://` URL on a loopback host? The debug tap forwards every frame
 * verbatim, including payloads carrying key material: there is no denylist and
 * nothing is redacted anywhere in this pipeline, so the loopback requirement is
 * the whole confinement story - refuse to stream them off the local machine.
 * `ws://` only, matching the native sink (`native_debug.rs`), also ws-only.
 *
 * Cleartext is the right call *because* the target is loopback-only. TLS defends
 * against a party on the path, and a loopback socket has no path: the frames
 * never reach an interface. `wss://` would instead require the debugger to
 * present a certificate — unobtainable for `localhost` from a real CA, and
 * self-signed on iOS costs the developer a CA install plus a manual enable under
 * Settings → General → About → Certificate Trust Settings before a single frame
 * arrives. So `wss://` buys no confidentiality here and costs setup, while adding
 * a second protocol path and a trust surface to the gate.
 *
 * Confidentiality for the trace stream comes from the loopback check, not from
 * the scheme: the frames never cross a network, so there is nothing on a network
 * to encrypt. That is the whole of it - a *remote* debugger would put plaintext
 * SCALE payloads on a network, and nothing in this codebase mitigates that, which
 * is why this gate refuses non-loopback targets outright rather than negotiating a
 * scheme for them.
 *
 * Unlike `WsDebugSink::connect`, which resolves the host and requires every
 * resolved address to be loopback, this matches the hostname the URL parser
 * normalized. There is no resolver in a Web Worker, and none is needed: the same
 * `url` string is passed to `new WebSocket(url)` below, so the browser resolves
 * exactly what was validated. The Rust "validate one string, dial another" gap
 * cannot open here because there is only ever one string.
 */
export declare function isLoopbackWsUrl(url: string): boolean;
/**
 * The wire-contract fingerprint of the core that *encodes* the frames, or
 * `undefined` when this build of the core does not report one.
 *
 * The debugger decodes each frame against a `frameId → method` table, so the
 * `schema` an envelope carries has to be the fingerprint of the table the bytes
 * were encoded with. That is the WASM core's, not `@parity/truapi`'s: the client
 * and the core are separate artifacts, and `dist/wasm/web/` is gitignored and
 * built by hand (`make wasm`), so a stale core beside a fresh client is the
 * everyday case rather than an exotic one. Stamping the client's hash there would
 * make the debugger *confirm* identity on frames from a different table and decode
 * them into the wrong methods and values, silently.
 *
 * When the core does not report a hash, the envelope carries none. The debugger
 * treats an unstamped frame as unconfirmed: it still groups the op, but refuses
 * to decode values. Losing decode until `make wasm` is rerun is the honest
 * outcome; a confident wrong decode is not.
 */
export declare function coreWireSchemaHash(module: {
    wireSchemaHash?: () => string;
}): string | undefined;
/**
 * The socket surface the debugger link uses. A `WebSocket` satisfies it; tests
 * substitute a fake to drive backpressure and reconnect timing without a network.
 */
export interface DebuggerSocket {
    /** Bytes handed to the socket that it has not yet put on the wire. */
    readonly bufferedAmount: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: "open" | "close" | "error", listener: () => void): void;
}
/** Construction options for {@link createDebuggerLink}. */
export interface DebuggerLinkOptions {
    /**
     * The encoding core's wire-schema hash, from {@link coreWireSchemaHash}. When
     * omitted, envelopes carry no `schema` and the debugger refuses value decode
     * rather than trusting a hash the core never vouched for.
     */
    schema?: string;
    /** Socket factory. Defaults to a real `WebSocket`; tests inject a fake. */
    createSocket?: (url: string) => DebuggerSocket;
    /** Deferred scheduler for reconnect backoff. Defaults to `setTimeout`. */
    schedule?: (run: () => void, delayMs: number) => void;
}
/**
 * Dev-only link to the debugger the host dials. Fire-and-forget by construction:
 * it opens lazily, buffers a bounded backlog until the socket is up, retries a
 * dropped connection with capped backoff, sheds frames (counted) rather than
 * buffering without bound at either layer, and swallows every error - a slow,
 * absent, or crashed debugger only loses the trace, it can never throw into the
 * frame path.
 */
export declare function createDebuggerLink(url: string, options?: DebuggerLinkOptions): {
    emit(channelId: string, dir: string, frame: Uint8Array): void;
};
