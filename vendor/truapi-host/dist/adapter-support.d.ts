import { type GenericError, type Result } from "@parity/truapi";
import type { ChainConnect } from "./runtime.js";
import type { ChainProvider } from "./generated/host-callbacks.js";
type WireResult<T, E> = {
    success: true;
    value: T;
} | {
    success: false;
    value: E;
};
type StreamResult<T, E> = Result<T, E> | WireResult<T, E>;
type MaybeAsyncIterable<T> = AsyncIterable<T> | Iterable<T>;
/**
 * Drive a typed host stream of `Result` items into the core's `sendItem`
 * sink, unwrapping each `Result` (or throwing on its error). Returns a
 * disposer that stops iteration.
 */
export declare function driveResultStream<T>(stream: MaybeAsyncIterable<StreamResult<T, GenericError>>, sendItem: (value: T) => void, sendError: (error: GenericError) => void): () => void;
/**
 * Bridge the typed `ChainProvider.connect` callback onto the raw
 * `chainConnect` the WASM core invokes: decode the genesis hash, pump the
 * connection's `responses()` stream into `onResponse`, and expose
 * `send`/`close`.
 */
export declare function chainConnectAdapter(host: Pick<ChainProvider, "connect">): ChainConnect;
export {};
