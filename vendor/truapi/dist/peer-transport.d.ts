/** Caps mirrored from `truapi::v01::peer_transport`. */
export declare const PEER_TRANSPORT_MAX_CONNECTIONS = 8;
export declare const PEER_TRANSPORT_MAX_STREAMS_PER_CONNECTION = 16;
export declare const PEER_TRANSPORT_MAX_MESSAGE_BYTES: number;
export declare const PEER_TRANSPORT_MAX_BUFFERED_BYTES_PER_CONNECTION: number;
/** Largest request frame: a `send` of a maximal message plus SCALE and wire overhead. */
export declare const PEER_TRANSPORT_MAX_FRAME_BYTES: number;
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
/** A host-owned grant for one JAM genesis; the guest can neither create nor widen it. */
export interface PeerTransportGrant {
    /** `0x`-prefixed lower-case 32-byte genesis header hash. */
    genesis: string;
}
export interface PeerTransportOptions extends PeerTransportGrant {
    /** Host transport injection; defaults to the browser `WebTransport` constructor. */
    connect?: (url: string, certificateHashes: Uint8Array[]) => WebTransportLike;
    /** Unix seconds used to select certificate validity periods; defaults to the wall clock. */
    now?: () => number;
}
/** Execution-local peer endpoint. It provides no account or signing authority. */
export interface PeerTransportSession {
    /** Handle one request frame; CANCEL frames return zero bytes. */
    handleFrame(frame: Uint8Array): Promise<Uint8Array>;
    /** Revoke the grant and close every connection on stop or replacement. */
    close(): void;
}
/** Validate and normalize the manifest `capabilities.network.jam.genesis` value. */
export declare function validatePeerTransportGenesis(genesis: string): string;
/** Trait id of a request frame, or `undefined` when it does not decode. */
export declare function frameTraitId(frame: Uint8Array): number | undefined;
/** `https://` authority for a 16-byte IPv6 or v4-mapped address. */
export declare function peerUrl(ip: Uint8Array, port: number): string;
/**
 * Create the browser PeerTransport endpoint for one execution. The host must
 * have checked the manifest grant before calling this constructor and must
 * fence late replies against execution stop or replacement.
 */
export declare function createPeerTransportSession(options: PeerTransportOptions): PeerTransportSession;
