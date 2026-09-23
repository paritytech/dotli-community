// Hand-written runtime support for the generated `createWasmRawCallbacks`
// adapter (`./generated/host-callbacks-adapter.ts`). The adapter is mechanical
// (decode params, call the typed host callback, read the result); the pieces
// here are the genuinely bespoke runtime plumbing it leans on: stream driving
// and the chain-connection handle.
import { hexToBytes } from "@parity/truapi/scale";
import { errorMessage } from "./error.js";
/**
 * Normalize both generated `Result<T, GenericError>` values and the plain
 * `{ success, value }` envelope used by some JS fixtures into a raw item.
 */
function unwrapStreamResult(item) {
    if ("success" in item) {
        if (item.success === false) {
            throw new Error(item.value.reason);
        }
        return item.value;
    }
    if (item.isErr()) {
        throw new Error(item.error.reason);
    }
    return item.value;
}
/**
 * Accept sync and async host streams behind one async-iterator interface.
 * Host callbacks often use async iterables in production, while tests can use
 * small synchronous fixtures without a custom wrapper.
 */
function toAsyncIterator(stream) {
    const asyncIterable = stream;
    if (typeof asyncIterable[Symbol.asyncIterator] === "function") {
        return asyncIterable[Symbol.asyncIterator]();
    }
    const iterator = stream[Symbol.iterator]();
    const asyncIterator = {
        next: async () => iterator.next(),
    };
    if (iterator.return) {
        asyncIterator.return = async () => iterator.return();
    }
    return asyncIterator;
}
/**
 * Drain an async iterator into a sink until disposed. This is used for
 * callback streams where the Rust core owns cancellation but JS owns the
 * iterator and any transport cleanup behind `return()`.
 */
function pumpIterator(iterator, onItem, label, onError, onComplete) {
    let stopped = false;
    void (async () => {
        try {
            while (!stopped) {
                const next = await iterator.next();
                if (stopped || next.done)
                    return;
                onItem(next.value);
            }
        }
        catch (err) {
            if (!stopped) {
                console.error(`[truapi host callbacks] ${label} failed`);
                onError?.({ reason: errorMessage(err) });
            }
        }
        finally {
            if (!stopped)
                onComplete?.();
        }
    })();
    return () => {
        if (stopped)
            return;
        stopped = true;
        try {
            void Promise.resolve(iterator.return?.()).catch(() => {
                console.error(`[truapi host callbacks] ${label} cleanup failed`);
            });
        }
        catch {
            console.error(`[truapi host callbacks] ${label} cleanup failed`);
        }
    };
}
/**
 * Drive a typed host stream of `Result` items into the core's `sendItem`
 * sink, unwrapping each `Result` (or throwing on its error). Returns a
 * disposer that stops iteration.
 */
export function driveResultStream(stream, sendItem, sendError) {
    return pumpIterator(toAsyncIterator(stream), (value) => sendItem(unwrapStreamResult(value)), "subscription", sendError);
}
/**
 * Bridge the typed `ChainProvider.connect` callback onto the raw
 * `chainConnect` the WASM core invokes: decode the genesis hash, pump the
 * connection's `responses()` stream into `onResponse`, and expose
 * `send`/`close`.
 */
export function chainConnectAdapter(host) {
    return async (genesisHash, onResponse, onClosed) => rpcConnectionAdapter(await host.connect(hexToBytes(genesisHash)), onResponse, onClosed);
}
/** A missing HOP embedding is unavailable, never a successful no-op socket. */
export const unavailableHopProvider = {
    async allowedHopEndpoints() {
        return [];
    },
    async connectHop() {
        throw new Error("HOP provider is unavailable");
    },
};
/** Native exceptions may contain bearer material; preserve only typed failure values. */
export function coinageWalletHostAdapter(host) {
    if (host === undefined)
        return undefined;
    let nativeCoinage;
    try {
        nativeCoinage = host.nativeCoinage.bind(host);
    }
    catch {
        throw new Error("Native Coinage wallet callback is unavailable");
    }
    return {
        async nativeCoinage(request) {
            try {
                return await nativeCoinage(request);
            }
            catch {
                throw new Error("Native Coinage wallet operation failed");
            }
        },
    };
}
/** Optional SDK embeddings must fail closed, never invent successful file handles. */
export const unavailableNativeChatFilesHost = {
    async pickChatFiles() {
        throw new Error("Native Chat files are unavailable");
    },
    async readChatFile() {
        throw new Error("Native Chat files are unavailable");
    },
    async releaseChatFile() {
        throw new Error("Native Chat files are unavailable");
    },
    async beginChatFileExport() {
        throw new Error("Native Chat files are unavailable");
    },
    async writeChatFileExport() {
        throw new Error("Native Chat files are unavailable");
    },
    async finishChatFileExport() {
        throw new Error("Native Chat files are unavailable");
    },
    async cancelChatFileExport() {
        throw new Error("Native Chat files are unavailable");
    },
};
export function hopConnectAdapter(host) {
    return async (genesisHash, endpoint, onResponse, onClosed) => {
        const genesis = hexToBytes(genesisHash);
        const allowed = await host.allowedHopEndpoints(genesis);
        // Check the original string, never a normalized URL against the allowlist.
        if (!allowed.includes(endpoint) ||
            !endpoint.startsWith("wss://") ||
            /[\s\u0000-\u001f\u007f-\u009f#\\]/u.test(endpoint) ||
            endpoint.slice(6).split(/[/?]/u, 1)[0].includes("@")) {
            throw new Error("HOP endpoint is not an allowed secure WebSocket URL");
        }
        const url = new URL(endpoint);
        if (!url.hostname || url.username || url.password || url.hash) {
            throw new Error("HOP endpoint is not an allowed secure WebSocket URL");
        }
        return rpcConnectionAdapter(await host.connectHop(genesis, endpoint), onResponse, onClosed);
    };
}
/** Chain and HOP share response pumping and exactly-once transport cleanup. */
function rpcConnectionAdapter(connection, onResponse, onClosed) {
    let closed = false;
    let stopResponses;
    const close = (notify) => {
        if (closed)
            return;
        closed = true;
        stopResponses?.();
        try {
            connection.close();
        }
        finally {
            if (notify)
                onClosed?.();
        }
    };
    try {
        stopResponses = pumpIterator(connection.responses()[Symbol.asyncIterator](), onResponse, "JSON-RPC responses", undefined, () => {
            try {
                close(true);
            }
            catch {
                console.error("[truapi host callbacks] JSON-RPC close failed");
            }
        });
        // A synchronous iterator failure can close before pumpIterator returns.
        if (closed)
            stopResponses();
    }
    catch (err) {
        close(false);
        throw err;
    }
    return {
        send(request) {
            if (closed)
                throw new Error("JSON-RPC connection is closed");
            try {
                connection.send(request);
            }
            catch (err) {
                close(true);
                throw err;
            }
        },
        close: () => close(false),
    };
}
