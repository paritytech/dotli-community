import { type GenericError, type Result } from "@parity/truapi";
import type { ChainConnect, HopConnect } from "./runtime.js";
import type { ChainProvider, CoinageWalletHost, ContactsPlatform, HopProvider, NativeChatFilesHost, ProfilePlatform } from "./generated/host-callbacks.js";
/** Optional Contacts UI stays unsupported rather than confirming an empty selection. */
export declare function contactsHostAdapter(host: ContactsPlatform | undefined): Required<ContactsPlatform> | undefined;
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
export declare function driveResultStream<T>(stream: MaybeAsyncIterable<StreamResult<T, GenericError>>, sendItem: (value: T) => void, sendError: (error: GenericError) => void, privateMedia?: boolean): () => void;
/**
 * Bridge the typed `ChainProvider.connect` callback onto the raw
 * `chainConnect` the WASM core invokes: decode the genesis hash, pump the
 * connection's `responses()` stream into `onResponse`, and expose
 * `send`/`close`.
 */
export declare function chainConnectAdapter(host: Pick<ChainProvider, "connect">): ChainConnect;
/** A missing HOP embedding is unavailable, never a successful no-op socket. */
export declare const unavailableHopProvider: Required<HopProvider>;
/** Native exceptions may contain bearer material; preserve only typed failure values. */
export declare function coinageWalletHostAdapter(host: Required<CoinageWalletHost> | undefined): Required<CoinageWalletHost> | undefined;
/**
 * A profile host built before `presentContactProfile` still shows a contact's
 * profile: without it, the contact's reference is presented as
 * `presentProfile` would. Empty-profile feedback requires the contact callback.
 * Missing avatar placement draws nothing, matching the Rust platform default;
 * resolving does not promise that any avatar was rendered.
 */
export declare function profileHostAdapter(host: ProfilePlatform | undefined): Required<ProfilePlatform> | undefined;
/** Optional SDK embeddings must fail closed, never invent successful file handles. */
export declare const unavailableNativeChatFilesHost: Required<NativeChatFilesHost>;
export declare function hopConnectAdapter(host: Required<HopProvider>): HopConnect;
export {};
