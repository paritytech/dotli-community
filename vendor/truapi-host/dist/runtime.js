import { ReceivingEvent, ReceivingWatch } from "@parity/truapi";
import { Option, Vector } from "@parity/truapi/scale";
import { ReceivingAuthority, ReceivingRegistration, } from "./generated/host-callbacks.js";
import { CoreStorageKey as GeneratedCoreStorageKey } from "./generated/host-callbacks.js";
// The typed capability interfaces below come straight from the
// `truapi::platform` Rust module via `truapi-codegen --platform-ts-output`.
// They are the host-author-facing surface: each method takes/returns
// typed wrappers (`HostDevicePermissionRequest`, etc.) rather than raw
// SCALE bytes. The web worker pairing-host runtime adapts this typed surface
// into the byte-oriented callback bridge consumed by the WASM core.
export * from "./generated/host-callbacks.js";
/** Encode a typed core-storage slot for hosts that need an opaque backing key. */
export function encodeCoreStorageKey(key) {
    return GeneratedCoreStorageKey.enc(key);
}
/** Canonical SCALE results returned by resident receiving runtime hooks. */
export const receivingRegistrationsCodec = Vector(ReceivingRegistration);
export const receivingEventsCodec = Vector(ReceivingEvent);
export const receivingEventCodec = Option(ReceivingEvent);
const receivingWatchesCodec = Vector(ReceivingWatch);
/** Encode only the canonical domain records at the standalone WASM boundary. */
export function createNotificationReceiverCallbacks(callbacks) {
    return {
        receiverAuthority: async (productId) => {
            const authority = await callbacks.receiverAuthority?.(productId);
            return authority === undefined ? undefined : ReceivingAuthority.enc(authority);
        },
        receiverConsent: async (authority, watches) => {
            if (!callbacks.receiverConsent)
                throw new Error("background receiving unsupported");
            return callbacks.receiverConsent(ReceivingAuthority.dec(authority), receivingWatchesCodec.dec(watches));
        },
        receiverChanged: async () => {
            if (!callbacks.receiverChanged)
                throw new Error("background receiving unsupported");
            return callbacks.receiverChanged();
        },
        readReceivingState: async () => callbacks.readReceivingState(),
        writeReceivingState: async (bytes) => callbacks.writeReceivingState(bytes),
    };
}
