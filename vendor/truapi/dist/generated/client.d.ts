import { ResultAsync, type Result } from 'neverthrow';
import * as S from '../scale.js';
import type { HexString } from '../scale.js';
import { SubscriptionError } from '../transport.js';
import type { ObservableLike, ObservableSource, Observer, Subscription, TrUApiTransport } from '../transport.js';
import * as T from './types.js';
export { ResultAsync, SubscriptionError };
export type { ObservableLike, ObservableSource, Observer, Result, Subscription, TrUApiTransport };
export declare const TRUAPI_VERSION: 1;
export declare const TRUAPI_CODEC_VERSION: 1;
export declare const TRUAPI_WIRE_SCHEMA_HASH: "f1682972c34c8609";
/** Account lookup, aliasing, and proof generation. */
export declare class AccountClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Subscribe to account connection status changes. */
    connectionStatusSubscribe(): ObservableLike<T.HostAccountConnectionStatusSubscribeItem>;
    /** Retrieve a product-scoped account. */
    getAccount(request: T.HostAccountGetRequest): ResultAsync<T.HostAccountGetResponse, S.CallErrorValue<T.VersionedHostAccountGetError>>;
    /** Retrieve the contextual alias for a context and ring. */
    getAccountAlias(request: T.HostAccountGetAliasRequest): ResultAsync<T.ContextualAlias, S.CallErrorValue<T.VersionedHostAccountGetAliasError>>;
    /** Generate a ring VRF proof with an explicitly registered member key. */
    createAccountProof(request: T.HostAccountCreateProofRequest): ResultAsync<T.HostAccountCreateProofResponse, S.CallErrorValue<T.VersionedHostAccountCreateProofError>>;
    /**
     * Produce an sr25519 (schnorrkel) VRF signature from a product account.
     *
     * The host builds a Merlin transcript from `transcriptLabel` and `items`
     * and signs it with the account's key, returning the VRF pre-output and
     * proof. Authorized like signing: local when `AutoSigning` covers the
     * account, otherwise a per-call user confirmation.
     */
    signVrf(request: T.HostAccountSignVrfRequest): ResultAsync<T.VrfSignature, S.CallErrorValue<T.VersionedHostAccountSignVrfError>>;
    /** Register a ring-VRF key owned by the calling product. */
    registerRingVrfKey(request: T.HostAccountRegisterRingVrfKeyRequest): ResultAsync<T.RingVrfPublicKey, S.CallErrorValue<T.VersionedHostAccountRegisterRingVrfKeyError>>;
    /** List registered ring-VRF keys owned by a product. */
    listRingVrfKeys(request: T.HostAccountListRingVrfKeysRequest): ResultAsync<Array<T.RegisteredRingVrfKey>, S.CallErrorValue<T.VersionedHostAccountListRingVrfKeysError>>;
    /** Sign bytes directly with a registered ring-VRF member key. */
    ringVrfSign(request: T.HostAccountRingVrfSignRequest): ResultAsync<HexString, S.CallErrorValue<T.VersionedHostAccountRingVrfSignError>>;
    /**
     * Bind a product account as a Chat v2 device, or seal/open identity-route
     * payloads without exposing the wallet Chat identity secret.
     */
    deviceChat(request: T.HostProductDeviceChatRequest): ResultAsync<T.HostProductDeviceChatResponse, S.CallErrorValue<T.VersionedHostProductDeviceChatError>>;
    /**
     * List non-product accounts the user owns.
     *
     * Current hosts do not expose non-product accounts, so the list is empty.
     */
    getLegacyAccounts(): ResultAsync<T.HostGetLegacyAccountsResponse, S.CallErrorValue<T.VersionedHostGetLegacyAccountsError>>;
    /** Fetch the user's primary identity. */
    getUserId(): ResultAsync<T.HostGetUserIdResponse, S.CallErrorValue<T.VersionedHostGetUserIdError>>;
    /**
     * Request the host to present the login flow to the user.
     *
     * Products should call this in response to a user action (e.g. tapping a
     * "Sign in" button), not automatically on load.
     */
    requestLogin(request: T.HostRequestLoginRequest): ResultAsync<T.HostRequestLoginResponse, S.CallErrorValue<T.VersionedHostRequestLoginError>>;
}
/** Chain interaction methods. */
export declare class ChainClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Follow the chain head and receive block events. */
    followHeadSubscribe({ request }: {
        request: T.RemoteChainHeadFollowRequest;
    }): ObservableLike<T.RemoteChainHeadFollowItem>;
    /** Fetch a block header. */
    getHeadHeader(request: T.RemoteChainHeadHeaderRequest): ResultAsync<T.RemoteChainHeadHeaderResponse, S.CallErrorValue<T.VersionedRemoteChainHeadHeaderError>>;
    /** Fetch a block body. */
    getHeadBody(request: T.RemoteChainHeadBodyRequest): ResultAsync<T.RemoteChainHeadBodyResponse, S.CallErrorValue<T.VersionedRemoteChainHeadBodyError>>;
    /** Query runtime storage at a specific block. */
    getHeadStorage(request: T.RemoteChainHeadStorageRequest): ResultAsync<T.RemoteChainHeadStorageResponse, S.CallErrorValue<T.VersionedRemoteChainHeadStorageError>>;
    /** Invoke a runtime call at a specific block. */
    callHead(request: T.RemoteChainHeadCallRequest): ResultAsync<T.RemoteChainHeadCallResponse, S.CallErrorValue<T.VersionedRemoteChainHeadCallError>>;
    /** Release pinned blocks. */
    unpinHead(request: T.RemoteChainHeadUnpinRequest): ResultAsync<undefined, S.CallErrorValue<T.VersionedRemoteChainHeadUnpinError>>;
    /** Continue a paused chain-head operation. */
    continueHead(request: T.RemoteChainHeadContinueRequest): ResultAsync<undefined, S.CallErrorValue<T.VersionedRemoteChainHeadContinueError>>;
    /** Stop a chain-head operation. */
    stopHeadOperation(request: T.RemoteChainHeadStopOperationRequest): ResultAsync<undefined, S.CallErrorValue<T.VersionedRemoteChainHeadStopOperationError>>;
    /** Fetch the canonical genesis hash for a chain. */
    getSpecGenesisHash(request: T.RemoteChainSpecGenesisHashRequest): ResultAsync<T.RemoteChainSpecGenesisHashResponse, S.CallErrorValue<T.VersionedRemoteChainSpecGenesisHashError>>;
    /** Fetch the display name of a chain. */
    getSpecChainName(request: T.RemoteChainSpecChainNameRequest): ResultAsync<T.RemoteChainSpecChainNameResponse, S.CallErrorValue<T.VersionedRemoteChainSpecChainNameError>>;
    /** Fetch the JSON-encoded properties of a chain. */
    getSpecProperties(request: T.RemoteChainSpecPropertiesRequest): ResultAsync<T.RemoteChainSpecPropertiesResponse, S.CallErrorValue<T.VersionedRemoteChainSpecPropertiesError>>;
    /** Broadcast a signed transaction. */
    broadcastTransaction(request: T.RemoteChainTransactionBroadcastRequest): ResultAsync<T.RemoteChainTransactionBroadcastResponse, S.CallErrorValue<T.VersionedRemoteChainTransactionBroadcastError>>;
    /** Stop a transaction broadcast. */
    stopTransaction(request: T.RemoteChainTransactionStopRequest): ResultAsync<undefined, S.CallErrorValue<T.VersionedRemoteChainTransactionStopError>>;
    /**
     * Resolve a chain identifier to its genesis hash against the host's
     * configured environment (RFC 0026).
     */
    getChainInfo(request: T.RemoteChainInfoRequest): ResultAsync<T.RemoteChainInfoResponse, S.CallErrorValue<T.VersionedRemoteChainInfoError>>;
}
/** Chat room, bot, and message APIs. */
export declare class ChatClient {
    private readonly transport;
    private readonly customMessageRenderRegistration;
    constructor(transport: TrUApiTransport);
    /** Create a chat room. */
    createRoom(request: T.HostChatCreateRoomRequest): ResultAsync<T.HostChatCreateRoomResponse, S.CallErrorValue<T.VersionedHostChatCreateRoomError>>;
    /** Register a chat bot. */
    registerBot(request: T.HostChatRegisterBotRequest): ResultAsync<T.HostChatRegisterBotResponse, S.CallErrorValue<T.VersionedHostChatRegisterBotError>>;
    /** Subscribe to the list of chat rooms. */
    listSubscribe(): ObservableLike<T.HostChatListSubscribeItem>;
    /**
     * Post a message to a chat room.
     *
     * The host bounds and screens what it forwards. Message text is capped at
     * 16 KiB and keeps line breaks and tabs, but is rejected for other
     * control characters and for bidirectional overrides. Identifiers and
     * display names are normalized and screened. A message carries at most 32
     * actions and 32 media items, a custom payload at most 256 KiB, and a URL
     * at most 2 KiB which must be `https` or an inline raster image. A
     * rejection reports `MessageTooLarge` when the body or custom payload is
     * over budget, and `Unknown` with a reason naming the field otherwise.
     *
     * The returned `messageId` is the correlation key for any action the
     * message carries: a later `actionSubscribe` trigger names it.
     */
    postMessage(request: T.HostChatPostMessageRequest): ResultAsync<T.HostChatPostMessageResponse, S.CallErrorValue<T.VersionedHostChatPostMessageError>>;
    /** Subscribe to received chat actions. */
    actionSubscribe(): ObservableLike<T.HostChatActionSubscribeItem>;
    /** Streams renderer trees for one stored custom message. */
    onCustomMessageRender(handler: (request: T.ProductChatCustomMessageRenderRequest) => ObservableSource<T.CustomRendererNode>): {
        unsubscribe(): void;
    };
}
/**
 * CoinPayment operations.
 *
 * RFC 0017 describes `Resolvable<T>` values for long-running operations.
 * TrUAPI represents those as subscriptions whose items are the RFC status
 * updates.
 */
