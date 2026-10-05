import { type RawNotificationReceiver } from "./runtime.js";
export interface BrowserReceivingWorkerOptions {
    scope: ServiceWorkerGlobalScope;
    createReceiver(callbacks: {
        receiverAuthority(productId: string): Promise<Uint8Array | undefined>;
        receiverConsent(authority: Uint8Array, watches: Uint8Array): Promise<boolean>;
        receiverChanged(): Promise<void>;
        readReceivingState(): Promise<Uint8Array | undefined>;
        writeReceivingState(bytes: Uint8Array): Promise<void>;
    }): Promise<RawNotificationReceiver> | RawNotificationReceiver;
    relayUrl: string;
    /** Must equal the relay's configured PUSH_ORIGIN, not a product URL. */
    pushOrigin: string;
    /** Fixed trusted same-origin host entry. Routes in events are never navigated. */
    hostEntryUrl: string;
    notificationTitle: string;
    databaseName?: string;
}
/** Compose into the host's existing service worker. Installs no competing worker. */
export declare function installBrowserReceivingWorker(options: BrowserReceivingWorkerOptions): void;
