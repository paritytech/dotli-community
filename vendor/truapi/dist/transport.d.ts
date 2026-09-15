import { type Result, type ResultAsync } from "neverthrow";
import { type CallErrorValue, type ResultPayload } from "./scale.js";
/** Wire discriminant reserved for method-independent protocol errors. **/
export declare const PROTOCOL_ERROR_ID: 255;
/** The peer rejected an outbound frame because it does not support its API. **/
export declare class UnsupportedMessageError extends Error {
    /** Wire discriminant of the unsupported outbound frame. **/
    readonly discriminant: number;
    constructor(discriminant: number);
}
/** Call result returned when the peer does not recognize a request frame. **/
export type UnsupportedCallError = Extract<CallErrorValue<never>, {
    tag: "Unsupported";
}>;
/**
 * Handle returned by TrUAPI subscription APIs.
 **/
export interface Subscription {
    /**
     * Stop the subscription. Calling this more than once has no additional effect.
     **/
    unsubscribe: () => void;
    /**
     * Transport-assigned request id for the subscription start frame.
     *
     * Methods that accept a `followSubscriptionId` use this value to scope
     * follow-up requests to a specific active subscription.
     **/
    subscriptionId: string;
}
/**
 * Terminal error delivered through `Observer.error` for every non-normal
 * subscription end. When the peer interrupted the stream with a typed payload,
 * `reason` carries the decoded `Reason`; otherwise `reason` is `undefined` and
 * the underlying transport/decode error is preserved on `cause`.
 *
 * Discriminate with `error.reason !== undefined` (or `'reason' in error`).
 **/
export declare class SubscriptionError<Reason = never> extends Error {
    /**
     * Typed payload supplied by the peer when it interrupted the subscription.
     * `undefined` when the stream ended for any other reason (transport close,
     * decode failure, malformed interrupt payload).
     **/
    readonly reason?: Reason;
    constructor(message: string, options?: {
        reason?: Reason;
        cause?: unknown;
    });
}
/**
 * Minimal Observable-compatible observer shape used by generated subscription
 * APIs without depending on RxJS.
 *
 * `Reason` is the typed interrupt payload for the originating subscription.
 * Methods without a typed interrupt resolve `Reason` to `never`, leaving
 * `error.reason` typed as `undefined`.
 **/
export interface Observer<Item, Reason = never> {
    /**
     * Called with each successfully decoded subscription item.
     **/
    next(value: Item): void;
    /**
     * Called once when the stream terminates with an error. Inspect
     * `error.reason` to distinguish a typed peer interrupt from a transport or
     * decode failure (`error.cause` carries the underlying failure in the
     * latter case).
     **/
    error(error: SubscriptionError<Reason>): void;
    /**
     * Called once when the peer normally completes the stream.
     **/
    complete(): void;
}
declare global {
    interface SymbolConstructor {
        readonly observable: unique symbol;
    }
}
/**
 * Minimal Observable-compatible object returned by generated subscription APIs.
 *
 * Implements the ES Observable interop protocol so that consumers can pass
 * an instance straight to `rxjs.from(...)`.
 **/
export interface ObservableLike<Item, Reason = never> {
    /**
     * Start the stream and receive `next`, `error`, and `complete` callbacks.
     **/
    subscribe(observer?: Partial<Observer<Item, Reason>>): Subscription;
    /**
     * Observable interop hook. Returns `this`.
     **/
    [Symbol.observable](): ObservableLike<Item, Reason>;
}
/**
 * Observable source accepted by generated channel methods as the
 * product-to-host request stream. Structurally satisfied by RxJS subjects and
 * observables as well as generated `ObservableLike` values.
 **/
export interface ObservableSource<Item> {
    /**
     * Start consuming the source until the returned handle unsubscribes.
     **/
    subscribe(observer: Partial<Observer<Item>>): {
        unsubscribe(): void;
    };
}
/**
 * Numeric frame ids for a one-shot request method.
 **/
