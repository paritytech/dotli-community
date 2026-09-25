import { ResultAsync, type Result } from 'neverthrow';
import * as S from '../scale.js';
import type { HexString } from '../scale.js';
import { SubscriptionError } from '../transport.js';
import type { CallOptions, HostInitiatedSubscriptionHandler, ObservableLike, Observer, Subscription, TrUApiTransport } from '../transport.js';
import * as T from './types.js';
export { ResultAsync, SubscriptionError };
export type { CallOptions, HostInitiatedSubscriptionHandler, ObservableLike, Observer, Result, Subscription, TrUApiTransport };
export declare const TRUAPI_VERSION: 2;
export declare const TRUAPI_CODEC_VERSION: 3;
export declare const TRUAPI_WIRE_SCHEMA_HASH: "462dacb6e0d1f504";
/** Account lookup, aliasing, and proof generation. */
export declare class AccountClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Subscribe to account connection status changes. */
    connectionStatusSubscribe(): ObservableLike<T.HostAccountConnectionStatusSubscribeItem, S.CallErrorValue<T.VersionedHostAccountConnectionStatusSubscribeError>>;
    /** Retrieve a product-scoped account. */
    getAccount(request: T.HostAccountGetRequest, options?: CallOptions): ResultAsync<T.HostAccountGetResponse, S.CallErrorValue<T.VersionedHostAccountGetError>>;
    /** Retrieve the contextual alias for a context and ring. */
    getAccountAlias(request: T.HostAccountGetAliasRequest, options?: CallOptions): ResultAsync<T.ContextualAlias, S.CallErrorValue<T.VersionedHostAccountGetAliasError>>;
    /** Generate a ring VRF proof with an explicitly registered member key. */
    createAccountProof(request: T.HostAccountCreateProofRequest, options?: CallOptions): ResultAsync<T.HostAccountCreateProofResponse, S.CallErrorValue<T.VersionedHostAccountCreateProofError>>;
    /**
     * Produce an sr25519 (schnorrkel) VRF signature from a product account.
     *
     * The host builds a Merlin transcript from `transcriptLabel` and `items`
     * and signs it with the account's key, returning the VRF pre-output and
     * proof. Authorized like signing: local when `AutoSigning` covers the
     * account, otherwise a per-call user confirmation.
     */
    signVrf(request: T.HostAccountSignVrfRequest, options?: CallOptions): ResultAsync<T.VrfSignature, S.CallErrorValue<T.VersionedHostAccountSignVrfError>>;
    /** Register a ring-VRF key owned by the calling product. */
    registerRingVrfKey(request: T.HostAccountRegisterRingVrfKeyRequest, options?: CallOptions): ResultAsync<T.RingVrfPublicKey, S.CallErrorValue<T.VersionedHostAccountRegisterRingVrfKeyError>>;
    /** List registered ring-VRF keys owned by a product. */
    listRingVrfKeys(request: T.HostAccountListRingVrfKeysRequest, options?: CallOptions): ResultAsync<Array<T.RegisteredRingVrfKey>, S.CallErrorValue<T.VersionedHostAccountListRingVrfKeysError>>;
    /** Sign bytes directly with a registered ring-VRF member key. */
    ringVrfSign(request: T.HostAccountRingVrfSignRequest, options?: CallOptions): ResultAsync<HexString, S.CallErrorValue<T.VersionedHostAccountRingVrfSignError>>;
    /**
     * List non-product accounts the user owns.
     *
     * Current hosts do not expose non-product accounts, so the list is empty.
     */
    getLegacyAccounts(options?: CallOptions): ResultAsync<T.HostGetLegacyAccountsResponse, S.CallErrorValue<T.VersionedHostGetLegacyAccountsError>>;
    /** Fetch the user's primary identity. */
    getUserId(options?: CallOptions): ResultAsync<T.HostGetUserIdResponse, S.CallErrorValue<T.VersionedHostGetUserIdError>>;
    /**
     * Request the host to present the login flow to the user.
     *
     * Products should call this in response to a user action (e.g. tapping a
     * "Sign in" button), not automatically on load.
     */
    requestLogin(request: T.HostRequestLoginRequest, options?: CallOptions): ResultAsync<T.HostRequestLoginResponse, S.CallErrorValue<T.VersionedHostRequestLoginError>>;
}
/** Chain interaction methods. */
export declare class ChainClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Follow the chain head and receive block events. */
    followHeadSubscribe({ request }: {
        request: T.RemoteChainHeadFollowRequest;
    }): ObservableLike<T.RemoteChainHeadFollowItem, S.CallErrorValue<T.VersionedRemoteChainHeadFollowError>>;
    /** Fetch a block header. */
    getHeadHeader(request: T.RemoteChainHeadHeaderRequest, options?: CallOptions): ResultAsync<T.RemoteChainHeadHeaderResponse, S.CallErrorValue<T.VersionedRemoteChainHeadHeaderError>>;
    /** Fetch a block body. */
    getHeadBody(request: T.RemoteChainHeadBodyRequest, options?: CallOptions): ResultAsync<T.RemoteChainHeadBodyResponse, S.CallErrorValue<T.VersionedRemoteChainHeadBodyError>>;
    /** Query runtime storage at a specific block. */
    getHeadStorage(request: T.RemoteChainHeadStorageRequest, options?: CallOptions): ResultAsync<T.RemoteChainHeadStorageResponse, S.CallErrorValue<T.VersionedRemoteChainHeadStorageError>>;
    /** Invoke a runtime call at a specific block. */
    callHead(request: T.RemoteChainHeadCallRequest, options?: CallOptions): ResultAsync<T.RemoteChainHeadCallResponse, S.CallErrorValue<T.VersionedRemoteChainHeadCallError>>;
    /** Release pinned blocks. */
    unpinHead(request: T.RemoteChainHeadUnpinRequest, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedRemoteChainHeadUnpinError>>;
    /** Continue a paused chain-head operation. */
    continueHead(request: T.RemoteChainHeadContinueRequest, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedRemoteChainHeadContinueError>>;
    /** Stop a chain-head operation. */
    stopHeadOperation(request: T.RemoteChainHeadStopOperationRequest, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedRemoteChainHeadStopOperationError>>;
    /** Fetch the canonical genesis hash for a chain. */
    getSpecGenesisHash(request: T.RemoteChainSpecGenesisHashRequest, options?: CallOptions): ResultAsync<T.RemoteChainSpecGenesisHashResponse, S.CallErrorValue<T.VersionedRemoteChainSpecGenesisHashError>>;
    /** Fetch the display name of a chain. */
    getSpecChainName(request: T.RemoteChainSpecChainNameRequest, options?: CallOptions): ResultAsync<T.RemoteChainSpecChainNameResponse, S.CallErrorValue<T.VersionedRemoteChainSpecChainNameError>>;
    /** Fetch the JSON-encoded properties of a chain. */
    getSpecProperties(request: T.RemoteChainSpecPropertiesRequest, options?: CallOptions): ResultAsync<T.RemoteChainSpecPropertiesResponse, S.CallErrorValue<T.VersionedRemoteChainSpecPropertiesError>>;
    /** Broadcast a signed transaction. */
    broadcastTransaction(request: T.RemoteChainTransactionBroadcastRequest, options?: CallOptions): ResultAsync<T.RemoteChainTransactionBroadcastResponse, S.CallErrorValue<T.VersionedRemoteChainTransactionBroadcastError>>;
    /** Stop a transaction broadcast. */
    stopTransaction(request: T.RemoteChainTransactionStopRequest, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedRemoteChainTransactionStopError>>;
    /**
     * Resolve a chain identifier to its genesis hash against the host's
     * configured environment (RFC 0026).
     */
    getChainInfo(request: T.RemoteChainInfoRequest, options?: CallOptions): ResultAsync<T.RemoteChainInfoResponse, S.CallErrorValue<T.VersionedRemoteChainInfoError>>;
}
/** Chat room, bot, and message APIs. */
export declare class ChatClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Create a chat room. */
    createRoom(request: T.HostChatCreateRoomRequest, options?: CallOptions): ResultAsync<T.HostChatCreateRoomResponse, S.CallErrorValue<T.VersionedHostChatCreateRoomError>>;
    /** Register a chat bot. */
    registerBot(request: T.HostChatRegisterBotRequest, options?: CallOptions): ResultAsync<T.HostChatRegisterBotResponse, S.CallErrorValue<T.VersionedHostChatRegisterBotError>>;
    /** Subscribe to the list of chat rooms. */
    listSubscribe(): ObservableLike<T.HostChatListSubscribeItem, S.CallErrorValue<T.VersionedHostChatListSubscribeError>>;
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
    postMessage(request: T.HostChatPostMessageRequest, options?: CallOptions): ResultAsync<T.HostChatPostMessageResponse, S.CallErrorValue<T.VersionedHostChatPostMessageError>>;
    /** Subscribe to received chat actions. */
    actionSubscribe(): ObservableLike<T.HostChatActionSubscribeItem, S.CallErrorValue<T.VersionedHostChatActionSubscribeError>>;
}
/**
 * CoinPayment operations.
 *
 * RFC 0017 describes `Resolvable<T>` values for long-running operations.
 * TrUAPI represents those as subscriptions whose items are the RFC status
 * updates.
 */
export declare class CoinPaymentClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Create a new firewalled CoinPayment purse. */
    createPurse(request: T.HostCoinPaymentCreatePurseRequest, options?: CallOptions): ResultAsync<T.HostCoinPaymentCreatePurseResponse, S.CallErrorValue<T.VersionedHostCoinPaymentCreatePurseError>>;
    /** Query product-visible purse metadata and balance. */
    queryPurse(request: T.HostCoinPaymentQueryPurseRequest, options?: CallOptions): ResultAsync<T.HostCoinPaymentQueryPurseResponse, S.CallErrorValue<T.VersionedHostCoinPaymentQueryPurseError>>;
    /** Transfer balance between local purses. */
    rebalancePurse({ request }: {
        request: T.HostCoinPaymentRebalancePurseRequest;
    }): ObservableLike<T.CoinPaymentStatus, S.CallErrorValue<T.VersionedHostCoinPaymentRebalancePurseError>>;
    /** Delete a purse after draining its balance into another local purse. */
    deletePurse({ request }: {
        request: T.HostCoinPaymentDeletePurseRequest;
    }): ObservableLike<T.CoinPaymentStatus, S.CallErrorValue<T.VersionedHostCoinPaymentDeletePurseError>>;
    /** Create a receivable public key for depositing into a purse. */
    createReceivable(request: T.HostCoinPaymentCreateReceivableRequest, options?: CallOptions): ResultAsync<T.HostCoinPaymentCreateReceivableResponse, S.CallErrorValue<T.VersionedHostCoinPaymentCreateReceivableError>>;
    /** Create a cheque paying from a local purse to a receivable. */
    createCheque(request: T.HostCoinPaymentCreateChequeRequest, options?: CallOptions): ResultAsync<T.HostCoinPaymentCreateChequeResponse, S.CallErrorValue<T.VersionedHostCoinPaymentCreateChequeError>>;
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
    #private;
    constructor(transport: TrUApiTransport);
    /** Derive deterministic entropy. */
    derive(request: T.HostDeriveEntropyRequest, options?: CallOptions): ResultAsync<T.HostDeriveEntropyResponse, S.CallErrorValue<T.VersionedHostDeriveEntropyError>>;
}
/** Local key/value storage scoped to the calling product. */
export declare class LocalStorageClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Read a value by key. */
    read(request: T.HostLocalStorageReadRequest, options?: CallOptions): ResultAsync<T.HostLocalStorageReadResponse, S.CallErrorValue<T.VersionedHostLocalStorageReadError>>;
    /** Write a value to a key. */
    write(request: T.HostLocalStorageWriteRequest, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostLocalStorageWriteError>>;
    /** Clear a value by key. */
    clear(request: T.HostLocalStorageClearRequest, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostLocalStorageClearError>>;
    /**
     * Subscribe to changes of one key in the product's own storage namespace.
     *
     * Emits the current value immediately, then one item per later write or
     * clear of the key by any of the product's runtimes. A write that leaves
     * the stored bytes unchanged emits nothing.
     */
    subscribe({ request }: {
        request: T.HostLocalStorageSubscribeRequest;
    }): ObservableLike<T.HostLocalStorageChangeItem, S.CallErrorValue<T.VersionedHostLocalStorageSubscribeError>>;
}
/** Host locale subscription. */
export declare class LocaleClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Subscribe to the host's selected locale. */
    subscribe(): ObservableLike<T.HostLocaleSubscribeItem, S.CallErrorValue<T.VersionedHostLocaleSubscribeError>>;
}
/** Notification methods for locally-rendered push notifications. */
export declare class NotificationsClient {
    #private;
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
    sendPushNotification(request: T.HostPushNotificationRequest, options?: CallOptions): ResultAsync<T.HostPushNotificationResponse, S.CallErrorValue<T.VersionedHostPushNotificationError>>;
    /**
     * Cancels a previously issued push notification.
     *
     * Cancellation is idempotent: returns `Ok(())` whether the notification is
     * still pending, already fired, or was never issued. See [RFC 0019].
     *
     * [RFC 0019]: https://github.com/paritytech/host-rust-core/blob/main/docs/rfcs/0019-scheduled-notifications.md
     */
    cancelPushNotification(request: T.HostPushNotificationCancelRequest, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostPushNotificationCancelError>>;
}
/** Payment request and balance/status subscription methods. */
export declare class PaymentClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Subscribe to payment balance updates. */
    balanceSubscribe({ request }: {
        request: T.HostPaymentBalanceSubscribeRequest;
    }): ObservableLike<T.HostPaymentBalanceSubscribeItem, S.CallErrorValue<T.VersionedHostPaymentBalanceSubscribeError>>;
    /** Request a payment from the user. */
    request(request: T.HostPaymentRequest, options?: CallOptions): ResultAsync<T.HostPaymentResponse, S.CallErrorValue<T.VersionedHostPaymentError>>;
    /** Subscribe to payment lifecycle updates for a specific payment. */
    statusSubscribe({ request }: {
        request: T.HostPaymentStatusSubscribeRequest;
    }): ObservableLike<T.HostPaymentStatusSubscribeItem, S.CallErrorValue<T.VersionedHostPaymentStatusSubscribeError>>;
    /** Top up the user's payment balance. */
    topUp(request: T.HostPaymentTopUpRequest, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostPaymentTopUpError>>;
}
/** Permission request methods. */
export declare class PermissionsClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Request a device-capability permission from the user. */
    requestDevicePermission(request: T.HostDevicePermissionRequest, options?: CallOptions): ResultAsync<T.HostDevicePermissionResponse, S.CallErrorValue<T.VersionedHostDevicePermissionError>>;
    /**
     * Request a remote-operation permission.
     *
     * This example makes live requests to Frankfurter after permission is granted.
     */
    requestRemotePermission(request: T.RemotePermissionRequest, options?: CallOptions): ResultAsync<T.RemotePermissionResponse, S.CallErrorValue<T.VersionedRemotePermissionError>>;
}
/**
 * Pocket cards backed by the calling product.
 *
 * The host owns the collection: a product observes its own cards and may
 * remove them, but cannot add one.
 */
export declare class PocketClient {
    #private;
    constructor(transport: TrUApiTransport);
    /**
     * Subscribe to the calling product's cards.
     *
     * Emits the whole set on subscribe and again after every change.
     */
    listSubscribe(): ObservableLike<T.HostPocketListSubscribeItem, S.CallErrorValue<T.VersionedHostPocketListSubscribeError>>;
    /**
     * Remove one of the calling product's cards.
     *
     * Removing a card that is not present succeeds. A privileged card is
     * refused with `Privileged`.
     */
    removeCard(request: T.HostPocketRemoveCardRequest, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostPocketRemoveCardError>>;
}
/** Preimage lookup and submission methods. */
export declare class PreimageClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Subscribe to preimage lookups for a given key. */
    lookupSubscribe({ request }: {
        request: T.RemotePreimageLookupSubscribeRequest;
    }): ObservableLike<T.RemotePreimageLookupSubscribeItem, S.CallErrorValue<T.VersionedRemotePreimageLookupSubscribeError>>;
    /** Submit a preimage. Returns the preimage key (hash) on success. */
    submit(request: HexString, options?: CallOptions): ResultAsync<HexString, S.CallErrorValue<T.VersionedRemotePreimageSubmitError>>;
}
/** Product-rendered bodies and the actions triggered inside them. */
export declare class RendererClient {
    #private;
    constructor(transport: TrUApiTransport);
    /**
     * Streams renderer trees for one product-rendered body. Each item
     * replaces the previous tree. The stream stays open while the body is
     * displayed so the product can redraw in place.
     */
    onRender(handler: HostInitiatedSubscriptionHandler<T.ProductRendererRenderRequest, T.RendererNode, S.CallErrorValue<T.VersionedProductRendererRenderError>>): {
        unsubscribe(): void;
    };
    /** Subscribe to actions triggered inside this product's rendered bodies. */
    actionSubscribe(): ObservableLike<T.HostRendererActionSubscribeItem, S.CallErrorValue<T.VersionedHostRendererActionSubscribeError>>;
}
/** Resource pre-allocation (allowance management). */
export declare class ResourceAllocationClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Request the host to pre-allocate one or more resources. */
    request(request: T.HostRequestResourceAllocationRequest, options?: CallOptions): ResultAsync<T.HostRequestResourceAllocationResponse, S.CallErrorValue<T.VersionedHostRequestResourceAllocationError>>;
}
/** Signing operations. */
export declare class SigningClient {
    #private;
    constructor(transport: TrUApiTransport);
    /**
     * Construct a transaction for a product account.
     *
     * Served locally without a user confirmation when an RFC-0010 `AutoSigning`
     * grant covers the account; otherwise each call is confirmed by the user.
     *
     * Under Extrinsic V5, omitting `VerifyMultiSignature` from `extensions`
     * lets the host sign with the signer's key. Listing it — as `Disabled`,
     * with a proof in a later extension — encodes the given bytes verbatim and
     * returns an unsigned transaction.
     */
    createTransaction(request: T.ProductAccountTxPayload, options?: CallOptions): ResultAsync<T.HostCreateTransactionResponse, S.CallErrorValue<T.VersionedHostCreateTransactionError>>;
    /**
     * Construct a transaction for a non-product (legacy) account.
     *
     * The V5 `VerifyMultiSignature` rule is the same as
     * [`Signing::create_transaction`]: omit it and the host signs, list it and
     * the given bytes are used with no host signature.
     */
    createTransactionWithLegacyAccount(request: T.LegacyAccountTxPayload, options?: CallOptions): ResultAsync<T.HostCreateTransactionWithLegacyAccountResponse, S.CallErrorValue<T.VersionedHostCreateTransactionWithLegacyAccountError>>;
    /** Sign raw bytes with a non-product account. */
    signRawWithLegacyAccount(request: T.HostSignRawWithLegacyAccountRequest, options?: CallOptions): ResultAsync<T.HostSignPayloadResponse, S.CallErrorValue<T.VersionedHostSignRawWithLegacyAccountError>>;
    /** Sign an extrinsic payload with a non-product account. */
    signPayloadWithLegacyAccount(request: T.HostSignPayloadWithLegacyAccountRequest, options?: CallOptions): ResultAsync<T.HostSignPayloadResponse, S.CallErrorValue<T.VersionedHostSignPayloadWithLegacyAccountError>>;
    /**
     * Sign raw bytes or a message.
     *
     * Served locally without a user confirmation when an RFC-0010 `AutoSigning`
     * grant covers the account; otherwise each call is confirmed by the user.
     */
    signRaw(request: T.HostSignRawRequest, options?: CallOptions): ResultAsync<T.HostSignPayloadResponse, S.CallErrorValue<T.VersionedHostSignRawError>>;
    /**
     * Sign an extrinsic payload.
     *
     * Served locally without a user confirmation when an RFC-0010 `AutoSigning`
     * grant covers the account; otherwise each call is confirmed by the user.
     */
    signPayload(request: T.HostSignPayloadRequest, options?: CallOptions): ResultAsync<T.HostSignPayloadResponse, S.CallErrorValue<T.VersionedHostSignPayloadError>>;
    /**
     * Sign the supplied data without adding or removing a watermark.
     *
     * Temporary compatibility API for runtime ownership proofs, including the
     * 32-byte Resources alias used by Humanity. Payload decoding matches
     * watermarked signing, but the decoded bytes are signed exactly as supplied.
     * This permits transaction-shaped data and requires signing authorization
     * and explicit user confirmation.
     *
     * @deprecated Temporary unwatermarked signing; migrate to watermarked signing when the runtime supports it. This API will be removed. See <https://github.com/paritytech/host-rust-core/issues/612>
     */
    signRawUnwatermarkedDeprecated(request: T.HostSignRawRequest, options?: CallOptions): ResultAsync<T.HostSignPayloadResponse, S.CallErrorValue<T.VersionedHostSignRawError>>;
    /**
     * Sign the supplied data without adding or removing a watermark.
     *
     * Temporary compatibility API for runtime ownership proofs, including the
     * 32-byte Resources alias used by Humanity. Payload decoding matches
     * watermarked signing, but the decoded bytes are signed exactly as supplied.
     * This permits transaction-shaped data and requires signing authorization
     * and explicit user confirmation.
     *
     * @deprecated Temporary unwatermarked signing; migrate to watermarked signing when the runtime supports it. This API will be removed. See <https://github.com/paritytech/host-rust-core/issues/612>
     */
    signRawUnwatermarkedDeprecatedWithLegacyAccount(request: T.HostSignRawWithLegacyAccountRequest, options?: CallOptions): ResultAsync<T.HostSignPayloadResponse, S.CallErrorValue<T.VersionedHostSignRawWithLegacyAccountError>>;
}
/** Statement store methods. */
export declare class StatementStoreClient {
    #private;
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
    createProof(request: T.RemoteStatementStoreCreateProofRequest, options?: CallOptions): ResultAsync<T.RemoteStatementStoreCreateProofResponse, S.CallErrorValue<T.VersionedRemoteStatementStoreCreateProofError>>;
    /**
     * Create a proof for a statement using a pre-allocated allowance account,
     * bypassing the per-call signing prompt.
     */
    createProofAuthorized(request: T.Statement, options?: CallOptions): ResultAsync<T.RemoteStatementStoreCreateProofResponse, S.CallErrorValue<T.VersionedRemoteStatementStoreCreateProofAuthorizedError>>;
    /**
     * Submit a signed statement to the network. The request body is the
     * [`SignedStatement`](crate::v01::SignedStatement) directly (no wrapping
     * struct), matching upstream `triangle-js-sdks`.
     */
    submit(request: T.SignedStatement, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedRemoteStatementStoreSubmitError>>;
}
/**
 * General-purpose TrUAPI methods for handshake, feature detection,
 * navigation, and runtime information.
 */
export declare class SystemClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Negotiate the wire codec version with the product. */
    handshake(options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostHandshakeError>>;
    /** Query whether the host supports a specific feature. */
    featureSupported(request: T.HostFeatureSupportedRequest, options?: CallOptions): ResultAsync<T.HostFeatureSupportedResponse, S.CallErrorValue<T.VersionedHostFeatureSupportedError>>;
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
    navigateTo(request: T.HostNavigateToRequest, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostNavigateToError>>;
    /**
     * Report the host's identity and version.
     *
     * Returns the host's platform, name, and version so a product knows
     * exactly which host — and which build of it — is running it: for
     * adapting to the host, telemetry, and attributing behaviour to a
     * concrete build in diagnostics and bug reports.
     */
    info(options?: CallOptions): ResultAsync<T.HostInfo, S.CallErrorValue<T.VersionedHostInfoError>>;
    /** Return the product context bound to the current host runtime. */
    getProductContext(options?: CallOptions): ResultAsync<T.HostGetProductContextResponse, S.CallErrorValue<T.VersionedHostGetProductContextError>>;
}
/** Host theme subscription. */
export declare class ThemeClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Subscribe to host theme changes. */
    subscribe(): ObservableLike<T.HostThemeSubscribeItem, S.CallErrorValue<T.VersionedHostThemeSubscribeError>>;
}
/**
 * Worker background-operation APIs.
 *
 * The host keeps a product's worker running while it holds at least one open
 * operation, which is how a worker outlives the surface that started it.
 */
export declare class WorkerClient {
    #private;
    constructor(transport: TrUApiTransport);
    /** Begin a pending operation. */
    beginOperation(request: T.HostWorkerBeginOperationRequest, options?: CallOptions): ResultAsync<T.HostWorkerBeginOperationResponse, S.CallErrorValue<T.VersionedHostWorkerBeginOperationError>>;
    /**
     * End a pending operation. Idempotent: an unknown or already-ended id
     * succeeds, so a retry after an ambiguous failure is safe.
     */
    endOperation(request: T.HostWorkerEndOperationRequest, options?: CallOptions): ResultAsync<undefined, S.CallErrorValue<T.VersionedHostWorkerEndOperationError>>;
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
    readonly pocket: PocketClient;
    readonly preimage: PreimageClient;
    readonly renderer: RendererClient;
    readonly resourceAllocation: ResourceAllocationClient;
    readonly signing: SigningClient;
    readonly statementStore: StatementStoreClient;
    readonly system: SystemClient;
    readonly theme: ThemeClient;
    readonly worker: WorkerClient;
}
export type Client = TrUApiClient;
/** Creates the generated client facade by binding each service namespace to the
 * shared transport instance. */
export declare function createClient(transport: TrUApiTransport): TrUApiClient;
