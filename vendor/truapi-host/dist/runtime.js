import { CoreStorageKey as GeneratedCoreStorageKey } from "./generated/host-callbacks.js";
// The typed capability interfaces below come straight from the
// `truapi-platform` Rust crate via `truapi-codegen --platform-ts-output`.
// They are the host-author-facing surface: each method takes/returns
// typed wrappers (`HostDevicePermissionRequest`, etc.) rather than raw
// SCALE bytes. The web worker pairing-host runtime adapts this typed surface
// into the byte-oriented callback bridge consumed by the WASM core.
export * from "./generated/host-callbacks.js";
/** Encode a typed core-storage slot for hosts that need an opaque backing key. */
export function encodeCoreStorageKey(key) {
    return GeneratedCoreStorageKey.enc(key);
}