export interface RequestFrameIds {
    /**
     * Wire discriminant for the outbound request frame.
     **/
    request: number;
    /**
     * Wire discriminant for the inbound response frame.
     **/
    response: number;
}
/**
 * Numeric frame ids for a subscription method.
 **/
export interface SubscriptionFrameIds {
    /**
     * Wire discriminant for the outbound start frame.
     **/
    start: number;
    /**
     * Wire discriminant for the outbound stop frame.
     **/
    stop: number;
    /**
     * Wire discriminant for the inbound interrupt frame.
     **/
    interrupt: number;
    /**
     * Wire discriminant for the inbound receive frame.
     **/
    receive: number;
}
/**
 * Options accepted by `TrUApiTransport.request`.
 **/
export interface RequestParams<Ok, Err> {
    /**
     * Wire discriminants for this request method.
     **/
    ids: RequestFrameIds;
    /**
     * SCALE-encoded request payload bytes.
     **/
    payload: Uint8Array;
    /**
     * Decode SCALE response payload bytes into the wire `ResultPayload`
     * envelope. The transport unwraps the envelope into
     * `ResultAsync<Ok, Err | UnsupportedCallError>`.
     **/
    decodeResponse: (payload: Uint8Array) => ResultPayload<Ok, Err>;
}
/**
 * Options accepted by `TrUApiTransport.subscribeRaw`.
 **/
export interface SubscribeRawParams {
    /**
     * Wire discriminants for this subscription method.
     **/
    ids: SubscriptionFrameIds;
    /**
     * SCALE-encoded subscription start payload bytes.
     **/
    payload: Uint8Array;
    /**
     * Called with raw SCALE receive payload bytes.
     **/
    onReceive: (payload: Uint8Array) => void;
    /**
     * Called with raw SCALE interrupt payload bytes when the peer interrupts the subscription.
     **/
    onInterrupt?: (payload: Uint8Array) => void;
    /**
     * Called when a transport-level error or unsupported start frame terminates
     * the subscription.
     **/
    onClose?: (error: Error) => void;
}
/**
 * Handler for a subscription initiated by the native host.
 **/
export type HostInitiatedSubscriptionHandler<Request, Item> = (request: Request) => ObservableSource<Item>;
/** Product-side registration for one host-initiated subscription method. **/
export interface HostInitiatedSubscriptionRegistration<Request, Item> {
    /** Install or replace the handler used for future start frames. **/
    setHandler(handler: HostInitiatedSubscriptionHandler<Request, Item>): {
        unsubscribe(): void;
    };
}
/** Options used to register a host-initiated subscription method. **/
export interface RegisterHostInitiatedSubscriptionParams<Request, Item> {
    /** Wire discriminants for the host-initiated subscription. **/
    ids: SubscriptionFrameIds;
    /** Decode the host's start payload. **/
    decodeRequest(payload: Uint8Array): Request;
    /** Encode one product renderer emission. **/
    encodeItem(item: Item): Uint8Array;
    /** Exact payload used when the product declines a render instance. **/
    interruptPayload: Uint8Array;
    /** Number of starts retained before a handler is installed. **/
    bufferCapacity: number;
}
/**
 * Byte-level transport used by generated client stubs.
 **/
export interface TrUApiTransport {
    /**
     * SCALE codec version used by generated handshake calls.
     *
     * @deprecated TODO(shared-core-wire): remove this public transport field once
     * generated handshake requests read `TRUAPI_CODEC_VERSION` directly instead
     * of going through transport state.
     **/
    readonly codecVersion: number;
    /**
     * Send a one-shot request and resolve with the typed Ok/Err outcome.
     **/
    request<Ok, Err>(params: RequestParams<Ok, Err>): ResultAsync<Ok, Err | UnsupportedCallError>;
    /**
     * Start a subscription and return a handle that can stop it.
     **/
    subscribeRaw(params: SubscribeRawParams): Subscription;
    /** Register product-side handling for a host-initiated subscription. **/
    registerHostInitiatedSubscription<Request, Item>(params: RegisterHostInitiatedSubscriptionParams<Request, Item>): HostInitiatedSubscriptionRegistration<Request, Item>;
    /**
     * Tear down the transport and release the listeners it registered on the
     * underlying `WireProvider`. Pending requests reject and live subscriptions
     * receive `onClose`. Idempotent.
     *
     * The provider itself is left alone; the caller decides whether to also
     * call `provider.dispose()` (long-lived hosts that swap providers will
     * typically dispose the transport but keep the provider).
     **/
    dispose(): void;
}
/**
 * Tagged payload inside a TrUAPI wire frame.
 **/
