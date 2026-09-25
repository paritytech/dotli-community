import type { RawCallbacks } from "./host-callbacks-adapter.js";
import type { GenericError } from "@parity/truapi";
import type { ChainConnect, HopConnect } from "../runtime.js";
export declare const CALLBACK_NAMES: readonly ["authStateChanged", "createChatRoom", "registerChatBot", "postChatMessage", "nativeCoinage", "readCoreStorage", "writeCoreStorage", "clearCoreStorage", "featureSupported", "supportedChains", "allowedHopEndpoints", "identityUsernameCandidates", "pickChatFiles", "readChatFile", "releaseChatFile", "beginChatFileExport", "writeChatFileExport", "finishChatFileExport", "cancelChatFileExport", "navigateTo", "pushNotification", "cancelNotification", "devicePermissionStatus", "devicePermission", "remotePermission", "removePocketCard", "beginOperation", "endOperation", "read", "write", "clear", "presentProfile", "confirmPermission", "confirmUserAction"];
export type CallbackName = typeof CALLBACK_NAMES[number];
export declare const SUBSCRIPTION_NAMES: readonly ["subscribeChatRooms", "subscribeLocale", "subscribePocketCards", "lookupPreimage", "subscribeStorage", "subscribeTheme"];
export type SubscriptionName = typeof SUBSCRIPTION_NAMES[number];
export interface WorkerCallbackBridge {
    callbackRequest(name: CallbackName, args: readonly unknown[]): Promise<unknown>;
    startSubscription<T>(name: SubscriptionName, payload: Uint8Array | string | null, sendItem: (value: T) => void, sendError: (error: GenericError) => void): () => void;
    chainConnect: ChainConnect;
    hopConnect: HopConnect;
}
/**
 * Optional capabilities the main-thread host actually serves. A
 * capability left out here is not proxied into the worker, so the
 * core applies that capability's absence behavior.
 */
export interface OptionalCapabilities {
    /** Whether the host serves this capability. */
    chat?: boolean;
    /** Whether the host serves this capability. */
    coinageWallet?: boolean;
    /** Whether the host serves this capability. */
    identityBackend?: boolean;
    /** Whether the host serves this capability. */
    permissionStatus?: boolean;
    /** Whether the host serves this capability. */
    pocket?: boolean;
    /** Whether the host serves this capability. */
    profile?: boolean;
}
export declare function createWorkerRawCallbacks(bridge: WorkerCallbackBridge, capabilities?: OptionalCapabilities): Record<string, unknown>;
export declare function startRawSubscription(callbacks: RawCallbacks, name: SubscriptionName, payload: Uint8Array | string | null, sendItem: (value?: unknown) => void, sendError: (error: GenericError) => void): (() => void) | void;