export declare class CoinPaymentClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Create a new firewalled CoinPayment purse. */
    createPurse(request: T.HostCoinPaymentCreatePurseRequest): ResultAsync<T.HostCoinPaymentCreatePurseResponse, S.CallErrorValue<T.VersionedHostCoinPaymentCreatePurseError>>;
    /** Query product-visible purse metadata and balance. */
    queryPurse(request: T.HostCoinPaymentQueryPurseRequest): ResultAsync<T.HostCoinPaymentQueryPurseResponse, S.CallErrorValue<T.VersionedHostCoinPaymentQueryPurseError>>;
    /** Transfer balance between local purses. */
    rebalancePurse({ request }: {
        request: T.HostCoinPaymentRebalancePurseRequest;
    }): ObservableLike<T.CoinPaymentStatus, S.CallErrorValue<T.VersionedHostCoinPaymentRebalancePurseError>>;
    /** Delete a purse after draining its balance into another local purse. */
    deletePurse({ request }: {
        request: T.HostCoinPaymentDeletePurseRequest;
    }): ObservableLike<T.CoinPaymentStatus, S.CallErrorValue<T.VersionedHostCoinPaymentDeletePurseError>>;
    /** Create a receivable public key for depositing into a purse. */
    createReceivable(request: T.HostCoinPaymentCreateReceivableRequest): ResultAsync<T.HostCoinPaymentCreateReceivableResponse, S.CallErrorValue<T.VersionedHostCoinPaymentCreateReceivableError>>;
    /** Create a cheque paying from a local purse to a receivable. */
    createCheque(request: T.HostCoinPaymentCreateChequeRequest): ResultAsync<T.HostCoinPaymentCreateChequeResponse, S.CallErrorValue<T.VersionedHostCoinPaymentCreateChequeError>>;
    /** Claim coins from a cheque into the receivable's purse. */
    deposit({ request }: {
        request: T.HostCoinPaymentDepositRequest;
    }): ObservableLike<T.CoinPaymentStatus, S.CallErrorValue<T.VersionedHostCoinPaymentDepositError>>;
    /** Attempt to return coins associated with a receivable. */
    refund({ request }: {
        request: T.HostCoinPaymentRefundRequest;
    }): ObservableLike<T.CoinPaymentStatus, S.CallErrorValue<T.VersionedHostCoinPaymentRefundError>>;
    /** Listen for a cheque delivered through a standard transmission channel. */
    listenForPayment({ request }: {
        request: T.HostCoinPaymentListenForRequest;
    }): ObservableLike<T.HostCoinPaymentListenForItem, S.CallErrorValue<T.VersionedHostCoinPaymentListenForError>>;
}
/** Deterministic entropy derivation. */
export declare class EntropyClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Derive deterministic entropy. */
    derive(request: T.HostDeriveEntropyRequest): ResultAsync<T.HostDeriveEntropyResponse, S.CallErrorValue<T.VersionedHostDeriveEntropyError>>;
}
/** Local key/value storage scoped to the calling product. */
export declare class LocalStorageClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Read a value by key. */
    read(request: T.HostLocalStorageReadRequest): ResultAsync<T.HostLocalStorageReadResponse, S.CallErrorValue<T.VersionedHostLocalStorageReadError>>;
    /** Write a value to a key. */
    write(request: T.HostLocalStorageWriteRequest): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostLocalStorageWriteError>>;
    /** Clear a value by key. */
    clear(request: T.HostLocalStorageClearRequest): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostLocalStorageClearError>>;
}
/** Host locale subscription. */
export declare class LocaleClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Subscribe to the host's selected locale. */
    subscribe(): ObservableLike<T.HostLocaleSubscribeItem>;
}
/** Notification methods for locally-rendered push notifications. */
export declare class NotificationsClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /**
     * Send a push notification to the user.
     *
     * Returns a [`NotificationId`](crate::v01::NotificationId) that can be
     * passed to [`cancel_push_notification`](Self::cancel_push_notification)
     * to retract a scheduled notification. When `scheduled_at` is set the host
     * persists the notification across restarts and fires it through the
     * platform-native scheduler. See [RFC 0019].
     *
     * [RFC 0019]: https://github.com/paritytech/host-rust-core/blob/main/docs/rfcs/0019-scheduled-notifications.md
     */
    sendPushNotification(request: T.HostPushNotificationRequest): ResultAsync<T.HostPushNotificationResponse, S.CallErrorValue<T.VersionedHostPushNotificationError>>;
    /**
     * Cancels a previously issued push notification.
     *
     * Cancellation is idempotent: returns `Ok(())` whether the notification is
     * still pending, already fired, or was never issued. See [RFC 0019].
     *
     * [RFC 0019]: https://github.com/paritytech/host-rust-core/blob/main/docs/rfcs/0019-scheduled-notifications.md
     */
    cancelPushNotification(request: T.HostPushNotificationCancelRequest): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostPushNotificationCancelError>>;
}
/** Payment request and balance/status subscription methods. */
export declare class PaymentClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Subscribe to payment balance updates. */
    balanceSubscribe({ request }: {
        request: T.HostPaymentBalanceSubscribeRequest;
    }): ObservableLike<T.HostPaymentBalanceSubscribeItem, S.CallErrorValue<T.VersionedHostPaymentBalanceSubscribeError>>;
    /** Request a payment from the user. */
    request(request: T.HostPaymentRequest): ResultAsync<T.HostPaymentResponse, S.CallErrorValue<T.VersionedHostPaymentError>>;
    /** Subscribe to payment lifecycle updates for a specific payment. */
    statusSubscribe({ request }: {
        request: T.HostPaymentStatusSubscribeRequest;
    }): ObservableLike<T.HostPaymentStatusSubscribeItem, S.CallErrorValue<T.VersionedHostPaymentStatusSubscribeError>>;
    /** Top up the user's payment balance. */
    topUp(request: T.HostPaymentTopUpRequest): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostPaymentTopUpError>>;
}
/** Permission request methods. */
export declare class PermissionsClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Request a device-capability permission from the user. */
    requestDevicePermission(request: T.HostDevicePermissionRequest): ResultAsync<T.HostDevicePermissionResponse, S.CallErrorValue<T.VersionedHostDevicePermissionError>>;
    /** Request a remote-operation permission. */
    requestRemotePermission(request: T.RemotePermissionRequest): ResultAsync<T.RemotePermissionResponse, S.CallErrorValue<T.VersionedRemotePermissionError>>;
}
/** Preimage lookup and submission methods. */
export declare class PreimageClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Subscribe to preimage lookups for a given key. */
    lookupSubscribe({ request }: {
        request: T.RemotePreimageLookupSubscribeRequest;
    }): ObservableLike<T.RemotePreimageLookupSubscribeItem>;
    /** Submit a preimage. Returns the preimage key (hash) on success. */
    submit(request: HexString): ResultAsync<HexString, S.CallErrorValue<T.VersionedRemotePreimageSubmitError>>;
}
/** Resource pre-allocation (allowance management). */
export declare class ResourceAllocationClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Request the host to pre-allocate one or more resources. */
    request(request: T.HostRequestResourceAllocationRequest): ResultAsync<T.HostRequestResourceAllocationResponse, S.CallErrorValue<T.VersionedHostRequestResourceAllocationError>>;
}
/** Signing operations. */
export declare class SigningClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /**
     * Construct a transaction for a product account.
     *
     * Under Extrinsic V5, omitting `VerifyMultiSignature` from `extensions`
     * lets the host sign with the signer's key. Listing it — as `Disabled`,
     * with a proof in a later extension — encodes the given bytes verbatim and
     * returns an unsigned transaction.
     */
    createTransaction(request: T.ProductAccountTxPayload): ResultAsync<T.HostCreateTransactionResponse, S.CallErrorValue<T.VersionedHostCreateTransactionError>>;
    /**
     * Construct a transaction for a non-product (legacy) account.
     *
     * The V5 `VerifyMultiSignature` rule is the same as
     * [`Signing::create_transaction`]: omit it and the host signs, list it and
     * the given bytes are used with no host signature.
     */
    createTransactionWithLegacyAccount(request: T.LegacyAccountTxPayload): ResultAsync<T.HostCreateTransactionWithLegacyAccountResponse, S.CallErrorValue<T.VersionedHostCreateTransactionWithLegacyAccountError>>;
    /** Sign raw bytes with a non-product account. */
    signRawWithLegacyAccount(request: T.HostSignRawWithLegacyAccountRequest): ResultAsync<T.HostSignPayloadResponse, S.CallErrorValue<T.VersionedHostSignRawWithLegacyAccountError>>;
    /** Sign an extrinsic payload with a non-product account. */
    signPayloadWithLegacyAccount(request: T.HostSignPayloadWithLegacyAccountRequest): ResultAsync<T.HostSignPayloadResponse, S.CallErrorValue<T.VersionedHostSignPayloadWithLegacyAccountError>>;
    /** Sign raw bytes or a message. */
    signRaw(request: T.HostSignRawRequest): ResultAsync<T.HostSignPayloadResponse, S.CallErrorValue<T.VersionedHostSignRawError>>;
    /** Sign an extrinsic payload. */
    signPayload(request: T.HostSignPayloadRequest): ResultAsync<T.HostSignPayloadResponse, S.CallErrorValue<T.VersionedHostSignPayloadError>>;
}
/** Statement store methods. */
export declare class StatementStoreClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Subscribe to statements matching a topic filter. */
    subscribe({ request }: {
        request: T.RemoteStatementStoreSubscribeRequest;
    }): ObservableLike<T.RemoteStatementStoreSubscribeItem, S.CallErrorValue<T.VersionedRemoteStatementStoreSubscribeError>>;
    /**
     * Create a proof for a statement.
     *
     * **Deprecated:** use [`create_proof_authorized`](Self::create_proof_authorized)
     * instead, which uses a pre-allocated allowance account and does not
     * require a per-call signing prompt. Pairing hosts may reject this method
     * when their signing channel cannot sign statement proof payloads exactly.
     */
    createProof(request: T.RemoteStatementStoreCreateProofRequest): ResultAsync<T.RemoteStatementStoreCreateProofResponse, S.CallErrorValue<T.VersionedRemoteStatementStoreCreateProofError>>;
    /**
     * Create a proof for a statement using a pre-allocated allowance account,
     * bypassing the per-call signing prompt.
     */
    createProofAuthorized(request: T.Statement): ResultAsync<T.RemoteStatementStoreCreateProofResponse, S.CallErrorValue<T.VersionedRemoteStatementStoreCreateProofAuthorizedError>>;
    /**
     * Submit a signed statement to the network. The request body is the
     * [`SignedStatement`](crate::v01::SignedStatement) directly (no wrapping
     * struct), matching upstream `triangle-js-sdks`.
     */
    submit(request: T.SignedStatement): ResultAsync<undefined, S.CallErrorValue<T.VersionedRemoteStatementStoreSubmitError>>;
}
/**
 * General-purpose TrUAPI methods for handshake, feature detection,
 * navigation, and runtime information.
 */
