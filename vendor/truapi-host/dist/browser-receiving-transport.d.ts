import type { ReceivingAuthority, ReceivingRegistration } from "./runtime.js";
export declare const randomReceiverToken: () => string;
/** Host-private transport credentials. Never expose these records to products. */
export interface BrowserReceiverEnrollment {
    authority: ReceivingAuthority;
    deviceId: string;
    secret: string;
    ownerKey: string;
    privateKey: CryptoKey;
    relayRevision: number;
    coreRevision: bigint;
    routes: Record<string, string>;
    acknowledged: boolean;
    revoked: boolean;
}
export declare function createReceiverEnrollment(authority: ReceivingAuthority): Promise<BrowserReceiverEnrollment>;
/** The configured relay is trusted transport, never authority for app content. */
export declare class BrowserReceivingTransport {
    private readonly origin;
    private readonly base;
    constructor(relayUrl: string, origin: string);
    private request;
    register(enrollment: BrowserReceiverEnrollment, registration: ReceivingRegistration, destination: PushSubscriptionJSON): Promise<void>;
    revoke(enrollment: BrowserReceiverEnrollment): Promise<void>;
    event(enrollment: BrowserReceiverEnrollment, eventId: string): Promise<{
        revision: number;
        watchId: string;
        genesis: string;
        channel: string;
        topics: string[];
        frame: Uint8Array;
    }>;
}
