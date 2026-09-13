import { concatBytes } from "@noble/hashes/utils.js";
import { err, ok } from "neverthrow";
import { str, u8 } from "./scale.js";
/** Wire discriminant reserved for method-independent protocol errors. **/
export const PROTOCOL_ERROR_ID = 255;
/** The peer rejected an outbound frame because it does not support its API. **/
export class UnsupportedMessageError extends Error {
    /** Wire discriminant of the unsupported outbound frame. **/
    discriminant;
    constructor(discriminant) {
        super(`Peer does not support wire message ${discriminant}`);
        this.name = "UnsupportedMessageError";
        this.discriminant = discriminant;
    }
}
/**
 * Coerce an unknown thrown value into an `Error` instance.
 */
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
/**
 * Terminal error delivered through `Observer.error` for every non-normal
 * subscription end. When the peer interrupted the stream with a typed payload,
 * `reason` carries the decoded `Reason`; otherwise `reason` is `undefined` and
 * the underlying transport/decode error is preserved on `cause`.
 *
 * Discriminate with `error.reason !== undefined` (or `'reason' in error`).
 **/
export class SubscriptionError extends Error {
    /**
     * Typed payload supplied by the peer when it interrupted the subscription.
     * `undefined` when the stream ended for any other reason (transport close,
     * decode failure, malformed interrupt payload).
     **/
    reason;
    constructor(message, options) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "SubscriptionError";
        if (options?.reason !== undefined)
            this.reason = options.reason;
    }
}
/**
 * Encode a `ProtocolMessage` into a SCALE wire frame.
 **/
export function encodeWireMessage(message) {
    const id = message.payload.id;
    if (!Number.isInteger(id) || id < 0 || id > 255) {
        return err(new Error(`Invalid wire discriminant: ${id}`));
    }
    return ok(concatBytes(str.enc(message.requestId), u8.enc(id), message.payload.value));
}
/**
 * Decode a SCALE wire frame into a `ProtocolMessage`.
 **/
export function decodeWireMessage(message) {
    if (message.length < 1) {
        return err(new Error("Wire frame too short: empty buffer"));
    }
    let cursor = message;
    const requestIdEndResult = scanStrEnd(cursor);
    if (requestIdEndResult.isErr()) {
        return err(requestIdEndResult.error);
    }
    const requestIdEnd = requestIdEndResult.value;
    const requestId = str.dec(cursor.subarray(0, requestIdEnd));
    cursor = cursor.subarray(requestIdEnd);
    if (cursor.length < 1) {
        return err(new Error("Wire frame too short: missing discriminant byte"));
    }
    const id = cursor[0];
    const value = cursor.subarray(1);
    // Hand the value bytes back as a fresh slice so callers may safely retain
    // it even if the source buffer is reused by the transport.
    const valueCopy = new Uint8Array(value.length);
    valueCopy.set(value);
    return ok({ requestId, payload: { id, value: valueCopy } });
}
/**
 * Return the byte offset just past the leading SCALE-encoded string.
 **/
function scanStrEnd(bytes) {
    if (bytes.length < 1) {
        return err(new Error("compact-len: empty buffer"));
    }
    const first = bytes[0];
    const mode = first & 0b11;
    let lengthLen;
    let strLen;
    if (mode === 0) {
        lengthLen = 1;
        strLen = first >> 2;
    }
    else if (mode === 1) {
        if (bytes.length < 2) {
            return err(new Error("compact-len: truncated mode-1 prefix"));
        }
        lengthLen = 2;
        strLen = ((first >> 2) | (bytes[1] << 6)) & 0x3fff;
    }
    else if (mode === 2) {
        if (bytes.length < 4) {
            return err(new Error("compact-len: truncated mode-2 prefix"));
        }
        lengthLen = 4;
        strLen =
            ((first >> 2) | (bytes[1] << 6) | (bytes[2] << 14) | (bytes[3] << 22)) >>>
                0;
    }
    else {
        // big-int mode: not used for requestId in our protocol
        return err(new Error("compact big-int mode not supported in wire envelope"));
    }
    const total = lengthLen + strLen;
    if (total > bytes.length) {
        return err(new Error("compact-len: declared length exceeds buffer"));
    }
    return ok(total);
}
/**
 * Internal listener bookkeeping and close-once state machine shared by the
 * built-in `WireProvider` implementations. Transport-specific code wires its
 * inbound source to `deliver`, registers cleanup via `onClose`, and exposes
 * `subscribe`/`subscribeClose` to callers.
 **/
