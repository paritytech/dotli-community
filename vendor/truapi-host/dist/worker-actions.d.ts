import type { WorkerProductRuntime } from "./wasm-module.js";
import type { WorkerToMain } from "./worker-protocol.js";
type PostToMain = (msg: WorkerToMain) => void;
/** One host-authored action stream, as the worker sees it. */
export interface ActionEntryPoint {
    /** Request kind the host posts; the response kind is this plus `Response`. */
    name: "publishChatAction" | "publishRendererAction";
    publish: (core: WorkerProductRuntime, item: Uint8Array) => void;
}
/** The Chat action stream, carrying a `HostChatActionSubscribeItem`. */
export declare const CHAT_ACTION_ENTRY_POINT: ActionEntryPoint;
/** The Renderer action stream, carrying a `HostRendererActionSubscribeItem`. */
export declare const RENDERER_ACTION_ENTRY_POINT: ActionEntryPoint;
/** Hand one host-authored action to the core and answer the caller. */
export declare function handlePublishAction(entryPoint: ActionEntryPoint, core: WorkerProductRuntime | undefined, postToMain: PostToMain, coreId: number, requestId: number, item: Uint8Array): void;
export {};
