import { type Subscription, type TrUApiTransport, type WireProvider } from "./transport.js";
export type { Subscription, TrUApiTransport };
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
}
/**
 * Build a `TrUApiTransport` on top of a `WireProvider`, adding request/response
 * correlation and subscription start/receive/stop lifecycle handling.
 */
export declare function createTransport(provider: WireProvider, options?: CreateTransportOptions): TrUApiTransport;
