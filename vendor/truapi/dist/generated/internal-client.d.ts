import { ResultAsync, type Result } from 'neverthrow';
import * as S from '../scale.js';
import { SubscriptionError } from '../transport.js';
import type { CallOptions, HostInitiatedSubscriptionHandler, ObservableLike, Observer, Subscription, TrUApiTransport } from '../transport.js';
import * as T from './internal.js';
export { ResultAsync, SubscriptionError };
export type { CallOptions, HostInitiatedSubscriptionHandler, ObservableLike, Observer, Result, Subscription, TrUApiTransport };
export declare const TRUAPI_VERSION: 2;
export declare const TRUAPI_CODEC_VERSION: 3;
export declare const TRUAPI_WIRE_SCHEMA_HASH: "462dacb6e0d1f504";
/** Permission request methods. */
declare class PermissionsClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Authorize one remote operation, consuming an available one-use grant. */
    authorizeRemotePermission(request: T.RemotePermissionRequest, options?: CallOptions): ResultAsync<T.RemotePermissionResponse, S.CallErrorValue<T.VersionedRemotePermissionError>>;
    /** Authorize one device operation, consuming an available one-use grant. */
    authorizeDevicePermission(request: T.HostDevicePermissionRequest, options?: CallOptions): ResultAsync<T.HostDevicePermissionResponse, S.CallErrorValue<T.VersionedHostDevicePermissionError>>;
}
export interface InternalTrUApiClient {
    readonly permissions: Readonly<PermissionsClient>;
}
/** Creates the generated client facade by binding each service namespace to the
 * shared transport instance. */
export declare function createInternalClient(transport: TrUApiTransport): InternalTrUApiClient;
