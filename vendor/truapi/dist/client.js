import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { decodeWireMessage, encodeWireMessage, PROTOCOL_ERROR_ID, UnsupportedMessageError, } from "./transport.js";
import { CallError, indexedTaggedUnion, Result, _void, } from "./scale.js";
import { TRUAPI_CODEC_VERSION } from "./generated/client.js";
import * as T from "./generated/types.js";
import * as W from "./generated/wire-table.js";
const UNANSWERED_WIRE_IDS = new Set(Object.values(W).flatMap((ids) => "response" in ids ? [ids.response] : [ids.stop, ids.interrupt, ids.receive]));
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** A request received no matching response before its transport deadline. */
export class RequestTimeoutError extends Error {
    /** Transport-assigned request identifier. */
    requestId;
    /** Wire discriminant of the unanswered request. */
    discriminant;
    /** Configured request deadline in milliseconds. */
    timeoutMs;
    constructor(requestId, discriminant, timeoutMs) {
        super(`TrUAPI request ${requestId} (wire ${discriminant}) timed out after ${timeoutMs}ms`);
        this.name = "RequestTimeoutError";
        this.requestId = requestId;
        this.discriminant = discriminant;
        this.timeoutMs = timeoutMs;
    }
}
/**
 * Convert a positive protocol version number into the generated version tag
 * used by TrUAPI wire wrappers.
 */
function protocolVersionTag(version) {
    if (!Number.isInteger(version) || version < 1) {
        throw new Error(`Invalid TrUAPI protocol version: ${version}`);
    }
    return `V${version}`;
}
const HANDSHAKE_WIRE_VERSION = 1;
/**
 * Build the versioned handshake response codec for the selected wire version.
 */
function handshakeResponseCodec(version) {
    return indexedTaggedUnion({
        [protocolVersionTag(version)]: [
            version - 1,
            Result(_void, CallError(T.VersionedHostHandshakeError)),
        ],
    });
}
/**
 * Encode a successful host-handshake response payload.
 */
function encodeSuccessfulHandshakeResponse(version) {
    return encodeHandshakeResponse(version, {
        tag: protocolVersionTag(version),
        value: {
            success: true,
            value: undefined,
        },
    });
}
/**
 * Encode a host-handshake response that reports an unsupported codec version.
 */
function encodeUnsupportedHandshakeResponse(version) {
    return encodeHandshakeResponse(version, {
        tag: protocolVersionTag(version),
        value: {
            success: false,
            value: {
                tag: "Domain",
                value: {
                    tag: "V1",
                    value: {
                        tag: "UnsupportedProtocolVersion",
                        value: undefined,
                    },
                },
            },
        },
    });
}
/**
 * Encode a typed handshake response with the versioned response codec.
 */
function encodeHandshakeResponse(version, response) {
    return handshakeResponseCodec(version).enc(response);
}
/**
 * Check whether a decoded SCALE value has the generated `{ tag, value }`
 * wrapper shape used for versioned wire payloads.
 */
function isVersionedWireValue(value) {
    return (typeof value === "object" &&
        value !== null &&
        "tag" in value &&
        "value" in value &&
        typeof value.tag === "string" &&
        /^V\d+$/.test(value.tag));
}
/**
 * Return the inner payload from a versioned wire wrapper, or the original
 * value when the payload is already unwrapped.
 */
function unwrapVersionedWireValue(value) {
    return isVersionedWireValue(value) ? value.value : value;
}
function decodeUnsupportedMessage(payload) {
    if (payload.length !== 3) {
        throw new Error(`Malformed protocol error payload: expected 3 bytes, received ${payload.length}`);
    }
    if (payload[0] !== 0) {
        throw new Error(`Malformed protocol error payload: unsupported version ${payload[0]}`);
    }
    if (payload[1] !== 0) {
        throw new Error(`Malformed protocol error payload: unknown error discriminant ${payload[1]}`);
    }
    return payload[2];
}
/**
 * Build a `TrUApiTransport` on top of a `WireProvider`, adding request/response
 * correlation and subscription start/receive/stop lifecycle handling.
 */
