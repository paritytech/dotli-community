import type { ReceivingEvent, ReceivingWatch } from "@parity/truapi";
import type { ReceivingAuthority } from "./runtime.js";
export interface BrowserReceivingClientOptions {
    registration: ServiceWorkerRegistration;
    /** Trusted host UI. An OS notification grant is not receiving consent. */
    consent(authority: ReceivingAuthority, watches: ReceivingWatch[]): Promise<boolean>;
    /** Return true only after the exact verified product is ready in the unlocked account. */
    activate(authority: ReceivingAuthority, event: ReceivingEvent): Promise<boolean>;
}
export interface BrowserReceivingExecution {
    command(action: number, payload: Uint8Array): Promise<Uint8Array>;
    ready(): Promise<void>;
    close(): void;
}
export interface BrowserReceivingAuthorityState extends ReceivingAuthority {
    revoked: boolean;
}
export interface BrowserReceivingClient {
    getAuthority(productId: string): Promise<BrowserReceivingAuthorityState | undefined>;
    updateAuthority(authority: ReceivingAuthority): Promise<void>;
    /** Update only from the current trusted host selection, never a product claim.
     * Undefined pauses; closing a product/page must not call this method. */
    setActiveAccount(account: string | undefined, environment: string, genesis: string): Promise<void>;
    bindExecution(authority: ReceivingAuthority): Promise<BrowserReceivingExecution>;
    enableWebPush(vapidPublicKey: string): Promise<void>;
    revoke(productId: string): Promise<void>;
    /** Explicit host logout/erase, including products with no open execution. */
    revokeAll(): Promise<void>;
    refresh(): Promise<void>;
    close(): void;
}
/** Use only in the trusted host page, never in a product iframe. */
export declare function createBrowserReceivingClient(options: BrowserReceivingClientOptions): BrowserReceivingClient;
export type { ReceivingAuthority } from "./runtime.js";
