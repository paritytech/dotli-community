import type { WorkerCustomRendererSubscription, WorkerProductRuntime } from "./wasm-module.js";
import type { WorkerToMain } from "./worker-protocol.js";
type PostToMain = (msg: WorkerToMain) => void;
/**
 * Live render subscriptions, keyed by the main thread's render id. The core id
 * rides along so disposing one core cancels only its own renders.
 */
export type RenderSubscriptions = Map<number, {
    coreId: number;
    subscription: WorkerCustomRendererSubscription;
}>;
export declare function handlePublishChatAction(core: WorkerProductRuntime | undefined, postToMain: PostToMain, coreId: number, requestId: number, action: Uint8Array): void;
export declare function handleRenderCustomMessageStart(core: WorkerProductRuntime | undefined, postToMain: PostToMain, renders: RenderSubscriptions, coreId: number, renderId: number, messageId: string, messageType: string, payload: Uint8Array): void;
/** Cancel and release one render subscription. Idempotent. */
export declare function stopRender(renders: RenderSubscriptions, renderId: number): void;
/** Cancel every render belonging to one core, before that core is freed. */
export declare function stopRendersForCore(renders: RenderSubscriptions, coreId: number): void;
export {};
