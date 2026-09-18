import { type Subscription, type TrUApiTransport, type WireProvider } from "./transport.js";
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
