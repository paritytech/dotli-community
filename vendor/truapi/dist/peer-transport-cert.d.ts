/**
 * Deterministic WebTransport certificate hashes for a PolkaJAM peer.
 *
 * PolkaJAM (`crates/node/src/net/cert.rs`, `dd9af78`) serves an unsigned X.509
 * certificate for its P-256 peer key: serial 0, issuer and subject `CN=jam`,
 * one dNSName SAN equal to the peer-id text, Ed25519 signature algorithm with
 * an all-zero 64-byte signature, and a validity window derived from a fixed
 * 10-day period padded by one day on both sides. A client that knows the
 * peer's compressed P-256 key can therefore compute the certificate hashes
 * offline and pass them as `serverCertificateHashes`. These bytes mirror
 * PolkaJAM's `crates/node/src/net/cert.rs` generated with rcgen 0.14.8.
 */
export declare const UNPADDED_VALIDITY_PERIOD_SECS: number;
export declare const VALIDITY_PERIOD_PADDING_SECS: number;
/** PolkaJAM peer-id text: prefix letter then 32 bytes, base-32 LSB-first. */
export declare function peerIdText(prefix: string, bytes: Uint8Array): string;
/** Parse `e…`, `o…` or `v…` text into (prefix, 32 bytes). */
export declare function parsePeerIdText(text: string): {
    prefix: string;
    bytes: Uint8Array;
};
/** `o…`/`v…` text to a compressed SEC1 P-256 point (0x03 odd y / 0x02 even y). */
export declare function p256IdToCompressed(text: string): Uint8Array;
/** Ed25519 `e…` text to the 32-byte public key. */
export declare function ed25519IdToKey(text: string): Uint8Array;
/** Uncompressed SEC1 (0x04 ‖ x ‖ y) for a compressed P-256 point; p ≡ 3 mod 4. */
export declare function decompressP256(compressed: Uint8Array): Uint8Array;
/** Fixed 10-day period index for a unix time; the server switches at boundaries. */
export declare function validityPeriodAt(unixSecs: number): number;
/** `[notBefore, notAfter]` unix seconds of a period (padded by one day). */
export declare function validityBounds(period: number): [number, number];
/** DER certificate PolkaJAM presents for `compressed` during `period`. */
export declare function webTransportCertificateDer(compressed: Uint8Array, period: number): Uint8Array;
/** SHA-256 of {@link webTransportCertificateDer}. */
export declare function webTransportCertificateHash(compressed: Uint8Array, period: number): Uint8Array;
/**
 * Hashes to pass as `serverCertificateHashes` at `unixSecs`: the current
 * period plus both neighbours, so a clock skew or a boundary crossing during
 * the handshake still matches whichever certificate the server picked.
 */
export declare function webTransportCertificateHashes(compressed: Uint8Array, unixSecs: number): Uint8Array[];
