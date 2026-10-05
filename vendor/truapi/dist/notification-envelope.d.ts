export { NOTIFICATION_PREDICATE, MAX_NOTIFICATION_CANDIDATES } from "./notification-container.js";
export declare const MAX_HEADER_BYTES: number;
export declare const MAX_CARRIER_BYTES: number;
export declare const MAX_FULL_FRAME_BYTES: number;
export declare const MAX_TTL_MS = 86400000;
export declare const FUTURE_SKEW_MS = 60000;
/** Public authenticated metadata. Hex is lowercase, without a 0x prefix. */
export interface NotificationHeader {
    v: 1;
    product: string;
    genesis: string;
    channel: string;
    topics: string[];
    eventId: string;
    createdAt: number;
    expiresAt: number;
    ciphertextDigest: string;
    senderKey: string;
    signature: string;
}
export type UnsignedNotificationHeader = Omit<NotificationHeader, "signature">;
export type NotificationMetadata = Omit<UnsignedNotificationHeader, "v" | "ciphertextDigest" | "senderKey">;
/** Decoding alone does not authenticate the result. */
export interface NotificationEnvelope {
    header: NotificationHeader;
    carrier: Uint8Array;
}
/** Exact domain-separated UTF-8 tuple shared with the Rust verifier. */
export declare function notificationSigningBytes(header: UnsignedNotificationHeader): Uint8Array;
/** Inspect bounded standard Envelope nodes for reserved assertions.
 * This parses structure but not header JSON or its proof. Malformed containers throw:
 * callers must drop them, never fall back to another authentication path on errors.
 * Non-Envelope bytes and valid unmarked base Envelopes return false.
 */
export declare function isNotificationEnvelope(frame: Uint8Array): boolean;
/** Decode exactly one candidate; does not verify proof, source or freshness. */
export declare function decodeNotificationEnvelope(frame: Uint8Array): NotificationEnvelope;
/** Encode a minimal standard carrier; supplied proof is not verified. */
export declare function encodeNotificationEnvelope(header: NotificationHeader, carrier: Uint8Array): Uint8Array;
/** Sign public metadata over an opaque byte witness using a raw 32-byte seed.
 * Existing standard carriers can add JSON.stringify(result) as a
 * NOTIFICATION_PREDICATE assertion on any node containing the byte witness.
 */
export declare function signNotificationHeader(metadata: NotificationMetadata, carrier: Uint8Array, seed: Uint8Array): NotificationHeader;
/** Sign and emit a minimal standard carrier, in Node, Bun or a browser. */
export declare function signNotificationEnvelope(metadata: NotificationMetadata, carrier: Uint8Array, seed: Uint8Array): Uint8Array;
/** Authenticate optional stored metadata against supplied opaque bytes.
 * Checks strict JSON, static bounds, digest and Ed25519 proof only.
 * Does NOT establish current-time eligibility, actual source, product authority,
 * enrollment or sender approval. Hosts/relays must use whole-carrier verification.
 */
export declare function authenticateNotificationHeader(json: string, carrier: Uint8Array): NotificationHeader;
/** Authenticate stored bytes without applying current-time notification eligibility.
 * Enrollment, product, sender approval and replay policy remain caller responsibilities.
 * Subject bytes are copied so input mutation cannot alter authenticated output.
 */
export declare function authenticateNotificationEnvelope(frame: Uint8Array, actualGenesis: string, actualChannel: string, actualTopics: readonly string[]): NotificationEnvelope;
/** Authenticate a carrier and enforce current-time notification eligibility, or throw. */
export declare function verifyNotificationEnvelope(frame: Uint8Array, actualGenesis: string, actualChannel: string, actualTopics: readonly string[], nowMs: number): NotificationEnvelope;
/** Authenticate all candidates, omitting invalid proofs/headers, without current-time checks.
 * Malformed containers or structural ambiguities throw before any result is returned.
 */
export declare function authenticateNotificationEnvelopes(frame: Uint8Array, actualGenesis: string, actualChannel: string, actualTopics: readonly string[]): NotificationEnvelope[];
/** Authenticate up to 32 generic candidates and keep only notification-eligible ones.
 * A watch must match the SIGNED header topics, not unsigned extra actual topics.
 */
export declare function verifyNotificationEnvelopes(frame: Uint8Array, actualGenesis: string, actualChannel: string, actualTopics: readonly string[], nowMs: number): NotificationEnvelope[];
