import type { RawCallbacks } from "./host-callbacks-adapter.js";
import type { GenericError } from "@parity/truapi";
import type { ChainConnect } from "../runtime.js";
export declare const CALLBACK_NAMES: readonly ["authStateChanged", "createChatRoom", "registerChatBot", "postChatMessage", "readCoreStorage", "writeCoreStorage", "clearCoreStorage", "featureSupported", "supportedChains", "navigateTo", "pushNotification", "cancelNotification", "devicePermissionStatus", "devicePermission", "remotePermission", "read", "write", "clear", "confirmUserAction"];
export type CallbackName = typeof CALLBACK_NAMES[number];
export declare const SUBSCRIPTION_NAMES: readonly ["subscribeChatRooms", "subscribeLocale", "lookupPreimage", "subscribeTheme"];
export type SubscriptionName = typeof SUBSCRIPTION_NAMES[number];
export interface WorkerCallbackBridge {
    callbackRequest(name: CallbackName, args: readonly unknown[]): Promise<unknown>;
    startSubscription<T>(name: SubscriptionName, payload: Uint8Array | null, sendItem: (value: T) => void, sendError: (error: GenericError) => void): () => void;
    chainConnect: ChainConnect;
}
/**
 * Optional capabilities the main-thread host actually serves. A
 * capability left out here is not proxied into the worker, so the
 * core answers its product calls with `Unsupported`.
 */
export interface OptionalCapabilities {
    /** Whether the host serves this capability. */
    chat?: boolean;
    /** Whether the host serves this capability. */
    permissionStatus?: boolean;
}
export declare function createWorkerRawCallbacks(bridge: WorkerCallbackBridge, capabilities?: OptionalCapabilities): Record<string, unknown>;
export declare function startRawSubscription(callbacks: RawCallbacks, name: SubscriptionName, payload: Uint8Array | null, sendItem: (value?: unknown) => void, sendError: (error: GenericError) => void): (() => void) | void;
