import { errorMessage } from "./error.js";
function reportDispatchFailure(postToMain, label, err) {
    postToMain({
        kind: "disposeError",
        error: `${label} callback failed: ${errorMessage(err)}`,
    });
}
export function dispatchSubscriptionItem(subId, value, listeners, postToMain) {
    const listener = listeners.get(subId);
    if (!listener)
        return;
    try {
        listener.sendItem(value);
    }
    catch (err) {
        listeners.delete(subId);
        postToMain({ kind: "subscriptionStop", subId });
        reportDispatchFailure(postToMain, `subscription ${subId}`, listener.privateMedia ? new Error("media backend failure") : err);
    }
    if (listener.privateMedia) {
        postToMain({ kind: "mediaSubscriptionAck", subId });
    }
}
export function dispatchSubscriptionError(subId, error, listeners, postToMain) {
    const listener = listeners.get(subId);
    if (!listener)
        return;
    if (listener.privateMedia) {
        listeners.delete(subId);
        postToMain({ kind: "subscriptionStop", subId });
    }
    try {
        listener.sendError(error);
    }
    catch (err) {
        listeners.delete(subId);
        postToMain({ kind: "subscriptionStop", subId });
        reportDispatchFailure(postToMain, `subscription ${subId} error`, listener.privateMedia ? new Error("media backend failure") : err);
    }
}
export function dispatchChainResponse(connId, json, listeners, postToMain) {
    const listener = listeners.get(connId);
    if (!listener)
        return;
    try {
        listener(json);
    }
    catch {
        listeners.delete(connId);
        postToMain({ kind: "chainClose", connId });
        // Response-handler errors may contain private HOP data.
        postToMain({
            kind: "disposeError",
            error: `JSON-RPC connection ${connId} callback failed`,
        });
    }
}