export interface Payload {
    /**
     * Wire-table numeric discriminant.
     **/
    id: number;
    /**
     * SCALE-encoded payload body.
     **/
    value: Uint8Array;
}
/**
 * Top-level TrUAPI wire message.
 **/
export interface ProtocolMessage {
    /**
     * Request id used to correlate request/response and subscription frames.
     **/
    requestId: string;
    /**
     * Tagged SCALE payload carried by this frame.
     **/
    payload: Payload;
}
/**
 * Raw SCALE-wire-frame pipe abstraction used by the transport. A `WireProvider`
 * is the low-level channel (a `MessagePort` or iframe `postMessage` link) that
 * carries encoded frames between the product and the host.
 **/
export interface WireProvider {
    /**
     * Send a complete SCALE-encoded wire frame to the peer.
     **/
    postMessage(message: Uint8Array): void;
    /**
     * Register a callback for inbound SCALE-encoded wire frames.
     **/
    subscribe(callback: (message: Uint8Array) => void): () => void;
    /**
     * Register a callback for provider-level close or failure events.
     *
     * Providers keep a terminal close reason. The callback fires at most once
     * for an active subscription, and fires immediately when registered after
     * the provider has already closed.
     **/
    subscribeClose?(callback: (error: Error) => void): () => void;
    /**
     * Release provider resources and close the underlying pipe.
     **/
    dispose(): void;
}
/**
 * A {@link WireProvider} backed by a WebSocket, which reports when its socket
 * is up. Awaiting {@link WebSocketWireProvider.opened} is optional: frames
 * posted earlier are queued and flushed on open.
 **/
export interface WebSocketWireProvider extends WireProvider {
    /** Resolves once the socket is open, rejects if it never connects. */
    opened: Promise<void>;
}
/**
 * Encode a `ProtocolMessage` into a SCALE wire frame.
 **/
export declare function encodeWireMessage(message: ProtocolMessage): Result<Uint8Array, Error>;
/**
 * Decode a SCALE wire frame into a `ProtocolMessage`.
 **/
export declare function decodeWireMessage(message: Uint8Array): Result<ProtocolMessage, Error>;
/**
 * Create a provider for the child side of an iframe `postMessage` channel.
 *
 * `target` is the `Window` the provider posts to (typically `window.parent`);
 * `hostOrigin` is the pinned `targetOrigin` for outbound frames and the
 * required `event.origin` of inbound frames. The provider only delivers
 * frames whose `event.source === target` and `event.origin === hostOrigin`,
 * so it cannot be coerced by an unrelated frame parent.
 **/
export declare function createIframeProvider(options: {
    target: Window;
    hostOrigin: string;
}): WireProvider;
/**
 * Create a provider from a web or Electron `MessagePort`.
 **/
export declare function createMessagePortProvider(port: MessagePort | Promise<MessagePort>): WireProvider;
/**
 * Wire provider over a binary WebSocket, one message per SCALE frame.
 *
 * This is the transport a host exposes on a loopback socket: the Rust core's
 * `ws-bridge`, and `truapi-host signing-host --frame-listen`. The frame bytes
 * are identical to what the {@link createMessagePortProvider} path carries, so
 * this is a pipe and nothing more.
 *
 * Frames posted before the socket opens are queued and flushed on open, so a
 * caller never has to await {@link WebSocketWireProvider.opened} first.
 **/
export declare function createWebSocketProvider(url: string): WebSocketWireProvider;
