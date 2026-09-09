import type { GenericError, NotificationId } from "@parity/truapi";
import type { RequiredHostCallbacks } from "./host-callbacks.js";
import type { ChainConnect } from "../runtime.js";
/**
 * Byte-oriented callback surface the WASM core invokes. Members of an
 * optional capability are absent when the host omits the capability;
 * the core then answers the matching product calls with `Unsupported`.
 */
export interface RawCallbacks {
    authStateChanged(state: Uint8Array): void;
    chainConnect: ChainConnect;
    createChatRoom?(product: Uint8Array, request: Uint8Array): Promise<Uint8Array>;
    registerChatBot?(product: Uint8Array, request: Uint8Array): Promise<Uint8Array>;
    postChatMessage?(product: Uint8Array, request: Uint8Array): Promise<Uint8Array>;
    subscribeChatRooms?(product: Uint8Array, sendItem: (item?: Uint8Array) => void, sendError: (error: GenericError) => void): (() => void) | void;
    readCoreStorage(key: Uint8Array): Promise<Uint8Array | null | undefined>;
    writeCoreStorage(key: Uint8Array, value: Uint8Array): Promise<void>;
    clearCoreStorage(key: Uint8Array): Promise<void>;
    featureSupported(request: Uint8Array): Promise<Uint8Array>;
    supportedChains(): Promise<Uint8Array>;
    subscribeLocale(sendItem: (item?: Uint8Array) => void, sendError: (error: GenericError) => void): (() => void) | void;
    navigateTo(url: string): Promise<void>;
    pushNotification(notification: Uint8Array): Promise<Uint8Array>;
    cancelNotification(id: NotificationId): Promise<void>;
    devicePermissionStatus?(request: Uint8Array): Promise<Uint8Array>;
    devicePermission(request: Uint8Array): Promise<Uint8Array>;
    remotePermission(request: Uint8Array): Promise<Uint8Array>;
    lookupPreimage(key: Uint8Array, sendItem: (item?: Uint8Array) => void, sendError: (error: GenericError) => void): (() => void) | void;
    read(key: string): Promise<Uint8Array | null | undefined>;
    write(key: string, value: Uint8Array): Promise<void>;
    clear(key: string): Promise<void>;
    subscribeTheme(sendItem: (item?: Uint8Array) => void, sendError: (error: GenericError) => void): (() => void) | void;
    confirmUserAction(review: Uint8Array): Promise<boolean>;
}
/** Adapt typed host callbacks into the raw SCALE callback surface the
 *  WASM core invokes. */
export declare function createWasmRawCallbacks(callbacks: RequiredHostCallbacks): RawCallbacks;
