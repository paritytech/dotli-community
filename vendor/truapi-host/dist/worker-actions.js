// Worker half of the host-authored action entry points. Both call the core
// directly rather than going through the frame path, which carries product
// requests only.
import { errorMessage } from "./error.js";
/** The Chat action stream, carrying a `HostChatActionSubscribeItem`. */
export const CHAT_ACTION_ENTRY_POINT = {
    name: "publishChatAction",
    publish: (core, item) => core.publishChatAction(item),
};
/** The Renderer action stream, carrying a `HostRendererActionSubscribeItem`. */
export const RENDERER_ACTION_ENTRY_POINT = {
    name: "publishRendererAction",
    publish: (core, item) => core.publishRendererAction(item),
};
/** Hand one host-authored action to the core and answer the caller. */
export function handlePublishAction(entryPoint, core, postToMain, coreId, requestId, item) {
    const kind = `${entryPoint.name}Response`;
    if (!core) {
        postToMain({
            kind,
            requestId,
            ok: false,
            error: `${entryPoint.name} received for unknown core ${coreId}`,
        });
        return;
    }
    try {
        entryPoint.publish(core, item);
        postToMain({ kind, requestId, ok: true });
    }
    catch (err) {
        postToMain({ kind, requestId, ok: false, error: errorMessage(err) });
    }
}
