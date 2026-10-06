import type { GenericError } from "@parity/truapi";
import type { RequiredHostCallbacks } from "./host-callbacks.js";
import type { ChainConnect, HopConnect } from "../runtime.js";
/**
 * Byte-oriented callback surface the WASM core invokes. Members of an
 * optional capability are absent when the host omits the capability;
 * the core then answers the matching product calls with `Unsupported`.
 */
export interface RawCallbacks {
    authStateChanged?(state: Uint8Array): void;
    chainConnect: ChainConnect;
    createChatRoom?(product: Uint8Array, request: Uint8Array): Promise<Uint8Array>;
    registerChatBot?(product: Uint8Array, request: Uint8Array): Promise<Uint8Array>;
    postChatMessage?(product: Uint8Array, request: Uint8Array): Promise<Uint8Array>;
    subscribeChatRooms?(product: Uint8Array, sendItem: (item?: Uint8Array) => void, sendError: (error: GenericError) => void): (() => void) | void;
    nativeCoinage?(request: Uint8Array): Promise<Uint8Array>;
    contacts?(lookup: Uint8Array): Promise<Uint8Array>;
    pickContact?(product: Uint8Array): Promise<Uint8Array>;
    pickContacts?(product: Uint8Array, selection: Uint8Array): Promise<Uint8Array>;
    placeContactLabels?(product: Uint8Array, placed: Uint8Array): Promise<boolean>;
    readCoreStorage(key: Uint8Array): Promise<Uint8Array | null | undefined>;
    writeCoreStorage(key: Uint8Array, value: Uint8Array): Promise<void>;
    clearCoreStorage(key: Uint8Array): Promise<void>;
    compareExchangeCoreStorage(key: Uint8Array, expected: Uint8Array | null | undefined, replacement: Uint8Array, notifyOnSuccess: boolean): Promise<boolean>;
    coreStorageChanged(key: Uint8Array): void;
    featureSupported(request: Uint8Array): Promise<Uint8Array>;
    supportedChains(): Promise<Uint8Array>;
    allowedHopEndpoints?(bulletinGenesisHash: Uint8Array): Promise<Uint8Array>;
    hopConnect?: HopConnect;
    identityUsernameCandidates?(username: string, peopleChainGenesisHash: Uint8Array): Promise<Uint8Array>;
    subscribeLocale(sendItem: (item?: Uint8Array) => void, sendError: (error: GenericError) => void): (() => void) | void;
    localizeTimestamps?(request: Uint8Array): Promise<Uint8Array>;
    mediaBackendCapabilities?(product: Uint8Array): Promise<Uint8Array>;
    mediaBackendEvents?(product: Uint8Array, runtimeId: bigint, sendItem: (item?: Uint8Array) => void, sendError: (error: GenericError) => void): (() => void) | void;
    mediaBackendCommand?(product: Uint8Array, runtimeId: bigint, command: Uint8Array): Promise<Uint8Array>;
    pickChatFiles(request: Uint8Array): Promise<Uint8Array>;
    readChatFile(sourceId: string, offset: bigint, length: number): Promise<Uint8Array>;
    releaseChatFile(sourceId: string): Promise<void>;
    beginChatFileExport(request: Uint8Array): Promise<string | null | undefined>;
    writeChatFileExport(exportId: string, offset: bigint, data: Uint8Array): Promise<void>;
    finishChatFileExport(exportId: string): Promise<void>;
    cancelChatFileExport(exportId: string): Promise<void>;
    navigateTo(url: string): Promise<void>;
    pushNotification(notification: Uint8Array): Promise<Uint8Array>;
    cancelNotification?(id: number): Promise<void>;
    receiverAuthority?(productId: string): Promise<Uint8Array | null | undefined>;
    receiverConsent?(authority: Uint8Array, watches: Uint8Array): Promise<boolean>;
    receiverChanged?(): Promise<void>;
    receiverCommand?(productId: string, action: number, payload: Uint8Array): Promise<Uint8Array | null | undefined>;
    activationEvents?(): Promise<Uint8Array>;
    acknowledgeActivation?(request: Uint8Array): Promise<void>;
    devicePermissionStatus?(request: Uint8Array): Promise<Uint8Array>;
    devicePermission(product: Uint8Array, request: Uint8Array): Promise<Uint8Array>;
    remotePermission(product: Uint8Array, request: Uint8Array): Promise<Uint8Array>;
    subscribePocketCards?(product: Uint8Array, sendItem: (item?: Uint8Array) => void, sendError: (error: GenericError) => void): (() => void) | void;
    removePocketCard?(product: Uint8Array, request: Uint8Array): Promise<void>;
    lookupPreimage(key: Uint8Array, sendItem: (item?: Uint8Array) => void, sendError: (error: GenericError) => void): (() => void) | void;
    beginOperation(product: Uint8Array, label: string): Promise<Uint8Array>;
    endOperation(product: Uint8Array, id: number): Promise<void>;
    read(key: string): Promise<Uint8Array | null | undefined>;
    write(key: string, value: Uint8Array): Promise<void>;
    clear(key: string): Promise<void>;
    subscribeStorage(key: string, sendItem: (item?: Uint8Array) => void, sendError: (error: GenericError) => void): (() => void) | void;
    presentProfile?(product: Uint8Array, request: Uint8Array): Promise<void>;
    presentContactProfile?(product: Uint8Array, presented: Uint8Array): Promise<void>;
    placeContactAvatars?(product: Uint8Array, placed: Uint8Array): Promise<void>;
    subscribeTheme(sendItem: (item?: Uint8Array) => void, sendError: (error: GenericError) => void): (() => void) | void;
    confirmPermission?(review: Uint8Array): Promise<Uint8Array>;
    confirmUserAction(review: Uint8Array): Promise<boolean>;
}
/** Adapt typed host callbacks into the raw SCALE callback surface the
 *  WASM core invokes. */
export declare function createWasmRawCallbacks(callbacks: RequiredHostCallbacks): RawCallbacks;
