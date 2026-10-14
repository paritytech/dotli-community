export { createHostConnection, type HostConnection, } from "./host-connection.js";
export { createInternalClient, type InternalTrUApiClient, } from "./generated/internal-client.js";
/** Protects result handling when host authorization shares the product's realm. */
export declare function freezeInternalResults(): void;