export function createTransport(provider, options = {}) {
    const codecVersion = options.codecVersion ?? TRUAPI_CODEC_VERSION;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
        throw new RangeError("requestTimeoutMs must be a positive finite number");
    }
    let idCounter = 0;
    let closedError = null;
    const pending = new Map();
    const subscriptions = new Map();
    const hostRoutes = new Map();
    /**
     * Normalize arbitrary thrown values into `Error` instances.
     */
    function toError(error) {
        return error instanceof Error ? error : new Error(String(error));
    }
    /** Remove a pending request and cancel its deadline. */
    function takePending(requestId) {
        const entry = pending.get(requestId);
        if (!entry)
            return undefined;
        pending.delete(requestId);
        entry.cancelTimeout();
        return entry;
    }
    /**
     * Close the transport once, rejecting pending requests and notifying live
     * subscriptions.
     */
    function closeWithError(error) {
        const nextError = toError(error);
        if (closedError) {
            return;
        }
        closedError = nextError;
        for (const requestId of pending.keys()) {
            takePending(requestId)?.reject(nextError);
        }
        for (const [requestId, subscription] of subscriptions) {
            subscriptions.delete(requestId);
            subscription.onClose?.(nextError);
        }
        for (const route of hostRoutes.values()) {
            route.buffered.length = 0;
            for (const instance of route.instances.values())
                instance.unsubscribe();
            route.instances.clear();
        }
    }
    const unsubscribeClose = provider.subscribeClose?.((error) => {
        closeWithError(error);
    });
    const unsubscribeMessage = provider.subscribe((message) => {
        if (closedError) {
            return;
        }
        const decoded = decodeWireMessage(message);
        if (decoded.isErr()) {
            closeWithError(decoded.error);
            return;
        }
        const { requestId, payload } = decoded.value;
        if (payload.id === PROTOCOL_ERROR_ID) {
            let discriminant;
            try {
                discriminant = decodeUnsupportedMessage(payload.value);
            }
            catch (error) {
                closeWithError(error);
                return;
            }
            const request = pending.get(requestId);
            if (request?.ids.request === discriminant) {
                takePending(requestId)?.resolveUnsupported();
                return;
            }
            const subscription = subscriptions.get(requestId);
            if (subscription?.ids.start === discriminant) {
                subscriptions.delete(requestId);
                subscription.onClose?.(new UnsupportedMessageError(discriminant));
            }
            return;
        }
        if (payload.id === W.SYSTEM_HANDSHAKE.request) {
            // Auto-respond to inbound `host_handshake_request` frames.
            //
            // Legacy hosts shipping `@novasamatech/host-api@0.6.x` (e.g. dotli)
            // initiate their own handshake from the host side at startup and ping
            // the iframe with `host_handshake_request` every 50ms until they see a
            // matching response. The legacy host-api `createTransport` registered
            // an internal handler for this message; preserving that behaviour
            // keeps `@parity/truapi` a drop-in replacement for legacy bridges.
            //
            // Respond with the handshake method's selected wire version. The inner
            // request carries the wire codec version.
            let response;
            try {
                const request = unwrapVersionedWireValue(T.VersionedHostHandshakeRequest.dec(payload.value));
                const requestedCodecVersion = request.codecVersion;
                response =
                    requestedCodecVersion === codecVersion
                        ? encodeSuccessfulHandshakeResponse(HANDSHAKE_WIRE_VERSION)
                        : encodeUnsupportedHandshakeResponse(HANDSHAKE_WIRE_VERSION);
            }
            catch (error) {
                closeWithError(toError(error));
                return;
            }
            try {
                send({
                    requestId,
                    payload: {
                        id: W.SYSTEM_HANDSHAKE.response,
                        value: response,
                    },
                });
            }
            catch {
                // provider already closed
            }
            return;
        }
        const hostRoute = hostRoutes.get(payload.id);
        if (hostRoute) {
            startHostSubscription(hostRoute, requestId, payload.value);
            return;
        }
        for (const candidate of hostRoutes.values()) {
            if (payload.id !== candidate.ids.stop)
                continue;
            const bufferedIndex = candidate.buffered.findIndex((start) => start.requestId === requestId);
            if (bufferedIndex >= 0)
                candidate.buffered.splice(bufferedIndex, 1);
            const instance = candidate.instances.get(requestId);
            if (instance) {
                candidate.instances.delete(requestId);
                instance.unsubscribe();
            }
            return;
        }
        const p = pending.get(requestId);
        if (p && payload.id === p.ids.response) {
            takePending(requestId);
            try {
                p.resolve(payload.value);
            }
            catch (error) {
                p.reject(toError(error));
            }
            return;
        }
        const subscription = subscriptions.get(requestId);
        if (subscription) {
            if (payload.id === subscription.ids.receive) {
                try {
                    subscription.onReceive(payload.value);
                }
                catch (error) {
                    // A consumer-side decode/handler error must not tear down the
                    // provider's message loop and silently break every other
                    // subscription on the same transport. Surface via onClose and
                    // drop this subscription; siblings stay alive.
                    subscriptions.delete(requestId);
                    subscription.onClose?.(toError(error));
                }
                return;
            }
            else if (payload.id === subscription.ids.interrupt) {
                subscriptions.delete(requestId);
                subscription.onInterrupt?.(payload.value);
                return;
            }
        }
        if (UNANSWERED_WIRE_IDS.has(payload.id)) {
            return;
        }
        try {
            send({
                requestId,
                payload: {
                    id: PROTOCOL_ERROR_ID,
                    value: new Uint8Array([0, 0, payload.id]),
                },
            });
        }
        catch {
            // provider already closed
        }
    });
    /**
     * Encode and post a protocol message through the underlying provider.
     */
    function send(message) {
        if (closedError) {
            throw closedError;
        }
        const encoded = encodeWireMessage(message);
        if (encoded.isErr()) {
            closeWithError(encoded.error);
            throw encoded.error;
        }
        try {
            provider.postMessage(encoded.value);
        }
        catch (error) {
            closeWithError(error);
            throw toError(error);
        }
    }
    function interruptHostSubscription(route, requestId) {
        const instance = route.instances.get(requestId);
        if (instance) {
            route.instances.delete(requestId);
            instance.unsubscribe();
        }
        try {
            send({
                requestId,
                payload: {
                    id: route.ids.interrupt,
                    value: route.interruptPayload,
                },
            });
        }
        catch {
            // provider already closed
        }
    }
    function startHostSubscription(route, requestId, payload) {
        const previous = route.instances.get(requestId);
        if (previous) {
            route.instances.delete(requestId);
            previous.unsubscribe();
        }
        const handler = route.handler;
        if (!handler) {
            if (route.buffered.length === route.bufferCapacity) {
                const evicted = route.buffered.shift();
                if (evicted)
                    interruptHostSubscription(route, evicted.requestId);
            }
            route.buffered.push({ requestId, payload });
            return;
        }
        let source;
        try {
            source = handler(route.decodeRequest(payload));
        }
        catch {
            interruptHostSubscription(route, requestId);
            return;
        }
        let active = true;
        let sourceSubscription;
        const instance = {
            unsubscribe() {
                if (!active)
                    return;
                active = false;
                sourceSubscription?.unsubscribe();
            },
        };
        route.instances.set(requestId, instance);
        try {
            sourceSubscription = source.subscribe({
                next(item) {
                    if (!active)
                        return;
                    try {
                        send({
                            requestId,
                            payload: { id: route.ids.receive, value: route.encodeItem(item) },
                        });
                    }
                    catch {
                        interruptHostSubscription(route, requestId);
                    }
                },
                error() {
                    if (active)
                        interruptHostSubscription(route, requestId);
                },
                // Completion deliberately keeps the instance alive and its last tree
                // on screen until the host sends `_stop`.
                complete() { },
            });
            if (!active)
                sourceSubscription.unsubscribe();
        }
        catch {
            interruptHostSubscription(route, requestId);
        }
    }
    return {
        codecVersion,
        /**
         * Send one request frame and resolve with the typed Ok/Err outcome
         * decoded from the response payload's `ResultPayload` envelope.
         */
        request({ ids, payload, decodeResponse, }) {
            const promise = new Promise((resolve, reject) => {
                if (closedError) {
                    reject(closedError);
                    return;
                }
                const requestId = `p:${++idCounter}`;
                const timeout = setTimeout(() => {
                    takePending(requestId)?.reject(new RequestTimeoutError(requestId, ids.request, requestTimeoutMs));
                }, requestTimeoutMs);
                pending.set(requestId, {
                    ids,
                    resolve: (response) => resolve(decodeResponse(response)),
                    resolveUnsupported: () => resolve({
                        success: false,
                        value: { tag: "Unsupported" },
                    }),
                    reject,
                    cancelTimeout: () => clearTimeout(timeout),
                });
                try {
                    send({
                        requestId,
                        payload: {
                            id: ids.request,
                            value: payload,
                        },
                    });
                }
                catch (error) {
                    takePending(requestId);
                    reject(toError(error));
                }
            });
            return ResultAsync.fromSafePromise(promise).andThen((result) => result.success ? okAsync(result.value) : errAsync(result.value));
        },
        /**
         * Start a raw subscription and route incoming receive/interrupt frames to
         * the supplied callbacks.
         */
        subscribeRaw({ ids, payload, onReceive, onInterrupt, onClose, }) {
            if (closedError) {
                onClose?.(closedError);
                return { unsubscribe: () => { }, subscriptionId: "" };
            }
            const requestId = `p:${++idCounter}`;
            subscriptions.set(requestId, {
                ids,
                onReceive,
                onInterrupt,
                onClose,
            });
            try {
                send({
                    requestId,
                    payload: {
                        id: ids.start,
                        value: payload,
                    },
                });
            }
            catch (error) {
                subscriptions.delete(requestId);
                onClose?.(toError(error));
                return { unsubscribe: () => { }, subscriptionId: requestId };
            }
            return {
                subscriptionId: requestId,
                unsubscribe: () => {
                    // Skip the `_stop` frame when the host already terminated the stream
                    // via `_interrupt` (which removes the entry from `subscriptions`).
                    if (!subscriptions.has(requestId))
                        return;
                    subscriptions.delete(requestId);
                    try {
                        send({
                            requestId,
                            payload: {
                                id: ids.stop,
                                value: _void.enc(undefined),
                            },
                        });
                    }
                    catch {
                        // provider already closed
                    }
                },
            };
        },
        registerHostInitiatedSubscription({ ids, decodeRequest, encodeItem, interruptPayload, bufferCapacity, }) {
            if (hostRoutes.has(ids.start)) {
                throw new Error(`host-initiated subscription ${ids.start} is already registered`);
            }
            const route = {
                ids,
                decodeRequest: decodeRequest,
                encodeItem: encodeItem,
                interruptPayload,
                bufferCapacity,
                buffered: [],
                instances: new Map(),
            };
            hostRoutes.set(ids.start, route);
            return {
                setHandler(handler) {
                    const installed = handler;
                    route.handler = installed;
                    for (const start of route.buffered.splice(0)) {
                        startHostSubscription(route, start.requestId, start.payload);
                    }
                    return {
                        unsubscribe() {
                            if (route.handler === installed)
                                route.handler = undefined;
                        },
                    };
                },
            };
        },
        /**
         * Close this transport and detach its provider listeners.
         */
        dispose() {
            // Idempotent: closeWithError is a no-op once closedError is set, and
            // unsubscribe handles tolerate being called twice.
            closeWithError(new Error("transport disposed"));
            unsubscribeMessage();
            unsubscribeClose?.();
        },
    };
}
