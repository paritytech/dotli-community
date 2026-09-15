// Worker half of the two host-initiated Chat entry points. Both reach the core
// directly rather than through the frame path, because neither is a product
// request: the host starts the render subscription, and the host publishes the
// action a rendered cell produced.
import { errorMessage } from "./error.js";
export function handlePublishChatAction(core, postToMain, coreId, requestId, action) {
    if (!core) {
        postToMain({
            kind: "publishChatActionResponse",
            requestId,
            ok: false,
            error: `publishChatAction received for unknown core ${coreId}`,
        });
        return;
    }
    try {
        core.publishChatAction(action);
        postToMain({ kind: "publishChatActionResponse", requestId, ok: true });
    }
    catch (err) {
        postToMain({
            kind: "publishChatActionResponse",
            requestId,
            ok: false,
            error: errorMessage(err),
        });
    }
}
export function handleRenderCustomMessageStart(core, postToMain, renders, coreId, renderId, messageId, messageType, payload) {
    if (!core) {
        postToMain({
            kind: "renderCustomMessageError",
            renderId,
            error: `renderCustomMessage received for unknown core ${coreId}`,
        });
        return;
    }
    try {
        const subscription = core.renderCustomMessage(messageId, messageType, payload, (node) => postToMain({ kind: "renderCustomMessageItem", renderId, node }), () => {
            stopRender(renders, renderId);
            postToMain({ kind: "renderCustomMessageComplete", renderId });
        }, (reason) => {
            stopRender(renders, renderId);
            postToMain({
                kind: "renderCustomMessageError",
                renderId,
                error: reason,
            });
        });
        renders.set(renderId, { coreId, subscription });
    }
    catch (err) {
        postToMain({
            kind: "renderCustomMessageError",
            renderId,
            error: errorMessage(err),
        });
    }
}
/** Cancel and release one render subscription. Idempotent. */
export function stopRender(renders, renderId) {
    const entry = renders.get(renderId);
    if (!entry)
        return;
    renders.delete(renderId);
    entry.subscription.cancel();
    entry.subscription.free();
}
/** Cancel every render belonging to one core, before that core is freed. */
export function stopRendersForCore(renders, coreId) {
    for (const [renderId, entry] of [...renders]) {
        if (entry.coreId === coreId)
            stopRender(renders, renderId);
    }
}
