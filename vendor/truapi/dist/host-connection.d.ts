import { type TrUApiClient } from "./generated/client.js";
import { type InternalTrUApiClient } from "./generated/internal-client.js";
import type { ConnectionStatus } from "./sandbox.js";
import { type WebSocketWireProvider } from "./transport.js";
/** One native host connection shared by product calls and browser authorization. */
export interface HostConnection {
    /** Stable public client. Reading it also connects passive host-initiated handlers. */
    readonly client: TrUApiClient;
    /** Private generated authorization methods on the same transport. */
    readonly internal: InternalTrUApiClient;
    /** Startup compatibility for SDKs predating the injected client. */
    readonly legacyPort: MessagePort;
    /** Observe connection readiness without replacing the client. */
    subscribeConnectionStatus(callback: (status: ConnectionStatus) => void): () => void;
    /** End this execution's connection permanently. */
    dispose(): void;
}
/** Creates a client whose interrupted operations fail and whose later calls reconnect. */
export declare function createHostConnection(url: string, createProvider?: (url: string) => WebSocketWireProvider): HostConnection;