function createBaseProvider() {
    const listeners = new Set();
    const closeListeners = new Set();
    const onCloseCleanup = new Set();
    let closedError = null;
    return {
        /** Current close error, or `null` while the provider is open. */
        closed: () => closedError,
        /** Dispatch an inbound frame to every active subscriber. */
        deliver(message) {
            if (closedError)
                return;
            for (const listener of [...listeners])
                listener(message);
        },
        /** Transition to the closed state. Idempotent. */
        close(error) {
            if (closedError)
                return;
            closedError = toError(error);
            for (const fn of [...onCloseCleanup]) {
                try {
                    fn();
                }
                catch {
                    // ignore cleanup failure
                }
            }
            onCloseCleanup.clear();
            for (const listener of [...closeListeners])
                listener(closedError);
            listeners.clear();
            closeListeners.clear();
        },
        /** Register a cleanup function to run exactly once when `close` fires. */
        onClose(fn) {
            if (closedError) {
                try {
                    fn();
                }
                catch {
                    // ignore cleanup failure
                }
                return;
            }
            onCloseCleanup.add(fn);
        },
        /** Register an inbound message listener. No-op after close. */
        subscribe(callback) {
            if (closedError)
                return () => { };
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            };
        },
        /**
         * Register a close listener. If the provider is already closed, the
         * callback fires immediately with the stored error.
         **/
        subscribeClose(callback) {
            if (closedError) {
                callback(closedError);
                return () => { };
            }
            closeListeners.add(callback);
            return () => {
                closeListeners.delete(callback);
            };
        },
    };
}
/**
 * Create a provider for the child side of an iframe `postMessage` channel.
 *
 * `target` is the `Window` the provider posts to (typically `window.parent`);
 * `hostOrigin` is the pinned `targetOrigin` for outbound frames and the
 * required `event.origin` of inbound frames. The provider only delivers
 * frames whose `event.source === target` and `event.origin === hostOrigin`,
 * so it cannot be coerced by an unrelated frame parent.
 **/
export function createIframeProvider(options) {
    const base = createBaseProvider();
    const { target, hostOrigin } = options;
    const onMessage = (event) => {
        if (event.source !== target)
            return;
        if (event.origin !== hostOrigin)
            return;
        if (!(event.data instanceof Uint8Array))
            return;
        base.deliver(event.data);
    };
    window.addEventListener("message", onMessage);
    base.onClose(() => window.removeEventListener("message", onMessage));
    return {
        postMessage(message) {
            const error = base.closed();
            if (error)
                throw error;
            try {
                target.postMessage(message, hostOrigin);
            }
            catch (error) {
                base.close(error);
                throw toError(error);
            }
        },
        subscribe: base.subscribe,
        subscribeClose: base.subscribeClose,
        dispose() {
            base.close(new Error("iframe provider disposed"));
        },
    };
}
/**
 * Create a provider from a web or Electron `MessagePort`.
 **/
export function createMessagePortProvider(port) {
    const base = createBaseProvider();
    let resolvedPort = null;
    const pending = [];
    void Promise.resolve(port)
        .then((p) => {
        if (base.closed()) {
            try {
                p.close();
            }
            catch {
                // ignore duplicate close during shutdown
            }
            return;
        }
        resolvedPort = p;
        p.onmessage = (event) => {
            if (event.data instanceof Uint8Array)
                base.deliver(event.data);
        };
        if ("onmessageerror" in p) {
            p.onmessageerror = () => {
                base.close(new Error("message port closed unexpectedly"));
            };
        }
        p.start();
        for (const msg of pending)
            p.postMessage(msg);
        pending.length = 0;
        base.onClose(() => {
            try {
                p.close();
            }
            catch {
                // ignore duplicate close during shutdown
            }
        });
    })
        .catch((error) => {
        base.close(error);
    });
    return {
        postMessage(message) {
            const error = base.closed();
            if (error)
                throw error;
            if (resolvedPort) {
                try {
                    resolvedPort.postMessage(message);
                }
                catch (error) {
                    base.close(error);
                    throw toError(error);
                }
            }
            else {
                pending.push(message);
            }
        },
        subscribe: base.subscribe,
        subscribeClose: base.subscribeClose,
        dispose() {
            base.close(new Error("message port provider disposed"));
            pending.length = 0;
        },
    };
}
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
export function createWebSocketProvider(url) {
    const base = createBaseProvider();
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const pending = [];
    let open = false;
    // `send` types its view as ArrayBuffer-backed. Frames never come from a
    // SharedArrayBuffer, and only the view's own bytes go on the wire, so a
    // frame that is a window into a larger buffer stays correct.
    const send = (frame) => socket.send(frame);
    let resolveOpened;
    let rejectOpened;
    const opened = new Promise((resolve, reject) => {
        resolveOpened = resolve;
        rejectOpened = reject;
    });
    // `opened` is optional for callers, so a failed connection must not surface as
    // an unhandled rejection. Close still reaches every `subscribeClose`.
    opened.catch(() => { });
    socket.addEventListener("open", () => {
        open = true;
        for (const frame of pending.splice(0))
            send(frame);
        resolveOpened();
    });
    socket.addEventListener("message", (event) => {
        base.deliver(new Uint8Array(event.data));
    });
    socket.addEventListener("error", () => {
        const error = new Error(`websocket error (${url})`);
        rejectOpened(error);
        base.close(error);
    });
    socket.addEventListener("close", () => {
        const error = new Error(`websocket closed (${url})`);
        rejectOpened(error);
        base.close(error);
    });
    base.onClose(() => {
        try {
            socket.close();
        }
        catch {
            // ignore duplicate close during shutdown
        }
    });
    return {
        opened,
        postMessage(message) {
            const error = base.closed();
            if (error)
                throw error;
            if (open) {
                try {
                    send(message);
                }
                catch (error) {
                    base.close(error);
                    throw toError(error);
                }
            }
            else {
                pending.push(message);
            }
        },
        subscribe: base.subscribe,
        subscribeClose: base.subscribeClose,
        dispose() {
            base.close(new Error("websocket provider disposed"));
            pending.length = 0;
        },
    };
}
