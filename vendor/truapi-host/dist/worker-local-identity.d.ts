import type { LocalIdentity, LocalIdentityProgress } from "./worker-protocol.js";
import type { WorkerSigningHostRuntime } from "./wasm-module.js";
/** HTTP stays in the worker; all secret material and proof construction stay native. */
export declare function resolveLocalIdentity(runtime: WorkerSigningHostRuntime, signal: AbortSignal, registration?: {
    baseUsername: string;
    identityBackendBaseUrl: string;
}, onProgress?: (progress: LocalIdentityProgress) => void): Promise<LocalIdentity>;
