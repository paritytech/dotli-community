import type { WorkerToMain } from "./worker-protocol.js";
type PostToMain = (msg: WorkerToMain) => void;
export interface SubscriptionListeners {
    sendItem: (value: unknown) => void;
    sendError: (error: string) => void;
}
export declare function dispatchSubscriptionItem(subId: number, value: unknown, listeners: Map<number, SubscriptionListeners>, postToMain: PostToMain): void;
export declare function dispatchSubscriptionError(subId: number, error: string, listeners: Map<number, SubscriptionListeners>, postToMain: PostToMain): void;
export declare function dispatchChainResponse(connId: number, json: string, listeners: Map<number, (json: string) => void>, postToMain: PostToMain): void;
export {};
