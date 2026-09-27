/** Caps mirrored from `truapi::v01::peer_transport`. */
export declare const PEER_TRANSPORT_MAX_CONNECTIONS = 8;
export declare const PEER_TRANSPORT_MAX_STREAMS_PER_CONNECTION = 16;
export declare const PEER_TRANSPORT_MAX_MESSAGE_BYTES: number;
export declare const PEER_TRANSPORT_MAX_BUFFERED_BYTES_PER_CONNECTION: number;
/** Largest request frame: a `send` of a maximal message plus SCALE and wire overhead. */
export declare const PEER_TRANSPORT_MAX_FRAME_BYTES: number;
/**
 * Bound on one `dial`, from its arrival to its reply, the permission decision
 * included. A guest that waits at least this long for a dial reply never
 * misses one, and anything a dial would open after it is closed instead.
 */
export declare const PEER_TRANSPORT_DIAL_TIMEOUT_MS = 10000;
/** Minimal WebTransport surface the session needs; lets tests inject a fake. */
export interface WebTransportLike {
    readonly ready: Promise<unknown>;
    readonly closed: Promise<unknown>;
    readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStreamLike>;
    createBidirectionalStream(): Promise<WebTransportBidirectionalStreamLike>;
    close(): void;
}
export interface WebTransportBidirectionalStreamLike {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
}
export interface PeerTransportOptions {
    /**
     * Decide whether this execution may dial peers of `genesis`, a `0x`-prefixed
     * lower-case 32-byte genesis header hash: the host's check of the
     * `RemotePermission::JamPeers` runtime permission. The session asks at most
     * once per genesis and concurrent dials share the pending answer; `false` or
     * a rejection answers `NotGranted` for the rest of the session.
     */
    authorize(genesis: string): Promise<boolean>;
    /** Host transport injection; defaults to the browser `WebTransport` constructor. */
    connect?: (url: string, certificateHashes: Uint8Array[]) => WebTransportLike;
    /** Unix seconds used to select certificate validity periods; defaults to the wall clock. */
    now?: () => number;
    /** Dial deadline in milliseconds; defaults to {@link PEER_TRANSPORT_DIAL_TIMEOUT_MS}. */
    dialTimeoutMs?: number;
}
/** Execution-local peer endpoint. It provides no account or signing authority. */
export interface PeerTransportSession {
    /** Handle one request frame; CANCEL frames return zero bytes. */
    handleFrame(frame: Uint8Array): Promise<Uint8Array>;
    /** Close every connection on stop or replacement and refuse further requests. */
    close(): void;
}
/** Trait id of a request frame, or `undefined` when it does not decode. */
export declare function frameTraitId(frame: Uint8Array): number | undefined;
/** `https://` authority for a 16-byte IPv6 or v4-mapped address. */
export declare function peerUrl(ip: Uint8Array, port: number): string;
/**
 * Create the browser PeerTransport endpoint for one execution. Every `dial`
 * is authorized for its genesis through `options.authorize` before anything
 * connects; the other methods act only on connections an authorized dial
 * opened. A dial answers within its deadline, prompt included: one still
 * waiting then answers `Unreachable`, a CANCEL naming it answers `Cancelled`,
 * and in both cases whatever it opened is closed without holding a slot. The
 * permission decision is remembered either way, so a retry does not ask
 * again. The host must fence late replies against execution stop or
 * replacement.
 */
export declare function createPeerTransportSession(options: PeerTransportOptions): PeerTransportSession;
