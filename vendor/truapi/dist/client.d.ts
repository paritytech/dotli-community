import { type Subscription, type TrUApiTransport, type WireProvider } from "./transport.js";
export type { Subscription, TrUApiTransport };
/** A request received no matching response before its transport deadline. */
export declare class RequestTimeoutError extends Error {
    /** Transport-assigned request identifier. */
    readonly requestId: string;
    /** Wire discriminant of the unanswered request. */
    readonly discriminant: number;
    /** Configured request deadline in milliseconds. */
    readonly timeoutMs: number;
    constructor(requestId: string, discriminant: number, timeoutMs: number);
}
/**
 * Version overrides used when constructing a transport.
 */
export interface CreateTransportOptions {
    /**
     * SCALE codec version advertised during host handshake negotiation.
     *
     * @deprecated TODO(shared-core-wire): remove this override with
     * `TrUApiTransport.codecVersion` once generated handshake requests use
     * `TRUAPI_CODEC_VERSION` directly.
     */
    codecVersion?: number;
    /**
     * Maximum time to wait for a matching response before rejecting the request.
     *
     * Defaults to 120 seconds. This bounds dead hosts and missed transport
     * handshakes while leaving interactive approval flows enough time to finish.
     */
    requestTimeoutMs?: number;
}
/**
 * Build a `TrUApiTransport` on top of a `WireProvider`, adding request/response
 * correlation and subscription start/receive/stop lifecycle handling.
 */
export declare function createTransport(provider: WireProvider, options?: CreateTransportOptions): TrUApiTransport;
