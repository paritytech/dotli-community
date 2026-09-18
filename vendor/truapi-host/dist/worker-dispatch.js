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
        reportDispatchFailure(postToMain, `subscription ${subId}`, err);
    }
}
export function dispatchSubscriptionError(subId, error, listeners, postToMain) {
    const listener = listeners.get(subId);
    if (!listener)
        return;
    try {
        listener.sendError(error);
    }
    catch (err) {
        listeners.delete(subId);
        postToMain({ kind: "subscriptionStop", subId });
        reportDispatchFailure(postToMain, `subscription ${subId} error`, err);
    }
}
export function dispatchChainResponse(connId, json, listeners, postToMain) {
    const listener = listeners.get(connId);
    if (!listener)
        return;
    try {
        listener(json);
    }
    catch (err) {
        listeners.delete(connId);
        postToMain({ kind: "chainClose", connId });
        reportDispatchFailure(postToMain, `chain connection ${connId}`, err);
    }
}
