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
function pumpIterator(iterator, onItem, label, onError) {
    let stopped = false;
    void (async () => {
        try {
            while (!stopped) {
                const next = await iterator.next();
                if (next.done)
                    return;
                onItem(next.value);
            }
        }
        catch (err) {
            console.error(`[truapi host callbacks] ${label} failed:`, err);
            onError?.({ reason: errorMessage(err) });
        }
    })();
    return () => {
        stopped = true;
        void iterator.return?.();
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
    return async (genesisHash, onResponse) => {
        const connection = await host.connect(hexToBytes(genesisHash));
        const iterator = connection.responses()[Symbol.asyncIterator]();
        const stopResponses = pumpIterator(iterator, onResponse, "chain responses");
        return {
            send(request) {
                connection.send(request);
            },
            close() {
                stopResponses();
                connection.close();
            },
        };
    };
}
