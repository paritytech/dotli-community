import type { WorkerRendererSubscription, WorkerProductRuntime } from "./wasm-module.js";
import type { WorkerToMain } from "./worker-protocol.js";
type PostToMain = (msg: WorkerToMain) => void;
/**
 * Live render subscriptions, keyed by the main thread's render id. The core id
 * rides along so disposing one core cancels only its own renders.
 */
export type RenderSubscriptions = Map<number, {
    coreId: number;
    subscription: WorkerRendererSubscription;
}>;
/**
 * Open one render stream on the core and forward its items to the main thread.
 * Exactly one terminal is posted per render: the core rejects a request it
 * cannot start by throwing, and otherwise delivers the terminal asynchronously.
 */
export declare function handleRenderStart(core: WorkerProductRuntime | undefined, postToMain: PostToMain, renders: RenderSubscriptions, coreId: number, renderId: number, request: Uint8Array): void;
/** Cancel and release one render subscription. Idempotent. */
export declare function stopRender(renders: RenderSubscriptions, renderId: number): void;
/** Cancel every render belonging to one core, before that core is freed. */
export declare function stopRendersForCore(renders: RenderSubscriptions, coreId: number): void;
export {};
