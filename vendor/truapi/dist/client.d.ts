import { type MethodIds, type Subscription, type TrUApiTransport, type WireProvider } from "./transport.js";
export type { Subscription, TrUApiTransport };
/** A request received no matching response before its transport deadline. */
export declare class RequestTimeoutError extends Error {
    /** Transport-assigned request identifier. */
    readonly requestId: string;
    /** Trait discriminant of the unanswered request. */
    readonly traitId: number;
    /** Method discriminant of the unanswered request. */
    readonly methodId: number;
    /** Deadline that elapsed, in milliseconds. */
    readonly timeoutMs: number;
    constructor(requestId: string, traitId: number, methodId: number, timeoutMs: number);
}
/**
 * Options accepted when constructing a transport.
 */
export interface CreateTransportOptions {
    /** Request ID namespace when multiple transports share a connection. Defaults to `p:`. */
    requestIdPrefix?: string;
    /** Wait for connection readiness before sending a request or starting a subscription. */
    prepare?: (ids: MethodIds) => Promise<void>;
    /** Replace a failed connection after a malformed frame; otherwise the transport closes permanently. */
    onProtocolError?: (error: Error) => void;
    /**
     * Maximum time to wait for a matching response before rejecting the request.
     *
     * Defaults to 120 seconds. This bounds dead hosts and missed transport
     * handshakes while leaving interactive approval flows enough time to finish.
     * The handshake keeps its own shorter deadline, since a codec mismatch means
     * no answer is ever coming.
     */
    requestTimeoutMs?: number;
}
/**
 * Build a `TrUApiTransport` on top of a `WireProvider`, adding request/response
 * correlation and subscription start/receive/stop lifecycle handling.
 */
export declare function createTransport(provider: WireProvider, options?: CreateTransportOptions): TrUApiTransport;