export declare class SystemClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Negotiate the wire codec version with the product. */
    handshake(): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostHandshakeError>>;
    /** Query whether the host supports a specific feature. */
    featureSupported(request: T.HostFeatureSupportedRequest): ResultAsync<T.HostFeatureSupportedResponse, S.CallErrorValue<T.VersionedHostFeatureSupportedError>>;
    /**
     * Request the host to open a URL.
     *
     * An `http` or `https` URL outside the ecosystem needs a
     * `RemotePermission::Remote` grant for the target host, and prompts for one
     * on first use. dotNS names, `localhost`, and the app-handoff schemes
     * (`mailto:`, `tel:`, `polkadot:`, `dot:`) consume no grant. The grant is
     * per host and shared with outbound data access to that host, so approving
     * one covers the other.
     */
    navigateTo(request: T.HostNavigateToRequest): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostNavigateToError>>;
    /**
     * Report the host's identity and version.
     *
     * Returns the host's platform, name, and version so a product knows
     * exactly which host — and which build of it — is running it: for
     * adapting to the host, telemetry, and attributing behaviour to a
     * concrete build in diagnostics and bug reports.
     */
    info(): ResultAsync<T.HostInfo, S.CallErrorValue<T.VersionedHostInfoError>>;
    /** Return the product context bound to the current host runtime. */
    getProductContext(): ResultAsync<T.HostGetProductContextResponse, S.CallErrorValue<T.VersionedHostGetProductContextError>>;
}
/** Host theme subscription. */
export declare class ThemeClient {
    private readonly transport;
    constructor(transport: TrUApiTransport);
    /** Subscribe to host theme changes. */
    subscribe(): ObservableLike<T.HostThemeSubscribeItem>;
}
export interface TrUApiClient {
    readonly account: AccountClient;
    readonly chain: ChainClient;
    readonly chat: ChatClient;
    readonly coinPayment: CoinPaymentClient;
    readonly entropy: EntropyClient;
    readonly localStorage: LocalStorageClient;
    readonly locale: LocaleClient;
    readonly notifications: NotificationsClient;
    readonly payment: PaymentClient;
    readonly permissions: PermissionsClient;
    readonly preimage: PreimageClient;
    readonly resourceAllocation: ResourceAllocationClient;
    readonly signing: SigningClient;
    readonly statementStore: StatementStoreClient;
    readonly system: SystemClient;
    readonly theme: ThemeClient;
}
export type Client = TrUApiClient;
export type GeneratedClientTransport = Omit<TrUApiTransport, "codecVersion"> & Partial<Pick<TrUApiTransport, "codecVersion">>;
/** Creates the generated client facade by binding each service namespace to the
 * shared transport instance. */
export declare function createClient(transport: GeneratedClientTransport): TrUApiClient;
