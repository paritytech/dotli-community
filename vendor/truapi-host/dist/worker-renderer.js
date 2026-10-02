// Worker half of the host-initiated render subscription. It calls the core
// directly rather than going through the frame path, which carries product
// requests only.
import { errorMessage } from "./error.js";
/**
 * Open one render stream on the core and forward its items to the main thread.
 * Exactly one terminal is posted per render: the core rejects a request it
 * cannot start by throwing, and otherwise delivers the terminal asynchronously.
 */
export function handleRenderStart(core, postToMain, renders, coreId, renderId, request) {
    if (!core) {
        postToMain({
            kind: "renderError",
            renderId,
            error: `render received for unknown core ${coreId}`,
        });
        return;
    }
    try {
        const subscription = core.render(request, (node) => postToMain({ kind: "renderItem", renderId, node }), () => {
            stopRender(renders, renderId);
            postToMain({ kind: "renderComplete", renderId });
        }, (reason) => {
            stopRender(renders, renderId);
            postToMain({ kind: "renderError", renderId, error: reason });
        });
        renders.set(renderId, { coreId, subscription });
    }
    catch (err) {
        postToMain({
            kind: "renderError",
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
