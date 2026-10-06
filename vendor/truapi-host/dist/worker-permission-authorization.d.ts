import type { PermissionAuthorizationStatus } from "./runtime.js";
import type { WorkerToMain } from "./worker-protocol.js";
export interface PermissionAuthorizationRuntime {
    permissionAuthorizationStatus(productId: string, request: Uint8Array): Promise<PermissionAuthorizationStatus>;
    permissionAuthorizationStatuses(productId: string, requests: Uint8Array[]): Promise<PermissionAuthorizationStatus[]>;
    setPermissionAuthorizationStatus(productId: string, request: Uint8Array, status: PermissionAuthorizationStatus): Promise<void>;
}
type PostToMain = (msg: WorkerToMain) => void;
export declare function handleGetPermissionAuthorizationStatus(runtime: PermissionAuthorizationRuntime | null, postToMain: PostToMain, productId: string, requestId: number, request: Uint8Array): Promise<void>;
export declare function handleGetPermissionAuthorizationStatuses(runtime: PermissionAuthorizationRuntime | null, postToMain: PostToMain, productId: string, requestId: number, requests: Uint8Array[]): Promise<void>;
export declare function handleSetPermissionAuthorizationStatus(runtime: PermissionAuthorizationRuntime | null, postToMain: PostToMain, productId: string, requestId: number, request: Uint8Array, status: PermissionAuthorizationStatus): Promise<void>;
export {};
