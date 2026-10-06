import { errorMessage } from "./error.js";
export async function handleGetPermissionAuthorizationStatus(runtime, postToMain, productId, requestId, request) {
    if (!runtime) {
        postToMain({
            kind: "permissionAuthorizationStatusResponse",
            requestId,
            ok: false,
            error: "permissionAuthorizationStatus received before runtime is ready",
        });
        return;
    }
    try {
        const status = await runtime.permissionAuthorizationStatus(productId, request);
        postToMain({
            kind: "permissionAuthorizationStatusResponse",
            requestId,
            ok: true,
            status,
        });
    }
    catch (err) {
        postToMain({
            kind: "permissionAuthorizationStatusResponse",
            requestId,
            ok: false,
            error: errorMessage(err),
        });
    }
}
export async function handleGetPermissionAuthorizationStatuses(runtime, postToMain, productId, requestId, requests) {
    if (!runtime) {
        postToMain({
            kind: "permissionAuthorizationStatusesResponse",
            requestId,
            ok: false,
            error: "permissionAuthorizationStatuses received before runtime is ready",
        });
        return;
    }
    try {
        const statuses = await runtime.permissionAuthorizationStatuses(productId, requests);
        postToMain({
            kind: "permissionAuthorizationStatusesResponse",
            requestId,
            ok: true,
            statuses,
        });
    }
    catch (err) {
        postToMain({
            kind: "permissionAuthorizationStatusesResponse",
            requestId,
            ok: false,
            error: errorMessage(err),
        });
    }
}
export async function handleSetPermissionAuthorizationStatus(runtime, postToMain, productId, requestId, request, status) {
    if (!runtime) {
        postToMain({
            kind: "setPermissionAuthorizationStatusResponse",
            requestId,
            ok: false,
            error: "setPermissionAuthorizationStatus received before runtime is ready",
        });
        return;
    }
    try {
        await runtime.setPermissionAuthorizationStatus(productId, request, status);
        postToMain({
            kind: "setPermissionAuthorizationStatusResponse",
            requestId,
            ok: true,
        });
    }
    catch (err) {
        postToMain({
            kind: "setPermissionAuthorizationStatusResponse",
            requestId,
            ok: false,
            error: errorMessage(err),
        });
    }
}
