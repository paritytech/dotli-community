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
