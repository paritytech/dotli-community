import * as S from '../scale.js';
import type { HexString } from '../scale.js';
/** A 32-byte raw account identifier used for legacy (non-product) accounts. */
export type AccountId = HexString;
export declare const AccountId: S.Codec<AccountId>;
/** Payload when a user clicks an action button. */
export interface ActionTrigger {
    /**
     * Message containing the action, as returned by `Chat::post_message` in
     * [`HostChatPostMessageResponse::message_id`].
     */
    messageId: string;
    /** Which action was triggered. */
    actionId: string;
    /** Optional additional data. */
    payload?: HexString;
}
export declare const ActionTrigger: S.Codec<ActionTrigger>;
/**
 * A resource the host can pre-allocate on behalf of the product (RFC 0010).
 *
 * For the slot-table allowances (`StatementStoreAllowance`,
 * `BulletinAllowance`, `SmartContractAllowance`), pre-allocation is
 * opportunistic and the host may also fulfil the allowance implicitly on the
 * first submission. `AutoSigning` must be requested explicitly through this
 * call.
 */
export type AllocatableResource = 
/** Statement Store slot allowance for the product's own allowance account. */
{
    tag: "StatementStoreAllowance";
    value?: undefined;
}
/** Bulletin chain slot allowance for the product's own allowance account. */
 | {
    tag: "BulletinAllowance";
    value?: undefined;
}
/**
 * Pre-warmed PGAS balance for the product account selected by this
 * derivation index.
 */
 | {
    tag: "SmartContractAllowance";
    value: DerivationIndex;
}
/** Permission to sign on the product's behalf without per-call user prompts. */
 | {
    tag: "AutoSigning";
    value?: undefined;
}
/**
 * Current UTC-day Statement Store allowance whose target is the product
 * account selected by this derivation index.
 */
 | {
    tag: "ProductStatementStoreAllowance";
    value: DerivationIndex;
};
export declare const AllocatableResource: S.Codec<AllocatableResource>;
/** Outcome of allocating a single resource (RFC 0010). */
export type AllocationOutcome = "Allocated" | "Rejected" | "NotAvailable";
export declare const AllocationOutcome: S.Codec<AllocationOutcome>;
/** Layout arrangement (like CSS flexbox `justify-content`). */
export type Arrangement = "Start" | "End" | "Center" | "SpaceBetween" | "SpaceAround" | "SpaceEvenly";
export declare const Arrangement: S.Codec<Arrangement>;
/** Background styling. */
export interface Background {
    /** Background color. */
    color: ColorToken;
    /** Background shape. */
    shape?: Shape;
}
export declare const Background: S.Codec<Background>;
/**
 * Balance amount for payment operations. Interpreted according to the host's
 * single fixed payment asset (e.g. pUSD).
 */
export type Balance = bigint;
export declare const Balance: S.Codec<Balance>;
/** Border styling. */
export interface BorderStyle {
    /** Border width. */
    width: Size;
    /** Border color. */
    color: ColorToken;
    /** Border shape. */
    shape?: Shape;
}
export declare const BorderStyle: S.Codec<BorderStyle>;
/** Properties for a [`CustomRendererNode::Box`] container. */
export interface BoxProps {
    /** Content alignment within the box. */
    contentAlignment?: ContentAlignment;
}
export declare const BoxProps: S.Codec<BoxProps>;
/** Properties for a [`CustomRendererNode::Button`]. */
export interface ButtonProps {
    /** Button label text. */
    text: string;
    /** Button style variant. */
    variant?: ButtonVariant;
    /** Whether the button is enabled. Absent leaves the default to the host. */
    enabled: OptionalBool;
    /** Whether the button shows a loading state. Absent leaves the default to the host. */
    loading: OptionalBool;
    /** Action identifier triggered on click. */
    clickAction?: string;
}
export declare const ButtonProps: S.Codec<ButtonProps>;
/** Button style variants. */
export type ButtonVariant = "Primary" | "Secondary" | "Text";
export declare const ButtonVariant: S.Codec<ButtonVariant>;
/**
 * A 32-byte value, passed as plain bytes on FFI surfaces. Version-neutral:
 * the FFI conversion below applies to `[u8; 32]` fields in every protocol
 * version.
 */
export type Bytes32 = HexString;
export declare const Bytes32: S.Codec<Bytes32>;
/** Role of a chain within the host's configured environment. */
export type ChainIdentifier = "Relay" | "AssetHub" | "People" | "Bulletin";
export declare const ChainIdentifier: S.Codec<ChainIdentifier>;
/** A clickable action button in a chat message. */
export interface ChatAction {
    /** Action identifier. */
    actionId: string;
    /** Button label. */
    title: string;
}
export declare const ChatAction: S.Codec<ChatAction>;
/** Layout for action buttons. */
export type ChatActionLayout = "Column" | "Grid";
export declare const ChatActionLayout: S.Codec<ChatActionLayout>;
/** Payload of a received chat action. */
export type ChatActionPayload = 
/** A peer posted a message. */
{
    tag: "MessagePosted";
    value: ChatMessageContent;
}
/** A user triggered an action button. */
 | {
    tag: "ActionTriggered";
    value: ActionTrigger;
}
/** A user issued a command. */
 | {
    tag: "Command";
    value: ChatCommand;
};
export declare const ChatActionPayload: S.Codec<ChatActionPayload>;
/** A set of action buttons with optional text. */
export interface ChatActions {
    /** Optional message text. */
    text?: string;
    /** List of action buttons. */
    actions: Array<ChatAction>;
    /** `Column` or `Grid` layout. */
    layout: ChatActionLayout;
}
export declare const ChatActions: S.Codec<ChatActions>;
/** Whether the bot was newly registered or already existed. */
export type ChatBotRegistrationStatus = "New" | "Exists";
export declare const ChatBotRegistrationStatus: S.Codec<ChatBotRegistrationStatus>;
/** A slash command from a chat user. */
export interface ChatCommand {
    /** Command name. */
    command: string;
    /** Command arguments. */
    payload: string;
}
export declare const ChatCommand: S.Codec<ChatCommand>;
/** A custom message with application-defined type and binary payload. */
export interface ChatCustomMessage {
    /** Application-defined type key. */
    messageType: string;
    /** Binary payload. */
    payload: HexString;
}
export declare const ChatCustomMessage: S.Codec<ChatCustomMessage>;
/** A file attachment in a chat message. */
export interface ChatFile {
    /** File download URL. */
    url: string;
    /** File name. */
    fileName: string;
    /** MIME type. */
    mimeType: string;
    /** File size in bytes. */
    sizeBytes: bigint;
    /** Optional caption text. */
    text?: string;
}
export declare const ChatFile: S.Codec<ChatFile>;
/** A media attachment. */
export interface ChatMedia {
    /** Media URL. */
    url: string;
}
export declare const ChatMedia: S.Codec<ChatMedia>;
/** Content of a chat message -- one of several types. */
export type ChatMessageContent = 
/** Plain text message. */
{
    tag: "Text";
    value: {
        text: string;
    };
}
/** Rich text with media. */
 | {
    tag: "RichText";
    value: ChatRichText;
}
/** Action button set. */
 | {
    tag: "Actions";
    value: ChatActions;
}
/** File attachment. */
 | {
    tag: "File";
    value: ChatFile;
}
/** Emoji reaction. */
 | {
    tag: "Reaction";
    value: ChatReaction;
}
/** Reaction removal. */
 | {
    tag: "ReactionRemoved";
    value: ChatReaction;
}
/** Custom message. */
 | {
    tag: "Custom";
    value: ChatCustomMessage;
};
export declare const ChatMessageContent: S.Codec<ChatMessageContent>;
/** A reaction to a chat message. */
export interface ChatReaction {
    /** Message being reacted to. */
    messageId: string;
    /** Emoji reaction. */
    emoji: string;
}
export declare const ChatReaction: S.Codec<ChatReaction>;
/** Rich text message with optional media. */
export interface ChatRichText {
    /** Optional text content. */
    text?: string;
    /** Attached media items. */
    media: Array<ChatMedia>;
}
export declare const ChatRichText: S.Codec<ChatRichText>;
/** A chat room the product participates in. */
export interface ChatRoom {
    /** Room identifier. */
    roomId: string;
    /** `RoomHost` or `Bot`. */
    participatingAs: ChatRoomParticipation;
}
export declare const ChatRoom: S.Codec<ChatRoom>;
/** How the product participates in a chat room. */
export type ChatRoomParticipation = "RoomHost" | "Bot";
export declare const ChatRoomParticipation: S.Codec<ChatRoomParticipation>;
/** Whether the room was newly created or already existed. */
export type ChatRoomRegistrationStatus = "New" | "Exists";
export declare const ChatRoomRegistrationStatus: S.Codec<ChatRoomRegistrationStatus>;
/** Balance amount for CoinPayment operations. */
export type CoinPaymentBalance = number;
export declare const CoinPaymentBalance: S.Codec<CoinPaymentBalance>;
/** Standardized encrypted Coinage secret transmission payload. */
export interface CoinPaymentCheque {
    /** Receivable public key protecting the cheque contents. */
    id: CoinPaymentReceivable;
    /** Claimed payment amount. */
    amount: CoinPaymentBalance;
    /** Concatenated coin secrets encrypted to the receivable. */
    encryptedSecrets: HexString;
}
export declare const CoinPaymentCheque: S.Codec<CoinPaymentCheque>;
/** Product-visible clearing reference for reconciliation and receipts. */
export interface CoinPaymentClearingReference {
    /** Clearing Merkle root. */
    root: CoinPaymentMerkleRoot;
    /** Product-visible coin key and transaction hash leaves. */
    leaves: Array<[CoinPaymentCoinagePubKey, CoinPaymentTransactionHash]>;
}
export declare const CoinPaymentClearingReference: S.Codec<CoinPaymentClearingReference>;
/** Public Coinage key referenced by clearing evidence. */
export type CoinPaymentCoinagePubKey = HexString;
export declare const CoinPaymentCoinagePubKey: S.Codec<CoinPaymentCoinagePubKey>;
/** Errors returned by CoinPayment host operations. */
export type CoinPaymentError = "BalanceLow" | "Denied" | "BadCoins" | "SnipedCoins" | "PurseNotFound" | "ReceivableNotFound" | "UnsupportedChannel" | "UserAgentCapabilityUnavailable" | "Internal";
export declare const CoinPaymentError: S.Codec<CoinPaymentError>;
/** Merkle root for a product-visible clearing reference. */
export type CoinPaymentMerkleRoot = HexString;
export declare const CoinPaymentMerkleRoot: S.Codec<CoinPaymentMerkleRoot>;
/** Authenticated product identifier recorded for a product-created purse. */
export type CoinPaymentProductId = string;
export declare const CoinPaymentProductId: S.Codec<CoinPaymentProductId>;
/** RFC 0017 CoinPayment purse identifier. */
export type CoinPaymentPurseId = number;
export declare const CoinPaymentPurseId: S.Codec<CoinPaymentPurseId>;
/** Product-visible metadata and balance state for a CoinPayment purse. */
export interface CoinPaymentPurseInfo {
    /** Human-readable purse name supplied by the creating product. */
    name: string;
    /** Creation timestamp. */
    created: CoinPaymentTimestamp;
    /** Product that created the purse. */
    creator: CoinPaymentProductId;
    /** Current product-visible balance. */
    balance: CoinPaymentBalance;
}
export declare const CoinPaymentPurseInfo: S.Codec<CoinPaymentPurseInfo>;
/** Public key identifying a CoinPayment receivable. */
export type CoinPaymentReceivable = HexString;
export declare const CoinPaymentReceivable: S.Codec<CoinPaymentReceivable>;
/** Clearing status stream item. */
export type CoinPaymentStatus = 
/** More coins have cleared. */
{
    tag: "Clearing";
    value: {
        clearing: CoinPaymentBalance;
        cleared: CoinPaymentBalance;
    };
}
/** Some or all coins failed to transfer. */
 | {
    tag: "Failed";
    value: {
        error: CoinPaymentError;
        cleared: CoinPaymentBalance;
        reference: CoinPaymentClearingReference;
    };
}
/** All coins cleared. */
 | {
    tag: "Done";
    value: {
        cleared: CoinPaymentBalance;
        reference: CoinPaymentClearingReference;
    };
};
export declare const CoinPaymentStatus: S.Codec<CoinPaymentStatus>;
/** Milliseconds since Unix epoch. */
export type CoinPaymentTimestamp = bigint;
export declare const CoinPaymentTimestamp: S.Codec<CoinPaymentTimestamp>;
/** Transaction hash for a product-visible clearing reference. */
export type CoinPaymentTransactionHash = HexString;
export declare const CoinPaymentTransactionHash: S.Codec<CoinPaymentTransactionHash>;
/** Standardized cheque transmission channel. */
export type CoinPaymentTransmissionChannel = 
/** Statement-store/HOP handoff identified by an SSS topic. */
{
    tag: "Standard";
    value: {
        sssTopic: HexString;
    };
};
export declare const CoinPaymentTransmissionChannel: S.Codec<CoinPaymentTransmissionChannel>;
/** Semantic color tokens for theming. */
export type ColorToken = "FgPrimary" | "FgSecondary" | "FgTertiary" | "BgSurfaceMain" | "BgSurfaceContainer" | "BgSurfaceNested" | "FgSuccess" | "FgError" | "FgWarning";
export declare const ColorToken: S.Codec<ColorToken>;
/** Properties for a [`CustomRendererNode::Column`] layout. */
export interface ColumnProps {
    /** Horizontal alignment of children. */
    horizontalAlignment?: HorizontalAlignment;
    /** Vertical arrangement of children. */
    verticalArrangement?: Arrangement;
}
export declare const ColumnProps: S.Codec<ColumnProps>;
/** 2D content alignment. */
export type ContentAlignment = "TopStart" | "TopCenter" | "TopEnd" | "CenterStart" | "Center" | "CenterEnd" | "BottomStart" | "BottomCenter" | "BottomEnd";
export declare const ContentAlignment: S.Codec<ContentAlignment>;
/** A privacy-preserving alias derived via ring VRF, bound to a specific context. */
export interface ContextualAlias {
    /** 32-byte context identifier the alias is bound to. */
    context: HexString;
    /** Ring VRF alias (variable length). */
    alias: HexString;
}
export declare const ContextualAlias: S.Codec<ContextualAlias>;
/**
 * A node in the custom renderer UI tree. Component variants contain recursive
 * `children` fields.
 */
export type CustomRendererNode = 
/** Empty node. */
{
    tag: "Nil";
    value?: undefined;
}
/** Raw text string. */
 | {
    tag: "String";
    value: {
        text: string;
    };
}
/** Generic container. */
 | {
    tag: "Box";
    value: {
        modifiers: Array<Modifier>;
        props: BoxProps;
        children: Array<CustomRendererNode>;
    };
}
/** Vertical layout. */
 | {
    tag: "Column";
    value: {
        modifiers: Array<Modifier>;
        props: ColumnProps;
        children: Array<CustomRendererNode>;
    };
}
/** Horizontal layout. */
 | {
    tag: "Row";
    value: {
        modifiers: Array<Modifier>;
        props: RowProps;
        children: Array<CustomRendererNode>;
    };
}
/** Flexible space. */
 | {
    tag: "Spacer";
    value: {
        modifiers: Array<Modifier>;
        children: Array<CustomRendererNode>;
    };
}
/** Text display. */
 | {
    tag: "Text";
    value: {
        modifiers: Array<Modifier>;
        props: TextProps;
        children: Array<CustomRendererNode>;
    };
}
/** Interactive button. */
 | {
    tag: "Button";
    value: {
        modifiers: Array<Modifier>;
        props: ButtonProps;
        children: Array<CustomRendererNode>;
    };
}
/** Text input. */
 | {
    tag: "TextField";
    value: {
        modifiers: Array<Modifier>;
        props: TextFieldProps;
        children: Array<CustomRendererNode>;
    };
};
export declare const CustomRendererNode: S.Codec<CustomRendererNode>;
/**
 * Account selector within a product subtree. Encodes as
 * `Either<u32, [u8; 32]>` on the wire (`Index` = left, `Raw` = right).
 *
 * `Index` is the primary form — plain indices keep a product's accounts
 * enumerable. `Raw` carries a raw 32-byte derivation index for cases where
 * bytes are genuinely necessary. Hosts expand `Index(n)` to the internal
 * 32-byte index (`u32` little-endian plus the index magic).
 */
export type DerivationIndex = 
/** Plain account index. */
{
    tag: "Index";
    value: number;
}
/** Raw 32-byte derivation index. */
 | {
    tag: "Raw";
    value: HexString;
};
export declare const DerivationIndex: S.Codec<DerivationIndex>;
/**
 * CSS-like dimensions: (top, end, bottom, start).
 * Bottom defaults to top, start defaults to end when `None`.
 */
export interface Dimensions {
    /** Top dimension. */
    top: Size;
    /** End dimension. */
    end: Size;
    /** Bottom dimension. Defaults to top when absent. */
    bottom?: Size;
    /** Start dimension. Defaults to end when absent. */
    start?: Size;
}
export declare const Dimensions: S.Codec<Dimensions>;
/**
 * Generic error payload carrying a human-readable reason string. Used by many
 * methods as a catch-all error type.
 */
export interface GenericError {
    /** Human-readable failure reason. */
    reason: string;
}
export declare const GenericError: S.Codec<GenericError>;
/** A 32-byte chain genesis hash used to identify the target chain. */
export type GenesisHash = HexString;
export declare const GenesisHash: S.Codec<GenesisHash>;
/** Horizontal alignment options. */
export type HorizontalAlignment = "Start" | "Center" | "End";
export declare const HorizontalAlignment: S.Codec<HorizontalAlignment>;
/** Versioned envelope for [`HostAccountConnectionStatusSubscribeItem`]. */
export type VersionedHostAccountConnectionStatusSubscribeItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountConnectionStatusSubscribeItem;
};
export declare const VersionedHostAccountConnectionStatusSubscribeItem: S.Codec<VersionedHostAccountConnectionStatusSubscribeItem>;
/** Versioned envelope for [`HostAccountCreateProofError`]. */
export type VersionedHostAccountCreateProofError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountCreateProofError;
};
export declare const VersionedHostAccountCreateProofError: S.Codec<VersionedHostAccountCreateProofError>;
/** Versioned envelope for [`HostAccountCreateProofRequest`]. */
export type VersionedHostAccountCreateProofRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountCreateProofRequest;
};
export declare const VersionedHostAccountCreateProofRequest: S.Codec<VersionedHostAccountCreateProofRequest>;
/** Versioned envelope for [`HostAccountCreateProofResponse`]. */
export type VersionedHostAccountCreateProofResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountCreateProofResponse;
};
export declare const VersionedHostAccountCreateProofResponse: S.Codec<VersionedHostAccountCreateProofResponse>;
/** Versioned envelope for [`HostAccountGetAliasError`]. */
export type VersionedHostAccountGetAliasError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountGetAliasError;
};
export declare const VersionedHostAccountGetAliasError: S.Codec<VersionedHostAccountGetAliasError>;
/** Versioned envelope for [`HostAccountGetAliasRequest`]. */
export type VersionedHostAccountGetAliasRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountGetAliasRequest;
};
export declare const VersionedHostAccountGetAliasRequest: S.Codec<VersionedHostAccountGetAliasRequest>;
/** Versioned envelope for [`HostAccountGetAliasResponse`]. */
export type VersionedHostAccountGetAliasResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: ContextualAlias;
};
export declare const VersionedHostAccountGetAliasResponse: S.Codec<VersionedHostAccountGetAliasResponse>;
/** Versioned envelope for [`HostAccountGetError`]. */
export type VersionedHostAccountGetError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountGetError;
};
export declare const VersionedHostAccountGetError: S.Codec<VersionedHostAccountGetError>;
/** Versioned envelope for [`HostAccountGetRequest`]. */
export type VersionedHostAccountGetRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountGetRequest;
};
export declare const VersionedHostAccountGetRequest: S.Codec<VersionedHostAccountGetRequest>;
/** Versioned envelope for [`HostAccountGetResponse`]. */
export type VersionedHostAccountGetResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountGetResponse;
};
export declare const VersionedHostAccountGetResponse: S.Codec<VersionedHostAccountGetResponse>;
/** Versioned envelope for [`HostAccountListRingVrfKeysError`]. */
export type VersionedHostAccountListRingVrfKeysError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountListRingVrfKeysError;
};
export declare const VersionedHostAccountListRingVrfKeysError: S.Codec<VersionedHostAccountListRingVrfKeysError>;
/** Versioned envelope for [`HostAccountListRingVrfKeysRequest`]. */
export type VersionedHostAccountListRingVrfKeysRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountListRingVrfKeysRequest;
};
export declare const VersionedHostAccountListRingVrfKeysRequest: S.Codec<VersionedHostAccountListRingVrfKeysRequest>;
/** Versioned envelope for [`HostAccountListRingVrfKeysResponse`]. */
export type VersionedHostAccountListRingVrfKeysResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: Array<RegisteredRingVrfKey>;
};
export declare const VersionedHostAccountListRingVrfKeysResponse: S.Codec<VersionedHostAccountListRingVrfKeysResponse>;
/** Versioned envelope for [`HostAccountRegisterRingVrfKeyError`]. */
export type VersionedHostAccountRegisterRingVrfKeyError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountRegisterRingVrfKeyError;
};
export declare const VersionedHostAccountRegisterRingVrfKeyError: S.Codec<VersionedHostAccountRegisterRingVrfKeyError>;
/** Versioned envelope for [`HostAccountRegisterRingVrfKeyRequest`]. */
export type VersionedHostAccountRegisterRingVrfKeyRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountRegisterRingVrfKeyRequest;
};
export declare const VersionedHostAccountRegisterRingVrfKeyRequest: S.Codec<VersionedHostAccountRegisterRingVrfKeyRequest>;
/** Versioned envelope for [`HostAccountRegisterRingVrfKeyResponse`]. */
export type VersionedHostAccountRegisterRingVrfKeyResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RingVrfPublicKey;
};
export declare const VersionedHostAccountRegisterRingVrfKeyResponse: S.Codec<VersionedHostAccountRegisterRingVrfKeyResponse>;
/** Versioned envelope for [`HostAccountRingVrfSignError`]. */
export type VersionedHostAccountRingVrfSignError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountRingVrfSignError;
};
export declare const VersionedHostAccountRingVrfSignError: S.Codec<VersionedHostAccountRingVrfSignError>;
/** Versioned envelope for [`HostAccountRingVrfSignRequest`]. */
export type VersionedHostAccountRingVrfSignRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountRingVrfSignRequest;
};
export declare const VersionedHostAccountRingVrfSignRequest: S.Codec<VersionedHostAccountRingVrfSignRequest>;
/** Versioned envelope for [`HostAccountRingVrfSignResponse`]. */
export type VersionedHostAccountRingVrfSignResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HexString;
};
export declare const VersionedHostAccountRingVrfSignResponse: S.Codec<VersionedHostAccountRingVrfSignResponse>;
/** Versioned envelope for [`HostAccountSignVrfError`]. */
export type VersionedHostAccountSignVrfError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountSignVrfError;
};
export declare const VersionedHostAccountSignVrfError: S.Codec<VersionedHostAccountSignVrfError>;
/** Versioned envelope for [`HostAccountSignVrfRequest`]. */
export type VersionedHostAccountSignVrfRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountSignVrfRequest;
};
export declare const VersionedHostAccountSignVrfRequest: S.Codec<VersionedHostAccountSignVrfRequest>;
/** Versioned envelope for [`HostAccountSignVrfResponse`]. */
export type VersionedHostAccountSignVrfResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: VrfSignature;
};
export declare const VersionedHostAccountSignVrfResponse: S.Codec<VersionedHostAccountSignVrfResponse>;
/** Versioned envelope for [`HostChatActionSubscribeItem`]. */
export type VersionedHostChatActionSubscribeItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostChatActionSubscribeItem;
};
export declare const VersionedHostChatActionSubscribeItem: S.Codec<VersionedHostChatActionSubscribeItem>;
/** Versioned envelope for [`HostChatCreateRoomError`]. */
export type VersionedHostChatCreateRoomError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostChatCreateRoomError;
};
export declare const VersionedHostChatCreateRoomError: S.Codec<VersionedHostChatCreateRoomError>;
/** Versioned envelope for [`HostChatCreateRoomRequest`]. */
export type VersionedHostChatCreateRoomRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostChatCreateRoomRequest;
};
export declare const VersionedHostChatCreateRoomRequest: S.Codec<VersionedHostChatCreateRoomRequest>;
/** Versioned envelope for [`HostChatCreateRoomResponse`]. */
export type VersionedHostChatCreateRoomResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostChatCreateRoomResponse;
};
export declare const VersionedHostChatCreateRoomResponse: S.Codec<VersionedHostChatCreateRoomResponse>;
/** Versioned envelope for [`HostChatListSubscribeItem`]. */
export type VersionedHostChatListSubscribeItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostChatListSubscribeItem;
};
export declare const VersionedHostChatListSubscribeItem: S.Codec<VersionedHostChatListSubscribeItem>;
/** Versioned envelope for [`HostChatPostMessageError`]. */
export type VersionedHostChatPostMessageError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostChatPostMessageError;
};
export declare const VersionedHostChatPostMessageError: S.Codec<VersionedHostChatPostMessageError>;
/** Versioned envelope for [`HostChatPostMessageRequest`]. */
export type VersionedHostChatPostMessageRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostChatPostMessageRequest;
};
export declare const VersionedHostChatPostMessageRequest: S.Codec<VersionedHostChatPostMessageRequest>;
/** Versioned envelope for [`HostChatPostMessageResponse`]. */
export type VersionedHostChatPostMessageResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostChatPostMessageResponse;
};
export declare const VersionedHostChatPostMessageResponse: S.Codec<VersionedHostChatPostMessageResponse>;
/** Versioned envelope for [`HostChatRegisterBotError`]. */
export type VersionedHostChatRegisterBotError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostChatRegisterBotError;
};
export declare const VersionedHostChatRegisterBotError: S.Codec<VersionedHostChatRegisterBotError>;
/** Versioned envelope for [`HostChatRegisterBotRequest`]. */
export type VersionedHostChatRegisterBotRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostChatRegisterBotRequest;
};
export declare const VersionedHostChatRegisterBotRequest: S.Codec<VersionedHostChatRegisterBotRequest>;
/** Versioned envelope for [`HostChatRegisterBotResponse`]. */
export type VersionedHostChatRegisterBotResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostChatRegisterBotResponse;
};
export declare const VersionedHostChatRegisterBotResponse: S.Codec<VersionedHostChatRegisterBotResponse>;
/** Versioned envelope for [`HostCoinPaymentCreateChequeError`]. */
export type VersionedHostCoinPaymentCreateChequeError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentError;
};
export declare const VersionedHostCoinPaymentCreateChequeError: S.Codec<VersionedHostCoinPaymentCreateChequeError>;
/** Versioned envelope for [`HostCoinPaymentCreateChequeRequest`]. */
export type VersionedHostCoinPaymentCreateChequeRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentCreateChequeRequest;
};
export declare const VersionedHostCoinPaymentCreateChequeRequest: S.Codec<VersionedHostCoinPaymentCreateChequeRequest>;
/** Versioned envelope for [`HostCoinPaymentCreateChequeResponse`]. */
export type VersionedHostCoinPaymentCreateChequeResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentCreateChequeResponse;
};
export declare const VersionedHostCoinPaymentCreateChequeResponse: S.Codec<VersionedHostCoinPaymentCreateChequeResponse>;
/** Versioned envelope for [`HostCoinPaymentCreatePurseError`]. */
export type VersionedHostCoinPaymentCreatePurseError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentError;
};
export declare const VersionedHostCoinPaymentCreatePurseError: S.Codec<VersionedHostCoinPaymentCreatePurseError>;
/** Versioned envelope for [`HostCoinPaymentCreatePurseRequest`]. */
export type VersionedHostCoinPaymentCreatePurseRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentCreatePurseRequest;
};
export declare const VersionedHostCoinPaymentCreatePurseRequest: S.Codec<VersionedHostCoinPaymentCreatePurseRequest>;
/** Versioned envelope for [`HostCoinPaymentCreatePurseResponse`]. */
export type VersionedHostCoinPaymentCreatePurseResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentCreatePurseResponse;
};
export declare const VersionedHostCoinPaymentCreatePurseResponse: S.Codec<VersionedHostCoinPaymentCreatePurseResponse>;
/** Versioned envelope for [`HostCoinPaymentCreateReceivableError`]. */
export type VersionedHostCoinPaymentCreateReceivableError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentError;
};
export declare const VersionedHostCoinPaymentCreateReceivableError: S.Codec<VersionedHostCoinPaymentCreateReceivableError>;
/** Versioned envelope for [`HostCoinPaymentCreateReceivableRequest`]. */
export type VersionedHostCoinPaymentCreateReceivableRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentCreateReceivableRequest;
};
export declare const VersionedHostCoinPaymentCreateReceivableRequest: S.Codec<VersionedHostCoinPaymentCreateReceivableRequest>;
/** Versioned envelope for [`HostCoinPaymentCreateReceivableResponse`]. */
export type VersionedHostCoinPaymentCreateReceivableResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentCreateReceivableResponse;
};
export declare const VersionedHostCoinPaymentCreateReceivableResponse: S.Codec<VersionedHostCoinPaymentCreateReceivableResponse>;
/** Versioned envelope for [`HostCoinPaymentDeletePurseError`]. */
export type VersionedHostCoinPaymentDeletePurseError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentError;
};
export declare const VersionedHostCoinPaymentDeletePurseError: S.Codec<VersionedHostCoinPaymentDeletePurseError>;
/** Versioned envelope for [`HostCoinPaymentDeletePurseItem`]. */
export type VersionedHostCoinPaymentDeletePurseItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentStatus;
};
export declare const VersionedHostCoinPaymentDeletePurseItem: S.Codec<VersionedHostCoinPaymentDeletePurseItem>;
/** Versioned envelope for [`HostCoinPaymentDeletePurseRequest`]. */
export type VersionedHostCoinPaymentDeletePurseRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentDeletePurseRequest;
};
export declare const VersionedHostCoinPaymentDeletePurseRequest: S.Codec<VersionedHostCoinPaymentDeletePurseRequest>;
/** Versioned envelope for [`HostCoinPaymentDepositError`]. */
export type VersionedHostCoinPaymentDepositError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentError;
};
export declare const VersionedHostCoinPaymentDepositError: S.Codec<VersionedHostCoinPaymentDepositError>;
/** Versioned envelope for [`HostCoinPaymentDepositItem`]. */
export type VersionedHostCoinPaymentDepositItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentStatus;
};
export declare const VersionedHostCoinPaymentDepositItem: S.Codec<VersionedHostCoinPaymentDepositItem>;
/** Versioned envelope for [`HostCoinPaymentDepositRequest`]. */
export type VersionedHostCoinPaymentDepositRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentDepositRequest;
};
export declare const VersionedHostCoinPaymentDepositRequest: S.Codec<VersionedHostCoinPaymentDepositRequest>;
/** Versioned envelope for [`HostCoinPaymentListenForError`]. */
export type VersionedHostCoinPaymentListenForError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentError;
};
export declare const VersionedHostCoinPaymentListenForError: S.Codec<VersionedHostCoinPaymentListenForError>;
/** Versioned envelope for [`HostCoinPaymentListenForItem`]. */
export type VersionedHostCoinPaymentListenForItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentListenForItem;
};
export declare const VersionedHostCoinPaymentListenForItem: S.Codec<VersionedHostCoinPaymentListenForItem>;
/** Versioned envelope for [`HostCoinPaymentListenForRequest`]. */
export type VersionedHostCoinPaymentListenForRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentListenForRequest;
};
export declare const VersionedHostCoinPaymentListenForRequest: S.Codec<VersionedHostCoinPaymentListenForRequest>;
/** Versioned envelope for [`HostCoinPaymentQueryPurseError`]. */
export type VersionedHostCoinPaymentQueryPurseError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentError;
};
export declare const VersionedHostCoinPaymentQueryPurseError: S.Codec<VersionedHostCoinPaymentQueryPurseError>;
/** Versioned envelope for [`HostCoinPaymentQueryPurseRequest`]. */
export type VersionedHostCoinPaymentQueryPurseRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentQueryPurseRequest;
};
export declare const VersionedHostCoinPaymentQueryPurseRequest: S.Codec<VersionedHostCoinPaymentQueryPurseRequest>;
/** Versioned envelope for [`HostCoinPaymentQueryPurseResponse`]. */
export type VersionedHostCoinPaymentQueryPurseResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentQueryPurseResponse;
};
export declare const VersionedHostCoinPaymentQueryPurseResponse: S.Codec<VersionedHostCoinPaymentQueryPurseResponse>;
/** Versioned envelope for [`HostCoinPaymentRebalancePurseError`]. */
export type VersionedHostCoinPaymentRebalancePurseError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentError;
};
export declare const VersionedHostCoinPaymentRebalancePurseError: S.Codec<VersionedHostCoinPaymentRebalancePurseError>;
/** Versioned envelope for [`HostCoinPaymentRebalancePurseItem`]. */
export type VersionedHostCoinPaymentRebalancePurseItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentStatus;
};
export declare const VersionedHostCoinPaymentRebalancePurseItem: S.Codec<VersionedHostCoinPaymentRebalancePurseItem>;
/** Versioned envelope for [`HostCoinPaymentRebalancePurseRequest`]. */
export type VersionedHostCoinPaymentRebalancePurseRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentRebalancePurseRequest;
};
export declare const VersionedHostCoinPaymentRebalancePurseRequest: S.Codec<VersionedHostCoinPaymentRebalancePurseRequest>;
/** Versioned envelope for [`HostCoinPaymentRefundError`]. */
export type VersionedHostCoinPaymentRefundError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentError;
};
export declare const VersionedHostCoinPaymentRefundError: S.Codec<VersionedHostCoinPaymentRefundError>;
/** Versioned envelope for [`HostCoinPaymentRefundItem`]. */
export type VersionedHostCoinPaymentRefundItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CoinPaymentStatus;
};
export declare const VersionedHostCoinPaymentRefundItem: S.Codec<VersionedHostCoinPaymentRefundItem>;
/** Versioned envelope for [`HostCoinPaymentRefundRequest`]. */
export type VersionedHostCoinPaymentRefundRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCoinPaymentRefundRequest;
};
export declare const VersionedHostCoinPaymentRefundRequest: S.Codec<VersionedHostCoinPaymentRefundRequest>;
/** Versioned envelope for [`HostCreateTransactionError`]. */
export type VersionedHostCreateTransactionError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCreateTransactionError;
};
export declare const VersionedHostCreateTransactionError: S.Codec<VersionedHostCreateTransactionError>;
/** Versioned envelope for [`HostCreateTransactionRequest`]. */
export type VersionedHostCreateTransactionRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: ProductAccountTxPayload;
};
export declare const VersionedHostCreateTransactionRequest: S.Codec<VersionedHostCreateTransactionRequest>;
/** Versioned envelope for [`HostCreateTransactionResponse`]. */
export type VersionedHostCreateTransactionResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCreateTransactionResponse;
};
export declare const VersionedHostCreateTransactionResponse: S.Codec<VersionedHostCreateTransactionResponse>;
/** Versioned envelope for [`HostCreateTransactionWithLegacyAccountError`]. */
export type VersionedHostCreateTransactionWithLegacyAccountError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCreateTransactionError;
};
export declare const VersionedHostCreateTransactionWithLegacyAccountError: S.Codec<VersionedHostCreateTransactionWithLegacyAccountError>;
/** Versioned envelope for [`HostCreateTransactionWithLegacyAccountRequest`]. */
export type VersionedHostCreateTransactionWithLegacyAccountRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: LegacyAccountTxPayload;
};
export declare const VersionedHostCreateTransactionWithLegacyAccountRequest: S.Codec<VersionedHostCreateTransactionWithLegacyAccountRequest>;
/** Versioned envelope for [`HostCreateTransactionWithLegacyAccountResponse`]. */
export type VersionedHostCreateTransactionWithLegacyAccountResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostCreateTransactionWithLegacyAccountResponse;
};
export declare const VersionedHostCreateTransactionWithLegacyAccountResponse: S.Codec<VersionedHostCreateTransactionWithLegacyAccountResponse>;
/** Versioned envelope for [`HostDeriveEntropyError`]. */
export type VersionedHostDeriveEntropyError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostDeriveEntropyError;
};
export declare const VersionedHostDeriveEntropyError: S.Codec<VersionedHostDeriveEntropyError>;
/** Versioned envelope for [`HostDeriveEntropyRequest`]. */
export type VersionedHostDeriveEntropyRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostDeriveEntropyRequest;
};
export declare const VersionedHostDeriveEntropyRequest: S.Codec<VersionedHostDeriveEntropyRequest>;
/** Versioned envelope for [`HostDeriveEntropyResponse`]. */
export type VersionedHostDeriveEntropyResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostDeriveEntropyResponse;
};
export declare const VersionedHostDeriveEntropyResponse: S.Codec<VersionedHostDeriveEntropyResponse>;
/** Versioned envelope for [`HostDevicePermissionError`]. */
export type VersionedHostDevicePermissionError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedHostDevicePermissionError: S.Codec<VersionedHostDevicePermissionError>;
/** Versioned envelope for [`HostDevicePermissionRequest`]. */
export type VersionedHostDevicePermissionRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostDevicePermissionRequest;
};
export declare const VersionedHostDevicePermissionRequest: S.Codec<VersionedHostDevicePermissionRequest>;
/** Versioned envelope for [`HostDevicePermissionResponse`]. */
export type VersionedHostDevicePermissionResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostDevicePermissionResponse;
};
export declare const VersionedHostDevicePermissionResponse: S.Codec<VersionedHostDevicePermissionResponse>;
/** Versioned envelope for [`HostFeatureSupportedError`]. */
export type VersionedHostFeatureSupportedError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedHostFeatureSupportedError: S.Codec<VersionedHostFeatureSupportedError>;
/** Versioned envelope for [`HostFeatureSupportedRequest`]. */
export type VersionedHostFeatureSupportedRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostFeatureSupportedRequest;
};
export declare const VersionedHostFeatureSupportedRequest: S.Codec<VersionedHostFeatureSupportedRequest>;
/** Versioned envelope for [`HostFeatureSupportedResponse`]. */
export type VersionedHostFeatureSupportedResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostFeatureSupportedResponse;
};
export declare const VersionedHostFeatureSupportedResponse: S.Codec<VersionedHostFeatureSupportedResponse>;
/** Versioned envelope for [`HostGetLegacyAccountsError`]. */
export type VersionedHostGetLegacyAccountsError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostAccountGetError;
};
export declare const VersionedHostGetLegacyAccountsError: S.Codec<VersionedHostGetLegacyAccountsError>;
/** Versioned envelope for [`HostGetLegacyAccountsRequest`]. */
export type VersionedHostGetLegacyAccountsRequest = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedHostGetLegacyAccountsRequest: S.Codec<VersionedHostGetLegacyAccountsRequest>;
/** Versioned envelope for [`HostGetLegacyAccountsResponse`]. */
export type VersionedHostGetLegacyAccountsResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostGetLegacyAccountsResponse;
};
export declare const VersionedHostGetLegacyAccountsResponse: S.Codec<VersionedHostGetLegacyAccountsResponse>;
/** Versioned envelope for [`HostGetProductContextError`]. */
export type VersionedHostGetProductContextError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedHostGetProductContextError: S.Codec<VersionedHostGetProductContextError>;
/** Versioned envelope for [`HostGetProductContextRequest`]. */
export type VersionedHostGetProductContextRequest = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedHostGetProductContextRequest: S.Codec<VersionedHostGetProductContextRequest>;
/** Versioned envelope for [`HostGetProductContextResponse`]. */
export type VersionedHostGetProductContextResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostGetProductContextResponse;
};
export declare const VersionedHostGetProductContextResponse: S.Codec<VersionedHostGetProductContextResponse>;
/** Versioned envelope for [`HostGetUserIdError`]. */
export type VersionedHostGetUserIdError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostGetUserIdError;
};
export declare const VersionedHostGetUserIdError: S.Codec<VersionedHostGetUserIdError>;
/** Versioned envelope for [`HostGetUserIdRequest`]. */
export type VersionedHostGetUserIdRequest = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedHostGetUserIdRequest: S.Codec<VersionedHostGetUserIdRequest>;
/** Versioned envelope for [`HostGetUserIdResponse`]. */
export type VersionedHostGetUserIdResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostGetUserIdResponse;
};
export declare const VersionedHostGetUserIdResponse: S.Codec<VersionedHostGetUserIdResponse>;
/** Versioned envelope for [`HostHandshakeError`]. */
export type VersionedHostHandshakeError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostHandshakeError;
};
export declare const VersionedHostHandshakeError: S.Codec<VersionedHostHandshakeError>;
/** Versioned envelope for [`HostHandshakeRequest`]. */
export type VersionedHostHandshakeRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostHandshakeRequest;
};
export declare const VersionedHostHandshakeRequest: S.Codec<VersionedHostHandshakeRequest>;
/** Versioned envelope for [`HostHandshakeResponse`]. */
export type VersionedHostHandshakeResponse = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedHostHandshakeResponse: S.Codec<VersionedHostHandshakeResponse>;
/**
 * Identity and version of the host currently running the product.
 *
 * Reported by [`crate::api::System::host_info`] so a product knows which host
 * (and which build of it) is running it — for adapting to the host,
 * telemetry, and attributing behaviour to a concrete build in diagnostics and
 * bug reports.
 */
export interface HostInfo {
    /** Platform category the host runs on. */
    platform: HostPlatform;
    /**
     * Human-readable name of the host implementation, e.g. `"Polkadot
     * Desktop"`, `"Polkadot Mobile"`, or `"dotli"`. Hosts should report a
     * stable, non-empty name.
     */
    name: string;
    /**
     * Host-native version string, e.g. a semver such as `"1.2.3"`. Hosts
     * should report a non-empty value; the format is the host's own.
     */
    version: string;
}
export declare const HostInfo: S.Codec<HostInfo>;
/** Versioned envelope for [`HostInfoError`]. */
export type VersionedHostInfoError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedHostInfoError: S.Codec<VersionedHostInfoError>;
/** Versioned envelope for [`HostInfoRequest`]. */
export type VersionedHostInfoRequest = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedHostInfoRequest: S.Codec<VersionedHostInfoRequest>;
/** Versioned envelope for [`HostInfoResponse`]. */
export type VersionedHostInfoResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostInfo;
};
export declare const VersionedHostInfoResponse: S.Codec<VersionedHostInfoResponse>;
/** Versioned envelope for [`HostLocalStorageClearError`]. */
export type VersionedHostLocalStorageClearError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostLocalStorageReadError;
};
export declare const VersionedHostLocalStorageClearError: S.Codec<VersionedHostLocalStorageClearError>;
/** Versioned envelope for [`HostLocalStorageClearRequest`]. */
export type VersionedHostLocalStorageClearRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostLocalStorageClearRequest;
};
export declare const VersionedHostLocalStorageClearRequest: S.Codec<VersionedHostLocalStorageClearRequest>;
/** Versioned envelope for [`HostLocalStorageClearResponse`]. */
export type VersionedHostLocalStorageClearResponse = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedHostLocalStorageClearResponse: S.Codec<VersionedHostLocalStorageClearResponse>;
/** Versioned envelope for [`HostLocalStorageReadError`]. */
export type VersionedHostLocalStorageReadError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostLocalStorageReadError;
};
export declare const VersionedHostLocalStorageReadError: S.Codec<VersionedHostLocalStorageReadError>;
/** Versioned envelope for [`HostLocalStorageReadRequest`]. */
export type VersionedHostLocalStorageReadRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostLocalStorageReadRequest;
};
export declare const VersionedHostLocalStorageReadRequest: S.Codec<VersionedHostLocalStorageReadRequest>;
/** Versioned envelope for [`HostLocalStorageReadResponse`]. */
export type VersionedHostLocalStorageReadResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostLocalStorageReadResponse;
};
export declare const VersionedHostLocalStorageReadResponse: S.Codec<VersionedHostLocalStorageReadResponse>;
/** Versioned envelope for [`HostLocalStorageWriteError`]. */
export type VersionedHostLocalStorageWriteError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostLocalStorageReadError;
};
export declare const VersionedHostLocalStorageWriteError: S.Codec<VersionedHostLocalStorageWriteError>;
/** Versioned envelope for [`HostLocalStorageWriteRequest`]. */
export type VersionedHostLocalStorageWriteRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostLocalStorageWriteRequest;
};
export declare const VersionedHostLocalStorageWriteRequest: S.Codec<VersionedHostLocalStorageWriteRequest>;
/** Versioned envelope for [`HostLocalStorageWriteResponse`]. */
export type VersionedHostLocalStorageWriteResponse = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedHostLocalStorageWriteResponse: S.Codec<VersionedHostLocalStorageWriteResponse>;
/** Versioned envelope for [`HostLocaleSubscribeItem`]. */
export type VersionedHostLocaleSubscribeItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostLocaleSubscribeItem;
};
export declare const VersionedHostLocaleSubscribeItem: S.Codec<VersionedHostLocaleSubscribeItem>;
/** Versioned envelope for [`HostNavigateToError`]. */
export type VersionedHostNavigateToError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostNavigateToError;
};
export declare const VersionedHostNavigateToError: S.Codec<VersionedHostNavigateToError>;
/** Versioned envelope for [`HostNavigateToRequest`]. */
export type VersionedHostNavigateToRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostNavigateToRequest;
};
export declare const VersionedHostNavigateToRequest: S.Codec<VersionedHostNavigateToRequest>;
/** Versioned envelope for [`HostNavigateToResponse`]. */
export type VersionedHostNavigateToResponse = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedHostNavigateToResponse: S.Codec<VersionedHostNavigateToResponse>;
/** Versioned envelope for [`HostPaymentBalanceSubscribeError`]. */
export type VersionedHostPaymentBalanceSubscribeError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPaymentBalanceSubscribeError;
};
export declare const VersionedHostPaymentBalanceSubscribeError: S.Codec<VersionedHostPaymentBalanceSubscribeError>;
/** Versioned envelope for [`HostPaymentBalanceSubscribeItem`]. */
export type VersionedHostPaymentBalanceSubscribeItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPaymentBalanceSubscribeItem;
};
export declare const VersionedHostPaymentBalanceSubscribeItem: S.Codec<VersionedHostPaymentBalanceSubscribeItem>;
/** Versioned envelope for [`HostPaymentBalanceSubscribeRequest`]. */
export type VersionedHostPaymentBalanceSubscribeRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPaymentBalanceSubscribeRequest;
};
export declare const VersionedHostPaymentBalanceSubscribeRequest: S.Codec<VersionedHostPaymentBalanceSubscribeRequest>;
/** Versioned envelope for [`HostPaymentError`]. */
export type VersionedHostPaymentError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPaymentError;
};
export declare const VersionedHostPaymentError: S.Codec<VersionedHostPaymentError>;
/** Versioned envelope for [`HostPaymentRequest`]. */
export type VersionedHostPaymentRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPaymentRequest;
};
export declare const VersionedHostPaymentRequest: S.Codec<VersionedHostPaymentRequest>;
/** Versioned envelope for [`HostPaymentResponse`]. */
export type VersionedHostPaymentResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPaymentResponse;
};
export declare const VersionedHostPaymentResponse: S.Codec<VersionedHostPaymentResponse>;
/** Versioned envelope for [`HostPaymentStatusSubscribeError`]. */
export type VersionedHostPaymentStatusSubscribeError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPaymentStatusSubscribeError;
};
export declare const VersionedHostPaymentStatusSubscribeError: S.Codec<VersionedHostPaymentStatusSubscribeError>;
/** Versioned envelope for [`HostPaymentStatusSubscribeItem`]. */
export type VersionedHostPaymentStatusSubscribeItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPaymentStatusSubscribeItem;
};
export declare const VersionedHostPaymentStatusSubscribeItem: S.Codec<VersionedHostPaymentStatusSubscribeItem>;
/** Versioned envelope for [`HostPaymentStatusSubscribeRequest`]. */
export type VersionedHostPaymentStatusSubscribeRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPaymentStatusSubscribeRequest;
};
export declare const VersionedHostPaymentStatusSubscribeRequest: S.Codec<VersionedHostPaymentStatusSubscribeRequest>;
/** Versioned envelope for [`HostPaymentTopUpError`]. */
export type VersionedHostPaymentTopUpError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPaymentTopUpError;
};
export declare const VersionedHostPaymentTopUpError: S.Codec<VersionedHostPaymentTopUpError>;
/** Versioned envelope for [`HostPaymentTopUpRequest`]. */
export type VersionedHostPaymentTopUpRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPaymentTopUpRequest;
};
export declare const VersionedHostPaymentTopUpRequest: S.Codec<VersionedHostPaymentTopUpRequest>;
/** Versioned envelope for [`HostPaymentTopUpResponse`]. */
export type VersionedHostPaymentTopUpResponse = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedHostPaymentTopUpResponse: S.Codec<VersionedHostPaymentTopUpResponse>;
/** Platform category a host runs on. */
export type HostPlatform = "Web" | "Android" | "Ios" | "Desktop" | "Cli" | "Unknown";
export declare const HostPlatform: S.Codec<HostPlatform>;
/** Versioned envelope for [`HostProductDeviceChatError`]. */
export type VersionedHostProductDeviceChatError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostProductDeviceChatError;
};
export declare const VersionedHostProductDeviceChatError: S.Codec<VersionedHostProductDeviceChatError>;
/** Versioned envelope for [`HostProductDeviceChatRequest`]. */
export type VersionedHostProductDeviceChatRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostProductDeviceChatRequest;
};
export declare const VersionedHostProductDeviceChatRequest: S.Codec<VersionedHostProductDeviceChatRequest>;
/** Versioned envelope for [`HostProductDeviceChatResponse`]. */
export type VersionedHostProductDeviceChatResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostProductDeviceChatResponse;
};
export declare const VersionedHostProductDeviceChatResponse: S.Codec<VersionedHostProductDeviceChatResponse>;
/** Versioned envelope for [`HostPushNotificationCancelError`]. */
export type VersionedHostPushNotificationCancelError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedHostPushNotificationCancelError: S.Codec<VersionedHostPushNotificationCancelError>;
/** Versioned envelope for [`HostPushNotificationCancelRequest`]. */
export type VersionedHostPushNotificationCancelRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPushNotificationCancelRequest;
};
export declare const VersionedHostPushNotificationCancelRequest: S.Codec<VersionedHostPushNotificationCancelRequest>;
/** Versioned envelope for [`HostPushNotificationCancelResponse`]. */
export type VersionedHostPushNotificationCancelResponse = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedHostPushNotificationCancelResponse: S.Codec<VersionedHostPushNotificationCancelResponse>;
/** Versioned envelope for [`HostPushNotificationError`]. */
export type VersionedHostPushNotificationError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPushNotificationError;
};
export declare const VersionedHostPushNotificationError: S.Codec<VersionedHostPushNotificationError>;
/** Versioned envelope for [`HostPushNotificationRequest`]. */
export type VersionedHostPushNotificationRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPushNotificationRequest;
};
export declare const VersionedHostPushNotificationRequest: S.Codec<VersionedHostPushNotificationRequest>;
/** Versioned envelope for [`HostPushNotificationResponse`]. */
export type VersionedHostPushNotificationResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostPushNotificationResponse;
};
export declare const VersionedHostPushNotificationResponse: S.Codec<VersionedHostPushNotificationResponse>;
/** Versioned envelope for [`HostRequestLoginError`]. */
export type VersionedHostRequestLoginError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostRequestLoginError;
};
export declare const VersionedHostRequestLoginError: S.Codec<VersionedHostRequestLoginError>;
/** Versioned envelope for [`HostRequestLoginRequest`]. */
export type VersionedHostRequestLoginRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostRequestLoginRequest;
};
export declare const VersionedHostRequestLoginRequest: S.Codec<VersionedHostRequestLoginRequest>;
/** Versioned envelope for [`HostRequestLoginResponse`]. */
export type VersionedHostRequestLoginResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostRequestLoginResponse;
};
export declare const VersionedHostRequestLoginResponse: S.Codec<VersionedHostRequestLoginResponse>;
/** Versioned envelope for [`HostRequestResourceAllocationError`]. */
export type VersionedHostRequestResourceAllocationError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: ResourceAllocationError;
};
export declare const VersionedHostRequestResourceAllocationError: S.Codec<VersionedHostRequestResourceAllocationError>;
/** Versioned envelope for [`HostRequestResourceAllocationRequest`]. */
export type VersionedHostRequestResourceAllocationRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostRequestResourceAllocationRequest;
};
export declare const VersionedHostRequestResourceAllocationRequest: S.Codec<VersionedHostRequestResourceAllocationRequest>;
/** Versioned envelope for [`HostRequestResourceAllocationResponse`]. */
export type VersionedHostRequestResourceAllocationResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostRequestResourceAllocationResponse;
};
export declare const VersionedHostRequestResourceAllocationResponse: S.Codec<VersionedHostRequestResourceAllocationResponse>;
/**
 * Full Substrate extrinsic signing payload with all fields needed for signature
 * generation.
 */
export interface HostSignPayloadData {
    /** Reference block hash. */
    blockHash: HexString;
    /** Reference block number. */
    blockNumber: HexString;
    /** Mortality era encoding. */
    era: HexString;
    /** Chain genesis hash. */
    genesisHash: HexString;
    /** SCALE-encoded call data. */
    method: HexString;
    /** Account nonce. */
    nonce: HexString;
    /** Runtime spec version. */
    specVersion: HexString;
    /** Transaction tip. */
    tip: HexString;
    /** Transaction format version. */
    transactionVersion: HexString;
    /** Extension identifiers. */
    signedExtensions: Array<string>;
    /** Extrinsic version. */
    version: number;
    /** For multi-asset tips. */
    assetId?: HexString;
    /** CheckMetadataHash extension. */
    metadataHash?: HexString;
    /** Metadata mode. */
    mode?: number;
    /** Request signed transaction back. */
    withSignedTransaction?: boolean;
}
export declare const HostSignPayloadData: S.Codec<HostSignPayloadData>;
/** Versioned envelope for [`HostSignPayloadError`]. */
export type VersionedHostSignPayloadError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignPayloadError;
};
export declare const VersionedHostSignPayloadError: S.Codec<VersionedHostSignPayloadError>;
/** Versioned envelope for [`HostSignPayloadRequest`]. */
export type VersionedHostSignPayloadRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignPayloadRequest;
};
export declare const VersionedHostSignPayloadRequest: S.Codec<VersionedHostSignPayloadRequest>;
/** Versioned envelope for [`HostSignPayloadResponse`]. */
export type VersionedHostSignPayloadResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignPayloadResponse;
};
export declare const VersionedHostSignPayloadResponse: S.Codec<VersionedHostSignPayloadResponse>;
/** Versioned envelope for [`HostSignPayloadWithLegacyAccountError`]. */
export type VersionedHostSignPayloadWithLegacyAccountError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignPayloadError;
};
export declare const VersionedHostSignPayloadWithLegacyAccountError: S.Codec<VersionedHostSignPayloadWithLegacyAccountError>;
/** Versioned envelope for [`HostSignPayloadWithLegacyAccountRequest`]. */
export type VersionedHostSignPayloadWithLegacyAccountRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignPayloadWithLegacyAccountRequest;
};
export declare const VersionedHostSignPayloadWithLegacyAccountRequest: S.Codec<VersionedHostSignPayloadWithLegacyAccountRequest>;
/** Versioned envelope for [`HostSignPayloadWithLegacyAccountResponse`]. */
export type VersionedHostSignPayloadWithLegacyAccountResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignPayloadResponse;
};
export declare const VersionedHostSignPayloadWithLegacyAccountResponse: S.Codec<VersionedHostSignPayloadWithLegacyAccountResponse>;
/** Versioned envelope for [`HostSignRawError`]. */
export type VersionedHostSignRawError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignPayloadError;
};
export declare const VersionedHostSignRawError: S.Codec<VersionedHostSignRawError>;
/** Versioned envelope for [`HostSignRawRequest`]. */
export type VersionedHostSignRawRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignRawRequest;
};
export declare const VersionedHostSignRawRequest: S.Codec<VersionedHostSignRawRequest>;
/** Versioned envelope for [`HostSignRawResponse`]. */
export type VersionedHostSignRawResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignPayloadResponse;
};
export declare const VersionedHostSignRawResponse: S.Codec<VersionedHostSignRawResponse>;
/** Versioned envelope for [`HostSignRawWithLegacyAccountError`]. */
export type VersionedHostSignRawWithLegacyAccountError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignPayloadError;
};
export declare const VersionedHostSignRawWithLegacyAccountError: S.Codec<VersionedHostSignRawWithLegacyAccountError>;
/** Versioned envelope for [`HostSignRawWithLegacyAccountRequest`]. */
export type VersionedHostSignRawWithLegacyAccountRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignRawWithLegacyAccountRequest;
};
export declare const VersionedHostSignRawWithLegacyAccountRequest: S.Codec<VersionedHostSignRawWithLegacyAccountRequest>;
/** Versioned envelope for [`HostSignRawWithLegacyAccountResponse`]. */
export type VersionedHostSignRawWithLegacyAccountResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostSignPayloadResponse;
};
export declare const VersionedHostSignRawWithLegacyAccountResponse: S.Codec<VersionedHostSignRawWithLegacyAccountResponse>;
/** Versioned envelope for [`HostThemeSubscribeItem`]. */
export type VersionedHostThemeSubscribeItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HostThemeSubscribeItem;
};
export declare const VersionedHostThemeSubscribeItem: S.Codec<VersionedHostThemeSubscribeItem>;
/**
 * A user-imported (legacy) account: public key plus an optional user-chosen
 * display name.
 *
 * Returned by [`HostGetLegacyAccountsResponse`]. Distinct from
 * [`ProductAccount`], which is protocol-derived and never carries a label.
 */
export interface LegacyAccount {
    /** The account public key (variable-length bytes). */
    publicKey: HexString;
    /** Optional user-chosen display name. */
    name?: string;
}
export declare const LegacyAccount: S.Codec<LegacyAccount>;
/**
 * Transaction payload for a legacy (non-product) account.
 *
 * Identical to [`ProductAccountTxPayload`] except the signer is a raw
 * 32-byte [`AccountId`].
 */
export interface LegacyAccountTxPayload {
    /** Raw 32-byte public key of the legacy account. */
    signer: AccountId;
    /** Chain where the transaction will execute. */
    genesisHash: GenesisHash;
    /** SCALE-encoded Call data. */
    callData: HexString;
    /** Transaction extensions supplied by the caller. */
    extensions: Array<TxPayloadExtension>;
    /** 0 for Extrinsic V4, runtime-supported value for V5. */
    txExtVersion: number;
}
export declare const LegacyAccountTxPayload: S.Codec<LegacyAccountTxPayload>;
/** Layout and styling modifiers applied to custom renderer components. */
export type Modifier = 
/** Outer spacing. */
{
    tag: "Margin";
    value: Dimensions;
}
/** Inner spacing. */
 | {
    tag: "Padding";
    value: Dimensions;
}
/** Background fill. */
 | {
    tag: "Background";
    value: Background;
}
/** Border style. */
 | {
    tag: "Border";
    value: BorderStyle;
}
/** Fixed height. */
 | {
    tag: "Height";
    value: {
        height: Size;
    };
}
/** Fixed width. */
 | {
    tag: "Width";
    value: {
        width: Size;
    };
}
/** Minimum width. */
 | {
    tag: "MinWidth";
    value: {
        width: Size;
    };
}
/** Minimum height. */
 | {
    tag: "MinHeight";
    value: {
        height: Size;
    };
}
/** Fill available width. */
 | {
    tag: "FillWidth";
    value: {
        enabled: boolean;
    };
}
/** Fill available height. */
 | {
    tag: "FillHeight";
    value: {
        enabled: boolean;
    };
};
export declare const Modifier: S.Codec<Modifier>;
/** Opaque identifier for a push notification, unique per product. */
export type NotificationId = number;
export declare const NotificationId: S.Codec<NotificationId>;
/** Outcome of starting a chain-head operation. */
export type OperationStartedResult = 
/** The operation was accepted; results arrive as follow events. */
{
    tag: "Started";
    value: {
        operationId: string;
    };
}
/** Too many operations are in progress; retry after some complete. */
 | {
    tag: "LimitReached";
    value?: undefined;
};
export declare const OperationStartedResult: S.Codec<OperationStartedResult>;
/** An optional boolean with the compact SCALE encoding used by renderer props. */
export type OptionalBool = boolean | undefined;
export declare const OptionalBool: S.Codec<OptionalBool>;
/**
 * Source for a payment top-up operation.
 *
 * See [RFC 0006].
 *
 * [RFC 0006]: https://github.com/paritytech/triangle-js-sdks/pull/94
 */
export type PaymentTopUpSource = 
/** Fund from one of the calling product's scoped accounts. */
{
    tag: "ProductAccount";
    value: {
        derivationIndex: DerivationIndex;
    };
}
/**
 * Fund from a one-time account represented by its private key. This is a
 * standard account holding public funds, not a coin key.
 */
 | {
    tag: "PrivateKey";
    value: {
        sr25519SecretKey: HexString;
    };
}
/**
 * Fund directly from coin secret keys. Each key is an sr25519 secret
 * controlling a single coin.
 */
 | {
    tag: "Coins";
    value: {
        sr25519SecretKeys: Array<HexString>;
    };
};
export declare const PaymentTopUpSource: S.Codec<PaymentTopUpSource>;
/** Preimage submission error. */
export type PreimageSubmitError = 
/** Catch-all. */
{
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const PreimageSubmitError: S.Codec<PreimageSubmitError>;
/** A product account: public key only, no display name. */
export interface ProductAccount {
    /** The account public key (variable-length bytes). */
    publicKey: HexString;
}
export declare const ProductAccount: S.Codec<ProductAccount>;
/**
 * Identifies a product-specific account by combining a dotNS domain name with a
 * derivation index.
 */
export interface ProductAccountId {
    /** A dotNS domain name identifier (e.g., `"my-product.dot"`). */
    dotNsIdentifier: string;
    /** Account selector within the product subtree. */
    derivationIndex: DerivationIndex;
}
export declare const ProductAccountId: S.Codec<ProductAccountId>;
/**
 * Transaction payload for a product account.
 *
 * Contains everything the host needs to construct a signed extrinsic.
 * The signer is a [`ProductAccountId`]; the host resolves the
 * corresponding key pair through its account management layer.
 */
export interface ProductAccountTxPayload {
    /** Product account that will sign the transaction. */
    signer: ProductAccountId;
    /** Chain where the transaction will execute. */
    genesisHash: GenesisHash;
    /** SCALE-encoded Call data. */
    callData: HexString;
    /** Transaction extensions supplied by the caller. */
    extensions: Array<TxPayloadExtension>;
    /** 0 for Extrinsic V4, runtime-supported value for V5. */
    txExtVersion: number;
}
export declare const ProductAccountTxPayload: S.Codec<ProductAccountTxPayload>;
/** Versioned envelope for [`ProductChatCustomMessageRenderItem`]. */
export type VersionedProductChatCustomMessageRenderItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: CustomRendererNode;
};
export declare const VersionedProductChatCustomMessageRenderItem: S.Codec<VersionedProductChatCustomMessageRenderItem>;
/** Versioned envelope for [`ProductChatCustomMessageRenderRequest`]. */
export type VersionedProductChatCustomMessageRenderRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: ProductChatCustomMessageRenderRequest;
};
export declare const VersionedProductChatCustomMessageRenderRequest: S.Codec<VersionedProductChatCustomMessageRenderRequest>;
/**
 * A product-scoped proof context: a product and a context within it.
 *
 * Hashed (with a `product/<product_id>/` prefix) into the 32-byte context bound
 * to a ring VRF proof, so contexts cannot collide across products and the same
 * member key under different contexts yields unlinkable aliases.
 */
export interface ProductProofContext {
    /** dotNS product identifier (e.g. `"my-product.dot"`) scoping the context. */
    productId: string;
    /**
     * Selector distinguishing contexts within the product; expands to the
     * same 32-byte derivation index as [`ProductAccountId::derivation_index`].
     */
    suffix: DerivationIndex;
}
export declare const ProductProofContext: S.Codec<ProductProofContext>;
/** Raw data to sign -- either binary bytes or a string message. */
export type RawPayload = 
/** Raw binary data to sign. */
{
    tag: "Bytes";
    value: {
        bytes: HexString;
    };
}
/** String message to sign. */
 | {
    tag: "Payload";
    value: {
        payload: string;
    };
};
export declare const RawPayload: S.Codec<RawPayload>;
/** A registered ring-VRF key entry. */
export interface RegisteredRingVrfKey {
    /** Stable public name of the key. */
    handle: ProductAccountId;
    /** Rings the owning product declared this key for. */
    rings: Array<RingLocation>;
    /** Present when the caller owns the key or requested/granted disclosure. */
    publicKey?: RingVrfPublicKey;
}
export declare const RegisteredRingVrfKey: S.Codec<RegisteredRingVrfKey>;
/** Versioned envelope for [`RemoteChainHeadBodyError`]. */
export type VersionedRemoteChainHeadBodyError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainHeadBodyError: S.Codec<VersionedRemoteChainHeadBodyError>;
/** Versioned envelope for [`RemoteChainHeadBodyRequest`]. */
export type VersionedRemoteChainHeadBodyRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadBodyRequest;
};
export declare const VersionedRemoteChainHeadBodyRequest: S.Codec<VersionedRemoteChainHeadBodyRequest>;
/** Versioned envelope for [`RemoteChainHeadBodyResponse`]. */
export type VersionedRemoteChainHeadBodyResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadBodyResponse;
};
export declare const VersionedRemoteChainHeadBodyResponse: S.Codec<VersionedRemoteChainHeadBodyResponse>;
/** Versioned envelope for [`RemoteChainHeadCallError`]. */
export type VersionedRemoteChainHeadCallError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainHeadCallError: S.Codec<VersionedRemoteChainHeadCallError>;
/** Versioned envelope for [`RemoteChainHeadCallRequest`]. */
export type VersionedRemoteChainHeadCallRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadCallRequest;
};
export declare const VersionedRemoteChainHeadCallRequest: S.Codec<VersionedRemoteChainHeadCallRequest>;
/** Versioned envelope for [`RemoteChainHeadCallResponse`]. */
export type VersionedRemoteChainHeadCallResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadCallResponse;
};
export declare const VersionedRemoteChainHeadCallResponse: S.Codec<VersionedRemoteChainHeadCallResponse>;
/** Versioned envelope for [`RemoteChainHeadContinueError`]. */
export type VersionedRemoteChainHeadContinueError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainHeadContinueError: S.Codec<VersionedRemoteChainHeadContinueError>;
/** Versioned envelope for [`RemoteChainHeadContinueRequest`]. */
export type VersionedRemoteChainHeadContinueRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadContinueRequest;
};
export declare const VersionedRemoteChainHeadContinueRequest: S.Codec<VersionedRemoteChainHeadContinueRequest>;
/** Versioned envelope for [`RemoteChainHeadContinueResponse`]. */
export type VersionedRemoteChainHeadContinueResponse = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedRemoteChainHeadContinueResponse: S.Codec<VersionedRemoteChainHeadContinueResponse>;
/** Versioned envelope for [`RemoteChainHeadFollowItem`]. */
export type VersionedRemoteChainHeadFollowItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadFollowItem;
};
export declare const VersionedRemoteChainHeadFollowItem: S.Codec<VersionedRemoteChainHeadFollowItem>;
/** Versioned envelope for [`RemoteChainHeadFollowRequest`]. */
export type VersionedRemoteChainHeadFollowRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadFollowRequest;
};
export declare const VersionedRemoteChainHeadFollowRequest: S.Codec<VersionedRemoteChainHeadFollowRequest>;
/** Versioned envelope for [`RemoteChainHeadHeaderError`]. */
export type VersionedRemoteChainHeadHeaderError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainHeadHeaderError: S.Codec<VersionedRemoteChainHeadHeaderError>;
/** Versioned envelope for [`RemoteChainHeadHeaderRequest`]. */
export type VersionedRemoteChainHeadHeaderRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadHeaderRequest;
};
export declare const VersionedRemoteChainHeadHeaderRequest: S.Codec<VersionedRemoteChainHeadHeaderRequest>;
/** Versioned envelope for [`RemoteChainHeadHeaderResponse`]. */
export type VersionedRemoteChainHeadHeaderResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadHeaderResponse;
};
export declare const VersionedRemoteChainHeadHeaderResponse: S.Codec<VersionedRemoteChainHeadHeaderResponse>;
/** Versioned envelope for [`RemoteChainHeadStopOperationError`]. */
export type VersionedRemoteChainHeadStopOperationError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainHeadStopOperationError: S.Codec<VersionedRemoteChainHeadStopOperationError>;
/** Versioned envelope for [`RemoteChainHeadStopOperationRequest`]. */
export type VersionedRemoteChainHeadStopOperationRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadStopOperationRequest;
};
export declare const VersionedRemoteChainHeadStopOperationRequest: S.Codec<VersionedRemoteChainHeadStopOperationRequest>;
/** Versioned envelope for [`RemoteChainHeadStopOperationResponse`]. */
export type VersionedRemoteChainHeadStopOperationResponse = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedRemoteChainHeadStopOperationResponse: S.Codec<VersionedRemoteChainHeadStopOperationResponse>;
/** Versioned envelope for [`RemoteChainHeadStorageError`]. */
export type VersionedRemoteChainHeadStorageError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainHeadStorageError: S.Codec<VersionedRemoteChainHeadStorageError>;
/** Versioned envelope for [`RemoteChainHeadStorageRequest`]. */
export type VersionedRemoteChainHeadStorageRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadStorageRequest;
};
export declare const VersionedRemoteChainHeadStorageRequest: S.Codec<VersionedRemoteChainHeadStorageRequest>;
/** Versioned envelope for [`RemoteChainHeadStorageResponse`]. */
export type VersionedRemoteChainHeadStorageResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadStorageResponse;
};
export declare const VersionedRemoteChainHeadStorageResponse: S.Codec<VersionedRemoteChainHeadStorageResponse>;
/** Versioned envelope for [`RemoteChainHeadUnpinError`]. */
export type VersionedRemoteChainHeadUnpinError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainHeadUnpinError: S.Codec<VersionedRemoteChainHeadUnpinError>;
/** Versioned envelope for [`RemoteChainHeadUnpinRequest`]. */
export type VersionedRemoteChainHeadUnpinRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainHeadUnpinRequest;
};
export declare const VersionedRemoteChainHeadUnpinRequest: S.Codec<VersionedRemoteChainHeadUnpinRequest>;
/** Versioned envelope for [`RemoteChainHeadUnpinResponse`]. */
export type VersionedRemoteChainHeadUnpinResponse = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedRemoteChainHeadUnpinResponse: S.Codec<VersionedRemoteChainHeadUnpinResponse>;
/** Versioned envelope for [`RemoteChainInfoError`]. */
export type VersionedRemoteChainInfoError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainInfoError;
};
export declare const VersionedRemoteChainInfoError: S.Codec<VersionedRemoteChainInfoError>;
/** Versioned envelope for [`RemoteChainInfoRequest`]. */
export type VersionedRemoteChainInfoRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainInfoRequest;
};
export declare const VersionedRemoteChainInfoRequest: S.Codec<VersionedRemoteChainInfoRequest>;
/** Versioned envelope for [`RemoteChainInfoResponse`]. */
export type VersionedRemoteChainInfoResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainInfoResponse;
};
export declare const VersionedRemoteChainInfoResponse: S.Codec<VersionedRemoteChainInfoResponse>;
/** Versioned envelope for [`RemoteChainSpecChainNameError`]. */
export type VersionedRemoteChainSpecChainNameError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainSpecChainNameError: S.Codec<VersionedRemoteChainSpecChainNameError>;
/** Versioned envelope for [`RemoteChainSpecChainNameRequest`]. */
export type VersionedRemoteChainSpecChainNameRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainSpecChainNameRequest;
};
export declare const VersionedRemoteChainSpecChainNameRequest: S.Codec<VersionedRemoteChainSpecChainNameRequest>;
/** Versioned envelope for [`RemoteChainSpecChainNameResponse`]. */
export type VersionedRemoteChainSpecChainNameResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainSpecChainNameResponse;
};
export declare const VersionedRemoteChainSpecChainNameResponse: S.Codec<VersionedRemoteChainSpecChainNameResponse>;
/** Versioned envelope for [`RemoteChainSpecGenesisHashError`]. */
export type VersionedRemoteChainSpecGenesisHashError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainSpecGenesisHashError: S.Codec<VersionedRemoteChainSpecGenesisHashError>;
/** Versioned envelope for [`RemoteChainSpecGenesisHashRequest`]. */
export type VersionedRemoteChainSpecGenesisHashRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainSpecGenesisHashRequest;
};
export declare const VersionedRemoteChainSpecGenesisHashRequest: S.Codec<VersionedRemoteChainSpecGenesisHashRequest>;
/** Versioned envelope for [`RemoteChainSpecGenesisHashResponse`]. */
export type VersionedRemoteChainSpecGenesisHashResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainSpecGenesisHashResponse;
};
export declare const VersionedRemoteChainSpecGenesisHashResponse: S.Codec<VersionedRemoteChainSpecGenesisHashResponse>;
/** Versioned envelope for [`RemoteChainSpecPropertiesError`]. */
export type VersionedRemoteChainSpecPropertiesError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainSpecPropertiesError: S.Codec<VersionedRemoteChainSpecPropertiesError>;
/** Versioned envelope for [`RemoteChainSpecPropertiesRequest`]. */
export type VersionedRemoteChainSpecPropertiesRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainSpecPropertiesRequest;
};
export declare const VersionedRemoteChainSpecPropertiesRequest: S.Codec<VersionedRemoteChainSpecPropertiesRequest>;
/** Versioned envelope for [`RemoteChainSpecPropertiesResponse`]. */
export type VersionedRemoteChainSpecPropertiesResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainSpecPropertiesResponse;
};
export declare const VersionedRemoteChainSpecPropertiesResponse: S.Codec<VersionedRemoteChainSpecPropertiesResponse>;
/** Versioned envelope for [`RemoteChainTransactionBroadcastError`]. */
export type VersionedRemoteChainTransactionBroadcastError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainTransactionBroadcastError: S.Codec<VersionedRemoteChainTransactionBroadcastError>;
/** Versioned envelope for [`RemoteChainTransactionBroadcastRequest`]. */
export type VersionedRemoteChainTransactionBroadcastRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainTransactionBroadcastRequest;
};
export declare const VersionedRemoteChainTransactionBroadcastRequest: S.Codec<VersionedRemoteChainTransactionBroadcastRequest>;
/** Versioned envelope for [`RemoteChainTransactionBroadcastResponse`]. */
export type VersionedRemoteChainTransactionBroadcastResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainTransactionBroadcastResponse;
};
export declare const VersionedRemoteChainTransactionBroadcastResponse: S.Codec<VersionedRemoteChainTransactionBroadcastResponse>;
/** Versioned envelope for [`RemoteChainTransactionStopError`]. */
export type VersionedRemoteChainTransactionStopError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteChainTransactionStopError: S.Codec<VersionedRemoteChainTransactionStopError>;
/** Versioned envelope for [`RemoteChainTransactionStopRequest`]. */
export type VersionedRemoteChainTransactionStopRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteChainTransactionStopRequest;
};
export declare const VersionedRemoteChainTransactionStopRequest: S.Codec<VersionedRemoteChainTransactionStopRequest>;
/** Versioned envelope for [`RemoteChainTransactionStopResponse`]. */
export type VersionedRemoteChainTransactionStopResponse = 
/** Version 1 (no payload). */
{
    tag: "V1";
    value?: undefined;
};
export declare const VersionedRemoteChainTransactionStopResponse: S.Codec<VersionedRemoteChainTransactionStopResponse>;
/**
 * One remote-operation permission requested by the product (RFC 0002).
 *
 * `ChainSubmit`, `PreimageSubmit`, and `StatementSubmit` are also triggered
 * implicitly by the corresponding business calls when not yet granted.
 */
export type RemotePermission = 
/**
 * Reaching a set of domains: outbound HTTP/WebSocket access, and sending
 * the user out to one of them with `navigate_to`.
 *
 * One grant per host covers both, because both hand the same third party
 * the same thing: that the user is here, and whatever the product puts in
 * the URL. Splitting them would put the same question to the user twice.
 */
{
    tag: "Remote";
    value: {
        domains: Array<string>;
    };
}
/**
 * WebRTC access.
 *
 * Enforced inside the product's own realm rather than at a network layer:
 * ICE reaches an arbitrary host over UDP, so no content rule list, request
 * interceptor, or CSP directive observes it. A host peeks this decision
 * before the product realm exists and the lockdown container removes
 * `RTCPeerConnection` — and its vendor-prefixed aliases — unless the answer
 * was an explicit grant. Resolving it up front is what makes the gate
 * unforgeable, and it means a fresh grant applies from the next load.
 *
 * Camera and microphone capture is gated by the OS permission prompts and
 * [`HostDevicePermissionRequest`], not by this permission.
 */
 | {
    tag: "WebRtc";
    value?: undefined;
}
/** Submitting transactions on behalf of the user via `remote_chain_transaction_broadcast`. */
 | {
    tag: "ChainSubmit";
    value?: undefined;
}
/** Submitting preimages on behalf of the user via `remote_preimage_submit`. */
 | {
    tag: "PreimageSubmit";
    value?: undefined;
}
/** Submitting statements on behalf of the user via `remote_statement_store_submit`. */
 | {
    tag: "StatementSubmit";
    value?: undefined;
};
export declare const RemotePermission: S.Codec<RemotePermission>;
/** Versioned envelope for [`RemotePermissionError`]. */
export type VersionedRemotePermissionError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemotePermissionError: S.Codec<VersionedRemotePermissionError>;
/** Versioned envelope for [`RemotePermissionRequest`]. */
export type VersionedRemotePermissionRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemotePermissionRequest;
};
export declare const VersionedRemotePermissionRequest: S.Codec<VersionedRemotePermissionRequest>;
/** Versioned envelope for [`RemotePermissionResponse`]. */
export type VersionedRemotePermissionResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemotePermissionResponse;
};
export declare const VersionedRemotePermissionResponse: S.Codec<VersionedRemotePermissionResponse>;
/** Versioned envelope for [`RemotePreimageLookupSubscribeItem`]. */
export type VersionedRemotePreimageLookupSubscribeItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemotePreimageLookupSubscribeItem;
};
export declare const VersionedRemotePreimageLookupSubscribeItem: S.Codec<VersionedRemotePreimageLookupSubscribeItem>;
/** Versioned envelope for [`RemotePreimageLookupSubscribeRequest`]. */
export type VersionedRemotePreimageLookupSubscribeRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemotePreimageLookupSubscribeRequest;
};
export declare const VersionedRemotePreimageLookupSubscribeRequest: S.Codec<VersionedRemotePreimageLookupSubscribeRequest>;
/** Versioned envelope for [`RemotePreimageSubmitError`]. */
export type VersionedRemotePreimageSubmitError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: PreimageSubmitError;
};
export declare const VersionedRemotePreimageSubmitError: S.Codec<VersionedRemotePreimageSubmitError>;
/** Versioned envelope for [`RemotePreimageSubmitRequest`]. */
export type VersionedRemotePreimageSubmitRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HexString;
};
export declare const VersionedRemotePreimageSubmitRequest: S.Codec<VersionedRemotePreimageSubmitRequest>;
/** Versioned envelope for [`RemotePreimageSubmitResponse`]. */
export type VersionedRemotePreimageSubmitResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: HexString;
};
export declare const VersionedRemotePreimageSubmitResponse: S.Codec<VersionedRemotePreimageSubmitResponse>;
/** Versioned envelope for [`RemoteStatementStoreCreateProofAuthorizedError`]. */
export type VersionedRemoteStatementStoreCreateProofAuthorizedError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteStatementStoreCreateProofError;
};
export declare const VersionedRemoteStatementStoreCreateProofAuthorizedError: S.Codec<VersionedRemoteStatementStoreCreateProofAuthorizedError>;
/** Versioned envelope for [`RemoteStatementStoreCreateProofAuthorizedRequest`]. */
export type VersionedRemoteStatementStoreCreateProofAuthorizedRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: Statement;
};
export declare const VersionedRemoteStatementStoreCreateProofAuthorizedRequest: S.Codec<VersionedRemoteStatementStoreCreateProofAuthorizedRequest>;
/** Versioned envelope for [`RemoteStatementStoreCreateProofAuthorizedResponse`]. */
export type VersionedRemoteStatementStoreCreateProofAuthorizedResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteStatementStoreCreateProofResponse;
};
export declare const VersionedRemoteStatementStoreCreateProofAuthorizedResponse: S.Codec<VersionedRemoteStatementStoreCreateProofAuthorizedResponse>;
/** Versioned envelope for [`RemoteStatementStoreCreateProofError`]. */
export type VersionedRemoteStatementStoreCreateProofError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteStatementStoreCreateProofError;
};
export declare const VersionedRemoteStatementStoreCreateProofError: S.Codec<VersionedRemoteStatementStoreCreateProofError>;
/** Versioned envelope for [`RemoteStatementStoreCreateProofRequest`]. */
export type VersionedRemoteStatementStoreCreateProofRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteStatementStoreCreateProofRequest;
};
export declare const VersionedRemoteStatementStoreCreateProofRequest: S.Codec<VersionedRemoteStatementStoreCreateProofRequest>;
/** Versioned envelope for [`RemoteStatementStoreCreateProofResponse`]. */
export type VersionedRemoteStatementStoreCreateProofResponse = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteStatementStoreCreateProofResponse;
};
export declare const VersionedRemoteStatementStoreCreateProofResponse: S.Codec<VersionedRemoteStatementStoreCreateProofResponse>;
/** Versioned envelope for [`RemoteStatementStoreSubmitError`]. */
export type VersionedRemoteStatementStoreSubmitError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteStatementStoreSubmitError: S.Codec<VersionedRemoteStatementStoreSubmitError>;
/** Versioned envelope for [`RemoteStatementStoreSubmitRequest`]. */
export type VersionedRemoteStatementStoreSubmitRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: SignedStatement;
};
export declare const VersionedRemoteStatementStoreSubmitRequest: S.Codec<VersionedRemoteStatementStoreSubmitRequest>;
/** Versioned envelope for [`RemoteStatementStoreSubscribeError`]. */
export type VersionedRemoteStatementStoreSubscribeError = 
/** Version 1 payload. */
{
    tag: "V1";
    value: GenericError;
};
export declare const VersionedRemoteStatementStoreSubscribeError: S.Codec<VersionedRemoteStatementStoreSubscribeError>;
/** Versioned envelope for [`RemoteStatementStoreSubscribeItem`]. */
export type VersionedRemoteStatementStoreSubscribeItem = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteStatementStoreSubscribeItem;
};
export declare const VersionedRemoteStatementStoreSubscribeItem: S.Codec<VersionedRemoteStatementStoreSubscribeItem>;
/** Versioned envelope for [`RemoteStatementStoreSubscribeRequest`]. */
export type VersionedRemoteStatementStoreSubscribeRequest = 
/** Version 1 payload. */
{
    tag: "V1";
    value: RemoteStatementStoreSubscribeRequest;
};
export declare const VersionedRemoteStatementStoreSubscribeRequest: S.Codec<VersionedRemoteStatementStoreSubscribeRequest>;
/** Error from [`crate::api::ResourceAllocation::request`]. */
export type ResourceAllocationError = 
/** Catch-all. */
{
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const ResourceAllocationError: S.Codec<ResourceAllocationError>;
/**
 * Locates a ring for ring VRF operations using only identifiers that are
 * stable across membership changes.
 */
export interface RingLocation {
    /** Genesis hash of the chain hosting the ring. */
    chainId: GenesisHash;
    /** Path addressing the ring within the chain. */
    junctions: Array<RingLocationJunction>;
}
export declare const RingLocation: S.Codec<RingLocation>;
/** A single step in a [`RingLocation`] path, addressing a ring within a chain. */
export type RingLocationJunction = 
/** Pallet instance hosting the ring collection. */
{
    tag: "PalletInstance";
    value: number;
}
/** Ring collection identifier within the pallet. */
 | {
    tag: "CollectionId";
    value: HexString;
};
export declare const RingLocationJunction: S.Codec<RingLocationJunction>;
/** How much of a registry entry the caller asks for. */
export type RingVrfKeyDisclosure = "Anonymized" | "PublicKey";
export declare const RingVrfKeyDisclosure: S.Codec<RingVrfKeyDisclosure>;
/** Ring-VRF member public key. */
export type RingVrfPublicKey = HexString;
export declare const RingVrfPublicKey: S.Codec<RingVrfPublicKey>;
/** Properties for a [`CustomRendererNode::Row`] layout. */
export interface RowProps {
    /** Vertical alignment of children. */
    verticalAlignment?: VerticalAlignment;
    /** Horizontal arrangement of children. */
    horizontalArrangement?: Arrangement;
}
export declare const RowProps: S.Codec<RowProps>;
/** One entry of a runtime's supported API list. */
export interface RuntimeApi {
    /** Runtime API name. */
    name: string;
    /** Runtime API version. */
    version: number;
}
export declare const RuntimeApi: S.Codec<RuntimeApi>;
/** Runtime version information for a block's runtime. */
export interface RuntimeSpec {
    /** Specification name. */
    specName: string;
    /** Implementation name. */
    implName: string;
    /** Spec version number. */
    specVersion: number;
    /** Implementation version. */
    implVersion: number;
    /** Transaction format version. */
    transactionVersion?: number;
    /** Supported runtime APIs. */
    apis: Array<RuntimeApi>;
}
export declare const RuntimeSpec: S.Codec<RuntimeSpec>;
/** Runtime attached to follow events, either a decoded spec or a decode error. */
export type RuntimeType = 
/** Runtime spec decoded successfully. */
{
    tag: "Valid";
    value: RuntimeSpec;
}
/** The runtime could not be decoded. */
 | {
    tag: "Invalid";
    value: {
        error: string;
    };
};
export declare const RuntimeType: S.Codec<RuntimeType>;
/** Shape for borders and backgrounds. */
export type Shape = 
/** Border radius value. */
{
    tag: "Rounded";
    value: {
        radius: Size;
    };
}
/** Circular shape. */
 | {
    tag: "Circle";
    value?: undefined;
};
export declare const Shape: S.Codec<Shape>;
/** A statement with a required (not optional) proof. */
export interface SignedStatement {
    /** Required cryptographic proof. */
    proof: StatementProof;
    /** Optional decryption key. */
    decryptionKey?: HexString;
    /** Optional Unix timestamp expiry. */
    expiry?: bigint;
    /** Optional channel. */
    channel?: HexString;
    /** [u8; 32] tags. */
    topics: Array<HexString>;
    /** Optional data payload. */
    data?: HexString;
}
export declare const SignedStatement: S.Codec<SignedStatement>;
/**
 * A size/dimension value (logical pixels) used across the custom renderer.
 *
 * Encoded as a SCALE `Compact<u64>`: the common small values cost a single
 * byte on the wire instead of eight.
 */
export type Size = number | bigint;
export declare const Size: S.Codec<Size>;
/** A statement with optional proof and metadata. */
export interface Statement {
    /** Optional cryptographic proof. */
    proof?: StatementProof;
    /** Optional decryption key. */
    decryptionKey?: HexString;
    /** Optional Unix timestamp expiry. */
    expiry?: bigint;
    /** Optional channel. */
    channel?: HexString;
    /** [u8; 32] tags. */
    topics: Array<HexString>;
    /** Optional data payload. */
    data?: HexString;
}
export declare const Statement: S.Codec<Statement>;
/** Cryptographic proof for a statement. */
export type StatementProof = 
/** Sr25519 signature proof. */
{
    tag: "Sr25519";
    value: {
        signature: HexString;
        signer: HexString;
    };
}
/** Ed25519 signature proof. */
 | {
    tag: "Ed25519";
    value: {
        signature: HexString;
        signer: HexString;
    };
}
/** ECDSA signature proof. */
 | {
    tag: "Ecdsa";
    value: {
        signature: HexString;
        signer: HexString;
    };
}
/** On-chain event proof. */
 | {
    tag: "OnChain";
    value: {
        who: HexString;
        blockHash: HexString;
        event: bigint;
    };
};
export declare const StatementProof: S.Codec<StatementProof>;
/** A single key query within a chain-head storage request. */
export interface StorageQueryItem {
    /** Storage key to query. */
    key: HexString;
    /** What to return. */
    queryType: StorageQueryType;
}
export declare const StorageQueryItem: S.Codec<StorageQueryItem>;
/** What a chain-head storage query returns for a key. */
export type StorageQueryType = "Value" | "Hash" | "ClosestDescendantMerkleValue" | "DescendantsValues" | "DescendantsHashes";
export declare const StorageQueryType: S.Codec<StorageQueryType>;
/** Result for one queried storage key. */
export interface StorageResultItem {
    /** The queried key. */
    key: HexString;
    /** Value, if requested. */
    value?: HexString;
    /** Hash, if requested. */
    hash?: HexString;
    /** Merkle value, if requested. */
    closestDescendantMerkleValue?: HexString;
}
export declare const StorageResultItem: S.Codec<StorageResultItem>;
/** Properties for a [`CustomRendererNode::TextField`]. */
export interface TextFieldProps {
    /** Current text value. */
    text: string;
    /** Placeholder text. */
    placeholder?: string;
    /** Field label. */
    label?: string;
    /** Whether the field is enabled. Absent leaves the default to the host. */
    enabled: OptionalBool;
    /** Action identifier triggered when the value changes. */
    valueChangeAction?: string;
}
export declare const TextFieldProps: S.Codec<TextFieldProps>;
/** Properties for a [`CustomRendererNode::Text`] display. */
export interface TextProps {
    /** Typography preset. */
    style?: TypographyStyle;
    /** Text color. */
    color?: ColorToken;
}
export declare const TextProps: S.Codec<TextProps>;
/** Identifies a named theme. */
export type ThemeName = 
/** A custom named theme. */
{
    tag: "Custom";
    value: string;
}
/** The host's default theme. */
 | {
    tag: "Default";
    value?: undefined;
};
export declare const ThemeName: S.Codec<ThemeName>;
/** Light or dark variant. */
export type ThemeVariant = "Light" | "Dark";
export declare const ThemeVariant: S.Codec<ThemeVariant>;
/** 32-byte statement topic. */
export type Topic = HexString;
export declare const Topic: S.Codec<Topic>;
/** A signed extension for a transaction payload. */
export interface TxPayloadExtension {
    /** Extension name (e.g., `"CheckSpecVersion"`). */
    id: string;
    /** SCALE-encoded extra data (in extrinsic body). */
    extra: HexString;
    /** SCALE-encoded implicit data (signed, not in body). */
    additionalSigned: HexString;
}
export declare const TxPayloadExtension: S.Codec<TxPayloadExtension>;
/** Text typography presets. */
export type TypographyStyle = "HeadlineLarge" | "TitleMediumRegular" | "BodyLargeRegular" | "BodyMediumRegular" | "BodySmallRegular";
export declare const TypographyStyle: S.Codec<TypographyStyle>;
/** User's authentication state. */
export type HostAccountConnectionStatusSubscribeItem = "Disconnected" | "Connected";
export declare const HostAccountConnectionStatusSubscribeItem: S.Codec<HostAccountConnectionStatusSubscribeItem>;
/** Error returned when ring VRF proof creation fails. */
export type HostAccountCreateProofError = 
/** Ring not available at the specified location. */
{
    tag: "RingNotFound";
    value?: undefined;
}
/** The registered member key is not a member of the requested ring. */
 | {
    tag: "NotMember";
    value?: undefined;
}
/** The key handle is not registered. */
 | {
    tag: "KeyNotRegistered";
    value?: undefined;
}
/** The key handle is not registered for the requested ring. */
 | {
    tag: "KeyNotInRing";
    value?: undefined;
}
/** The foreign key owner has not allowlisted the caller. */
 | {
    tag: "NotAllowlisted";
    value?: undefined;
}
/** User or host rejected. */
 | {
    tag: "Rejected";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostAccountCreateProofError: S.Codec<HostAccountCreateProofError>;
/** Request to create a ring VRF proof. */
export interface HostAccountCreateProofRequest {
    /** Ring-VRF key handle naming the member key to use. */
    keyHandle: ProductAccountId;
    /** Product-scoped context the derived alias is bound to. */
    context: ProductProofContext;
    /** Ring to generate the proof against. */
    ringLocation: RingLocation;
    /** Opaque message bound into the proof. */
    message: HexString;
}
export declare const HostAccountCreateProofRequest: S.Codec<HostAccountCreateProofRequest>;
/**
 * Response containing a ring VRF proof and the values needed to verify it
 * against a downstream precompile.
 */
export interface HostAccountCreateProofResponse {
    /** Variable-length ring VRF proof bytes. */
    proof: HexString;
    /** Alias derived for the request's context. */
    contextualAlias: ContextualAlias;
    /** Index of the selected member key within the ring. */
    ringIndex: number;
    /** Ring revision the proof was generated against. */
    ringRevision: number;
}
export declare const HostAccountCreateProofResponse: S.Codec<HostAccountCreateProofResponse>;
/** Error returned when contextual alias derivation fails. */
export type HostAccountGetAliasError = 
/** Ring not available at the specified location. */
{
    tag: "RingNotFound";
    value?: undefined;
}
/** The registered member key is not a member of the requested ring. */
 | {
    tag: "NotMember";
    value?: undefined;
}
/** The key handle is not registered. */
 | {
    tag: "KeyNotRegistered";
    value?: undefined;
}
/** The key handle is not registered for the requested ring. */
 | {
    tag: "KeyNotInRing";
    value?: undefined;
}
/** User or host rejected. */
 | {
    tag: "Rejected";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostAccountGetAliasError: S.Codec<HostAccountGetAliasError>;
/** Request to retrieve the contextual alias for a context and ring. */
export interface HostAccountGetAliasRequest {
    /** Ring-VRF key handle naming the member key to use. */
    keyHandle: ProductAccountId;
    /** Product-scoped context to derive the alias for. */
    context: ProductProofContext;
    /** Ring whose member key the host should use; matches `create_proof`. */
    ringLocation: RingLocation;
}
export declare const HostAccountGetAliasRequest: S.Codec<HostAccountGetAliasRequest>;
/** Error returned when credential/account requests fail. */
export type HostAccountGetError = 
/** User is not logged in. */
{
    tag: "NotConnected";
    value?: undefined;
}
/** User or host rejected the request. */
 | {
    tag: "Rejected";
    value?: undefined;
}
/** Domain identifier is invalid. */
 | {
    tag: "DomainNotValid";
    value?: undefined;
}
/** Catch-all error with reason. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostAccountGetError: S.Codec<HostAccountGetError>;
/** Request to retrieve a product-scoped account. */
export interface HostAccountGetRequest {
    /** Product account to retrieve. */
    productAccountId: ProductAccountId;
}
export declare const HostAccountGetRequest: S.Codec<HostAccountGetRequest>;
/** Response containing a product-scoped account. */
export interface HostAccountGetResponse {
    /** Retrieved product account. */
    account: ProductAccount;
}
export declare const HostAccountGetResponse: S.Codec<HostAccountGetResponse>;
/** Error returned when listing ring-VRF keys fails. */
export type HostAccountListRingVrfKeysError = 
/** User is not logged in. */
{
    tag: "NotConnected";
    value?: undefined;
}
/** User or host rejected. */
 | {
    tag: "Rejected";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostAccountListRingVrfKeysError: S.Codec<HostAccountListRingVrfKeysError>;
/** Request to list registered ring-VRF keys for an owner product. */
export interface HostAccountListRingVrfKeysRequest {
    /** Product whose registry entries should be listed. */
    owner: string;
    /** Disclosure level requested by the caller. */
    disclosure: RingVrfKeyDisclosure;
}
export declare const HostAccountListRingVrfKeysRequest: S.Codec<HostAccountListRingVrfKeysRequest>;
/** Error returned when ring-VRF key registration fails. */
export type HostAccountRegisterRingVrfKeyError = 
/** User is not logged in. */
{
    tag: "NotConnected";
    value?: undefined;
}
/** Ring not available at the specified location. */
 | {
    tag: "RingNotFound";
    value?: undefined;
}
/** User or host rejected. */
 | {
    tag: "Rejected";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostAccountRegisterRingVrfKeyError: S.Codec<HostAccountRegisterRingVrfKeyError>;
/** Request to register a ring-VRF key owned by the calling product. */
export interface HostAccountRegisterRingVrfKeyRequest {
    /** Key derivation index within the caller's ring-VRF domain. */
    index: DerivationIndex;
    /** Ring this key is declared for. */
    ring: RingLocation;
}
export declare const HostAccountRegisterRingVrfKeyRequest: S.Codec<HostAccountRegisterRingVrfKeyRequest>;
/** Error returned when direct ring-VRF key signing fails. */
export type HostAccountRingVrfSignError = 
/** User is not logged in. */
{
    tag: "NotConnected";
    value?: undefined;
}
/** The key handle is not registered. */
 | {
    tag: "KeyNotRegistered";
    value?: undefined;
}
/** The foreign key owner has not allowlisted the caller. */
 | {
    tag: "NotAllowlisted";
    value?: undefined;
}
/** User or host rejected. */
 | {
    tag: "Rejected";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostAccountRingVrfSignError: S.Codec<HostAccountRingVrfSignError>;
/** Request to sign bytes with a registered ring-VRF key. */
export interface HostAccountRingVrfSignRequest {
    /** Registered key handle. */
    keyHandle: ProductAccountId;
    /** Opaque message to sign. */
    message: HexString;
}
export declare const HostAccountRingVrfSignRequest: S.Codec<HostAccountRingVrfSignRequest>;
/** Error returned when VRF signing fails. */
export type HostAccountSignVrfError = 
/** User is not logged in. */
{
    tag: "NotConnected";
    value?: undefined;
}
/** User or host rejected the signing confirmation. */
 | {
    tag: "Rejected";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostAccountSignVrfError: S.Codec<HostAccountSignVrfError>;
/**
 * Request to produce an sr25519 VRF signature from a product account over a
 * caller-supplied Merlin transcript.
 */
export interface HostAccountSignVrfRequest {
    /** Account whose key signs the VRF. */
    account: ProductAccountId;
    /** Root domain-separation label: `Transcript::new(transcript_label)`. */
    transcriptLabel: HexString;
    /** Transcript items replayed in order as `append_message(label, value)`. */
    items: Array<VrfTranscriptItem>;
}
export declare const HostAccountSignVrfRequest: S.Codec<HostAccountSignVrfRequest>;
/** A chat action received from the host. */
export interface HostChatActionSubscribeItem {
    /** Room where the action occurred. */
    roomId: string;
    /** Peer who initiated the action. */
    peer: string;
    /** The action payload. */
    payload: ChatActionPayload;
}
export declare const HostChatActionSubscribeItem: S.Codec<HostChatActionSubscribeItem>;
/** Chat room registration error. */
export type HostChatCreateRoomError = 
/** Not allowed. */
{
    tag: "PermissionDenied";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostChatCreateRoomError: S.Codec<HostChatCreateRoomError>;
/** Request to create a chat room. */
export interface HostChatCreateRoomRequest {
    /** Unique room identifier. */
    roomId: string;
    /** Room display name. */
    name: string;
    /** URL or base64 image. */
    icon: string;
}
export declare const HostChatCreateRoomRequest: S.Codec<HostChatCreateRoomRequest>;
/** Result of a room registration. */
export interface HostChatCreateRoomResponse {
    /** `New` or `Exists`. */
    status: ChatRoomRegistrationStatus;
}
export declare const HostChatCreateRoomResponse: S.Codec<HostChatCreateRoomResponse>;
/** Item containing the current chat rooms. */
export interface HostChatListSubscribeItem {
    /** Chat rooms the product participates in. */
    rooms: Array<ChatRoom>;
}
export declare const HostChatListSubscribeItem: S.Codec<HostChatListSubscribeItem>;
/** Chat message posting error. */
export type HostChatPostMessageError = 
/** Message exceeded size limit. */
{
    tag: "MessageTooLarge";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostChatPostMessageError: S.Codec<HostChatPostMessageError>;
/** Request to post a message to a chat room. */
export interface HostChatPostMessageRequest {
    /** Room to post to. */
    roomId: string;
    /** Message content. */
    payload: ChatMessageContent;
}
export declare const HostChatPostMessageRequest: S.Codec<HostChatPostMessageRequest>;
/** Result of posting a message. */
export interface HostChatPostMessageResponse {
    /**
     * Host-assigned message id, and the correlation key for any action the
     * message carries: a trigger names it in [`ActionTrigger::message_id`].
     */
    messageId: string;
}
export declare const HostChatPostMessageResponse: S.Codec<HostChatPostMessageResponse>;
/** Chat bot registration error. */
export type HostChatRegisterBotError = 
/** Not allowed. */
{
    tag: "PermissionDenied";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostChatRegisterBotError: S.Codec<HostChatRegisterBotError>;
/** Request to register a chat bot. */
export interface HostChatRegisterBotRequest {
    /** Unique bot identifier. */
    botId: string;
    /** Bot display name. */
    name: string;
    /** URL or base64 image. */
    icon: string;
}
export declare const HostChatRegisterBotRequest: S.Codec<HostChatRegisterBotRequest>;
/** Result of a bot registration. */
export interface HostChatRegisterBotResponse {
    /** `New` or `Exists`. */
    status: ChatBotRegistrationStatus;
}
export declare const HostChatRegisterBotResponse: S.Codec<HostChatRegisterBotResponse>;
/** Request to create a cheque from a local purse to a receivable. */
export interface HostCoinPaymentCreateChequeRequest {
    /** Source purse. */
    from: CoinPaymentPurseId;
    /** Destination receivable. */
    to: CoinPaymentReceivable;
    /** Payment amount. */
    amount: CoinPaymentBalance;
}
export declare const HostCoinPaymentCreateChequeRequest: S.Codec<HostCoinPaymentCreateChequeRequest>;
/** Created cheque response. */
export interface HostCoinPaymentCreateChequeResponse {
    /** Encrypted cheque. */
    cheque: CoinPaymentCheque;
}
export declare const HostCoinPaymentCreateChequeResponse: S.Codec<HostCoinPaymentCreateChequeResponse>;
/** Request to create a new firewalled CoinPayment purse. */
export interface HostCoinPaymentCreatePurseRequest {
    /** Human-readable purse name. */
    name: string;
}
export declare const HostCoinPaymentCreatePurseRequest: S.Codec<HostCoinPaymentCreatePurseRequest>;
/** Created purse identifier. */
export interface HostCoinPaymentCreatePurseResponse {
    /** Assigned purse identifier. */
    purse: CoinPaymentPurseId;
}
export declare const HostCoinPaymentCreatePurseResponse: S.Codec<HostCoinPaymentCreatePurseResponse>;
/** Request to create a fresh receivable for a purse. */
export interface HostCoinPaymentCreateReceivableRequest {
    /** Target purse for future deposits. */
    into: CoinPaymentPurseId;
}
export declare const HostCoinPaymentCreateReceivableRequest: S.Codec<HostCoinPaymentCreateReceivableRequest>;
/** Created receivable response. */
export interface HostCoinPaymentCreateReceivableResponse {
    /** Receivable public key. */
    receivable: CoinPaymentReceivable;
}
export declare const HostCoinPaymentCreateReceivableResponse: S.Codec<HostCoinPaymentCreateReceivableResponse>;
/** Request to delete a purse after draining its balance. */
export interface HostCoinPaymentDeletePurseRequest {
    /** Purse to delete. */
    target: CoinPaymentPurseId;
    /** Purse that receives drained funds. */
    drainInto: CoinPaymentPurseId;
}
export declare const HostCoinPaymentDeletePurseRequest: S.Codec<HostCoinPaymentDeletePurseRequest>;
/** Request to deposit a cheque into the purse associated with its receivable. */
export interface HostCoinPaymentDepositRequest {
    /** Cheque to deposit. */
    cheque: CoinPaymentCheque;
}
export declare const HostCoinPaymentDepositRequest: S.Codec<HostCoinPaymentDepositRequest>;
/** Stream item for `host_coin_payment_listen_for`. */
export type HostCoinPaymentListenForItem = 
/** Handoff channel suitable for inclusion in an invoice. */
{
    tag: "Channel";
    value: CoinPaymentTransmissionChannel;
}
/** Cheque received through the handoff channel. */
 | {
    tag: "Cheque";
    value: CoinPaymentCheque;
};
export declare const HostCoinPaymentListenForItem: S.Codec<HostCoinPaymentListenForItem>;
/** Request to listen for a cheque delivered to a receivable. */
export interface HostCoinPaymentListenForRequest {
    /** Receivable to listen for. */
    receivable: CoinPaymentReceivable;
}
export declare const HostCoinPaymentListenForRequest: S.Codec<HostCoinPaymentListenForRequest>;
/** Request to query product-visible purse metadata. */
export interface HostCoinPaymentQueryPurseRequest {
    /** Purse to query. */
    purse: CoinPaymentPurseId;
}
export declare const HostCoinPaymentQueryPurseRequest: S.Codec<HostCoinPaymentQueryPurseRequest>;
/** Product-visible purse metadata response. */
export interface HostCoinPaymentQueryPurseResponse {
    /** Purse information. */
    info: CoinPaymentPurseInfo;
}
export declare const HostCoinPaymentQueryPurseResponse: S.Codec<HostCoinPaymentQueryPurseResponse>;
/** Request to transfer balance between local purses. */
export interface HostCoinPaymentRebalancePurseRequest {
    /** Source purse. */
    from: CoinPaymentPurseId;
    /** Destination purse. */
    to: CoinPaymentPurseId;
    /** Amount to move. */
    amount: CoinPaymentBalance;
}
export declare const HostCoinPaymentRebalancePurseRequest: S.Codec<HostCoinPaymentRebalancePurseRequest>;
/** Request to refund coins associated with a receivable. */
export interface HostCoinPaymentRefundRequest {
    /** Receivable to refund. */
    receivable: CoinPaymentReceivable;
}
export declare const HostCoinPaymentRefundRequest: S.Codec<HostCoinPaymentRefundRequest>;
/** Transaction creation error. */
export type HostCreateTransactionError = 
/** Payload could not be deserialized. */
{
    tag: "FailedToDecode";
    value?: undefined;
}
/** User rejected. */
 | {
    tag: "Rejected";
    value?: undefined;
}
/** Unsupported payload version or extension. */
 | {
    tag: "NotSupported";
    value: {
        reason: string;
    };
}
/** Not authenticated. */
 | {
    tag: "PermissionDenied";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostCreateTransactionError: S.Codec<HostCreateTransactionError>;
/** Response containing a created transaction. */
export interface HostCreateTransactionResponse {
    /**
     * SCALE-encoded transaction, signed unless the request supplied its own
     * V5 `VerifyMultiSignature` extension.
     */
    transaction: HexString;
}
export declare const HostCreateTransactionResponse: S.Codec<HostCreateTransactionResponse>;
/** Response containing a transaction created with a non-product account. */
export interface HostCreateTransactionWithLegacyAccountResponse {
    /**
     * SCALE-encoded transaction, signed unless the request supplied its own
     * V5 `VerifyMultiSignature` extension.
     */
    transaction: HexString;
}
export declare const HostCreateTransactionWithLegacyAccountResponse: S.Codec<HostCreateTransactionWithLegacyAccountResponse>;
/** Error from [`crate::api::Entropy::derive`] (RFC 0007). */
export type HostDeriveEntropyError = 
/** Catch-all. */
{
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostDeriveEntropyError: S.Codec<HostDeriveEntropyError>;
/**
 * Request to derive deterministic per-product entropy (RFC 0007).
 *
 * The host derives 32 bytes from product-scoped seed material and `context`.
 * Repeated calls with the same `context` for the same product yield the same
 * entropy.
 */
export interface HostDeriveEntropyRequest {
    /** Domain-separated derivation context. */
    context: HexString;
}
export declare const HostDeriveEntropyRequest: S.Codec<HostDeriveEntropyRequest>;
/** Response carrying 32 bytes of deterministically derived entropy. */
export interface HostDeriveEntropyResponse {
    /** 32 bytes of derived entropy. */
    entropy: HexString;
}
export declare const HostDeriveEntropyResponse: S.Codec<HostDeriveEntropyResponse>;
/**
 * Device-capability permission requested from the host (RFC 0002).
 *
 * The user's decision is persisted indefinitely after the first prompt and
 * survives app restarts, whether the decision was grant or deny; the host
 * does not re-prompt on subsequent requests for the same capability.
 *
 * That decision is about this product. The OS grant behind it belongs to the
 * host application and can move independently, so a host that can read OS
 * state has the capability resolve only while both allow it: a stored grant
 * whose OS grant was revoked answers `granted: false` without a prompt. An OS
 * grant that is merely undetermined does not change the answer, because the OS
 * resolves its own gate when the capability is used.
 */
export type HostDevicePermissionRequest = "Notifications" | "Camera" | "Microphone" | "Bluetooth" | "NFC" | "Location" | "Clipboard" | "OpenUrl" | "Biometrics";
export declare const HostDevicePermissionRequest: S.Codec<HostDevicePermissionRequest>;
/** Outcome of a device-permission request. */
export interface HostDevicePermissionResponse {
    /** Whether the permission was granted. */
    granted: boolean;
}
export declare const HostDevicePermissionResponse: S.Codec<HostDevicePermissionResponse>;
/** Request to query whether a feature is supported by the host. */
export type HostFeatureSupportedRequest = 
/** Ask whether the host can interact with the chain identified by genesis hash. */
{
    tag: "Chain";
    value: {
        genesisHash: HexString;
    };
};
export declare const HostFeatureSupportedRequest: S.Codec<HostFeatureSupportedRequest>;
/** Response to a feature-support query. */
export interface HostFeatureSupportedResponse {
    /** Whether the feature is supported. */
    supported: boolean;
}
export declare const HostFeatureSupportedResponse: S.Codec<HostFeatureSupportedResponse>;
/** Response containing all legacy (user-imported) accounts owned by the user. */
export interface HostGetLegacyAccountsResponse {
    /** Legacy accounts. */
    accounts: Array<LegacyAccount>;
}
export declare const HostGetLegacyAccountsResponse: S.Codec<HostGetLegacyAccountsResponse>;
/** Response containing the product context bound to the current host runtime. */
export interface HostGetProductContextResponse {
    /** Full canonical identifier used for authorization and account derivation. */
    productId: string;
}
export declare const HostGetProductContextResponse: S.Codec<HostGetProductContextResponse>;
/** Error from [`crate::api::Account::get_user_id`]. */
export type HostGetUserIdError = 
/** User denied the identity disclosure request. */
{
    tag: "PermissionDenied";
    value?: undefined;
}
/** User is not logged in. */
 | {
    tag: "NotConnected";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostGetUserIdError: S.Codec<HostGetUserIdError>;
/** The user's primary DotNS account identity. */
export interface HostGetUserIdResponse {
    /** The user's primary DotNS username. */
    primaryUsername: string;
}
export declare const HostGetUserIdResponse: S.Codec<HostGetUserIdResponse>;
/**
 * Error from [`crate::api::System::handshake`] (RFC 0009).
 *
 * The handshake is the first call on a fresh connection; it does not require
 * user authentication and is used to negotiate the wire codec version.
 */
export type HostHandshakeError = 
/** Host did not complete the handshake in time. */
{
    tag: "Timeout";
    value?: undefined;
}
/** Host does not speak the codec version requested by the product. */
 | {
    tag: "UnsupportedProtocolVersion";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: GenericError;
};
export declare const HostHandshakeError: S.Codec<HostHandshakeError>;
/** Wire-codec negotiation payload sent by the product (RFC 0009). */
export interface HostHandshakeRequest {
    /** Wire codec version requested by the product. */
    codecVersion: number;
}
export declare const HostHandshakeRequest: S.Codec<HostHandshakeRequest>;
/** Request to clear a local storage key. */
export interface HostLocalStorageClearRequest {
    /** Storage key to clear. */
    key: string;
}
export declare const HostLocalStorageClearRequest: S.Codec<HostLocalStorageClearRequest>;
/** Local storage operation error. */
export type HostLocalStorageReadError = 
/** Storage quota exceeded. */
{
    tag: "Full";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostLocalStorageReadError: S.Codec<HostLocalStorageReadError>;
/** Request to read a local storage value. */
export interface HostLocalStorageReadRequest {
    /** Storage key to read. */
    key: string;
}
export declare const HostLocalStorageReadRequest: S.Codec<HostLocalStorageReadRequest>;
/** Response containing an optional local storage value. */
export interface HostLocalStorageReadResponse {
    /** Stored value, if present. */
    value?: HexString;
}
export declare const HostLocalStorageReadResponse: S.Codec<HostLocalStorageReadResponse>;
/** Request to write a value into local storage. */
export interface HostLocalStorageWriteRequest {
    /** Storage key to write. */
    key: string;
    /** Value to store at the key. */
    value: HexString;
}
export declare const HostLocalStorageWriteRequest: S.Codec<HostLocalStorageWriteRequest>;
/** Locale the host currently presents its interface in, pushed to subscribers. */
export interface HostLocaleSubscribeItem {
    /**
     * BCP 47 language tag, such as `en`, `pt-BR` or `zh-Hans`. The set is
     * open: a product that does not ship the tag chooses its own fallback.
     */
    languageTag: string;
}
export declare const HostLocaleSubscribeItem: S.Codec<HostLocaleSubscribeItem>;
/** Error from [`crate::api::System::navigate_to`]. */
export type HostNavigateToError = 
/**
 * The target host is not authorized for outbound access: the user answered
 * no to the prompt, a stored decision already refused it, or no prompt
 * could be put to the user.
 */
{
    tag: "PermissionDenied";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostNavigateToError: S.Codec<HostNavigateToError>;
/** Request to navigate the host to an external URL. */
export interface HostNavigateToRequest {
    /** URL to open. */
    url: string;
}
export declare const HostNavigateToRequest: S.Codec<HostNavigateToRequest>;
/**
 * Error from [`crate::api::Payment::balance_subscribe`].
 *
 * See [RFC 0006].
 *
 * [RFC 0006]: https://github.com/paritytech/triangle-js-sdks/pull/94
 */
export type HostPaymentBalanceSubscribeError = 
/** User denied the balance disclosure request. */
{
    tag: "PermissionDenied";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostPaymentBalanceSubscribeError: S.Codec<HostPaymentBalanceSubscribeError>;
/**
 * Current payment balance state pushed to subscribers.
 *
 * See [RFC 0006].
 *
 * [RFC 0006]: https://github.com/paritytech/triangle-js-sdks/pull/94
 */
export interface HostPaymentBalanceSubscribeItem {
    /** Balance that can be spent right now. */
    available: Balance;
}
export declare const HostPaymentBalanceSubscribeItem: S.Codec<HostPaymentBalanceSubscribeItem>;
/** Request to subscribe to payment balance updates. */
export interface HostPaymentBalanceSubscribeRequest {
    /** Optional purse selector. `None` means MAIN_PURSE. */
    purse?: CoinPaymentPurseId;
}
export declare const HostPaymentBalanceSubscribeRequest: S.Codec<HostPaymentBalanceSubscribeRequest>;
/**
 * Error from [`crate::api::Payment::request`].
 *
 * See [RFC 0006].
 *
 * [RFC 0006]: https://github.com/paritytech/triangle-js-sdks/pull/94
 */
export type HostPaymentError = 
/** User rejected the payment request. */
{
    tag: "Rejected";
    value?: undefined;
}
/** User's available balance is not sufficient for the requested amount. */
 | {
    tag: "InsufficientBalance";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostPaymentError: S.Codec<HostPaymentError>;
/** Request to initiate a payment to another account. */
export interface HostPaymentRequest {
    /** Optional purse selector. `None` means MAIN_PURSE. */
    from?: CoinPaymentPurseId;
    /** Amount to pay. */
    amount: Balance;
    /** Destination account. */
    destination: HexString;
}
export declare const HostPaymentRequest: S.Codec<HostPaymentRequest>;
/**
 * Receipt returned after a successful payment request.
 *
 * See [RFC 0006].
 *
 * [RFC 0006]: https://github.com/paritytech/triangle-js-sdks/pull/94
 */
export interface HostPaymentResponse {
    /** The assigned payment identifier. */
    id: string;
}
export declare const HostPaymentResponse: S.Codec<HostPaymentResponse>;
/**
 * Error from [`crate::api::Payment::status_subscribe`].
 *
 * See [RFC 0006].
 *
 * [RFC 0006]: https://github.com/paritytech/triangle-js-sdks/pull/94
 */
export type HostPaymentStatusSubscribeError = 
/** Payment ID was not found or does not belong to the current product. */
{
    tag: "PaymentNotFound";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostPaymentStatusSubscribeError: S.Codec<HostPaymentStatusSubscribeError>;
/**
 * Payment lifecycle status pushed to subscribers.
 *
 * Once a terminal state (`Completed` or `Failed`) is reached, the host
 * delivers it and may close the subscription.
 *
 * See [RFC 0006].
 *
 * [RFC 0006]: https://github.com/paritytech/triangle-js-sdks/pull/94
 */
export type HostPaymentStatusSubscribeItem = 
/** Payment is being processed. */
{
    tag: "Processing";
    value?: undefined;
}
/** Payment has been settled successfully. */
 | {
    tag: "Completed";
    value?: undefined;
}
/** Payment has failed. */
 | {
    tag: "Failed";
    value: {
        reason: string;
    };
};
export declare const HostPaymentStatusSubscribeItem: S.Codec<HostPaymentStatusSubscribeItem>;
/** Request to subscribe to a payment status. */
export interface HostPaymentStatusSubscribeRequest {
    /** Payment identifier to watch. */
    paymentId: string;
}
export declare const HostPaymentStatusSubscribeRequest: S.Codec<HostPaymentStatusSubscribeRequest>;
/**
 * Error from [`crate::api::Payment::top_up`].
 *
 * See [RFC 0006].
 *
 * [RFC 0006]: https://github.com/paritytech/triangle-js-sdks/pull/94
 */
export type HostPaymentTopUpError = 
/** The source account does not hold sufficient funds. */
{
    tag: "InsufficientFunds";
    value?: undefined;
}
/** The source account was not found or is invalid. */
 | {
    tag: "InvalidSource";
    value?: undefined;
}
/** Some coins were claimed but the total fell short of the requested amount. */
 | {
    tag: "PartialPayment";
    value: {
        credited: Balance;
    };
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostPaymentTopUpError: S.Codec<HostPaymentTopUpError>;
/** Request to top up the product payment balance. */
export interface HostPaymentTopUpRequest {
    /** Optional purse selector. `None` means MAIN_PURSE. */
    into?: CoinPaymentPurseId;
    /** Amount to top up. */
    amount: Balance;
    /** Funding source for the top-up. */
    source: PaymentTopUpSource;
}
export declare const HostPaymentTopUpRequest: S.Codec<HostPaymentTopUpRequest>;
/** Product-device Chat v2 identity failure. */
export type HostProductDeviceChatError = 
/** No account-authority session is connected. */
{
    tag: "NotConnected";
    value?: undefined;
}
/** The user or Host rejected the operation. */
 | {
    tag: "Rejected";
    value?: undefined;
}
/** The peer X25519 public key is invalid. */
 | {
    tag: "InvalidPeerKey";
    value?: undefined;
}
/** The ciphertext failed structural or authentication checks. */
 | {
    tag: "InvalidCiphertext";
    value?: undefined;
}
/** The Host could not complete the operation. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostProductDeviceChatError: S.Codec<HostProductDeviceChatError>;
/**
 * Product-device Chat v2 identity operation.
 *
 * The wallet Chat identity secret and derived shared key remain host-private.
 */
export type HostProductDeviceChatRequest = 
/** Resolve the product account as a Chat device and bind it to the wallet identity. */
{
    tag: "Bind";
    value: {
        productAccountId: ProductAccountId;
        peerIdentityAccountId: HexString;
        peerChatPublicKey: HexString;
    };
}
/** Seal identity-route plaintext for the peer with a host-generated nonce. */
 | {
    tag: "Seal";
    value: {
        productAccountId: ProductAccountId;
        peerChatPublicKey: HexString;
        plaintext: HexString;
    };
}
/** Open an identity-route combined nonce/ciphertext/tag value. */
 | {
    tag: "Open";
    value: {
        productAccountId: ProductAccountId;
        peerChatPublicKey: HexString;
        combinedCiphertext: HexString;
    };
};
export declare const HostProductDeviceChatRequest: S.Codec<HostProductDeviceChatRequest>;
/** Result of a product-device Chat v2 identity operation. */
export type HostProductDeviceChatResponse = 
/** Wallet identity binding and deterministic peer routes. */
{
    tag: "IdentityBinding";
    value: {
        identityAccountId: HexString;
        proof: HexString;
        walletOwnSessionId: HexString;
        peerOwnSessionId: HexString;
        walletOutgoingChannelId: HexString;
        walletIncomingChannelId: HexString;
    };
}
/** Sealed identity-route payload. */
 | {
    tag: "Sealed";
    value: {
        combinedCiphertext: HexString;
    };
}
/** Opened identity-route payload. */
 | {
    tag: "Opened";
    value: {
        plaintext: HexString;
    };
};
export declare const HostProductDeviceChatResponse: S.Codec<HostProductDeviceChatResponse>;
/** Request to cancel a previously scheduled notification. */
export interface HostPushNotificationCancelRequest {
    /** The notification identifier returned by [`HostPushNotificationResponse`]. */
    id: NotificationId;
}
export declare const HostPushNotificationCancelRequest: S.Codec<HostPushNotificationCancelRequest>;
/** Push notification error. */
export type HostPushNotificationError = 
/** The host-wide queue of pending scheduled notifications is full. */
{
    tag: "ScheduleLimitReached";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostPushNotificationError: S.Codec<HostPushNotificationError>;
/**
 * Push notification payload.
 *
 * When `scheduled_at` is `Some`, the notification is deferred to the given
 * wall-clock instant (Unix milliseconds UTC). `None` fires immediately,
 * preserving prior behaviour. See [RFC 0019].
 *
 * [RFC 0019]: https://github.com/paritytech/host-rust-core/blob/main/docs/rfcs/0019-scheduled-notifications.md
 */
export interface HostPushNotificationRequest {
    /** Notification text. */
    text: string;
    /** Optional URL to open on tap. */
    deeplink?: string;
    /**
     * Optional Unix timestamp in milliseconds (UTC) at which the notification
     * should fire. `None` fires immediately.
     */
    scheduledAt?: bigint;
}
export declare const HostPushNotificationRequest: S.Codec<HostPushNotificationRequest>;
/** Successful push notification response carrying the assigned id. */
export interface HostPushNotificationResponse {
    /** Host-assigned notification identifier. */
    id: NotificationId;
}
export declare const HostPushNotificationResponse: S.Codec<HostPushNotificationResponse>;
/** Login request error. */
export type HostRequestLoginError = 
/** Catch-all. */
{
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostRequestLoginError: S.Codec<HostRequestLoginError>;
/** Request to present the host login flow. */
export interface HostRequestLoginRequest {
    /** Optional human-readable reason shown in the login UI. */
    reason?: string;
}
export declare const HostRequestLoginRequest: S.Codec<HostRequestLoginRequest>;
/** Result of a login request. */
export type HostRequestLoginResponse = "Success" | "AlreadyConnected" | "Rejected";
export declare const HostRequestLoginResponse: S.Codec<HostRequestLoginResponse>;
/** Batched resource pre-allocation request (RFC 0010). */
export interface HostRequestResourceAllocationRequest {
    /** Resources to allocate. */
    resources: Array<AllocatableResource>;
}
export declare const HostRequestResourceAllocationRequest: S.Codec<HostRequestResourceAllocationRequest>;
/** Per-resource outcomes for a batched allocation request (RFC 0010). */
export interface HostRequestResourceAllocationResponse {
    /** Per-resource allocation outcomes, in the same order as the request. */
    outcomes: Array<AllocationOutcome>;
}
export declare const HostRequestResourceAllocationResponse: S.Codec<HostRequestResourceAllocationResponse>;
/** Signing operation error. */
export type HostSignPayloadError = 
/** Payload could not be deserialized. */
{
    tag: "FailedToDecode";
    value?: undefined;
}
/** User rejected signing. */
 | {
    tag: "Rejected";
    value?: undefined;
}
/** Not authenticated. */
 | {
    tag: "PermissionDenied";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const HostSignPayloadError: S.Codec<HostSignPayloadError>;
/** Request to sign an extrinsic payload with a product account. */
export interface HostSignPayloadRequest {
    /** Product account that will sign this payload. */
    account: ProductAccountId;
    /** The extrinsic payload to sign. */
    payload: HostSignPayloadData;
}
export declare const HostSignPayloadRequest: S.Codec<HostSignPayloadRequest>;
/** Result of a signing operation. */
export interface HostSignPayloadResponse {
    /** The cryptographic signature. */
    signature: HexString;
    /** Full signed transaction, if requested. */
    signedTransaction?: HexString;
}
export declare const HostSignPayloadResponse: S.Codec<HostSignPayloadResponse>;
/**
 * Sign a Substrate extrinsic payload with a non-product (legacy) account.
 * Contains the same fields as [`HostSignPayloadRequest`] minus `address`
 * (replaced by `signer`).
 */
export interface HostSignPayloadWithLegacyAccountRequest {
    /** Signer address (SS58 or hex) of the legacy account. */
    signer: string;
    /** The extrinsic payload to sign. */
    payload: HostSignPayloadData;
}
export declare const HostSignPayloadWithLegacyAccountRequest: S.Codec<HostSignPayloadWithLegacyAccountRequest>;
/** A raw signing request pairing an account with the payload to sign. */
export interface HostSignRawRequest {
    /** Product account that will sign this payload. */
    account: ProductAccountId;
    /** The payload to sign. */
    payload: RawPayload;
}
export declare const HostSignRawRequest: S.Codec<HostSignRawRequest>;
/**
 * Sign raw bytes with a non-product (legacy) account. The signer field
 * identifies which legacy account to use.
 */
export interface HostSignRawWithLegacyAccountRequest {
    /** Signer address (SS58 or hex) of the legacy account. */
    signer: string;
    /** The data to sign. */
    payload: RawPayload;
}
export declare const HostSignRawWithLegacyAccountRequest: S.Codec<HostSignRawWithLegacyAccountRequest>;
/** Current theme state pushed to subscribers. */
export interface HostThemeSubscribeItem {
    /** Theme name. */
    name: ThemeName;
    /** Light or dark variant. */
    variant: ThemeVariant;
}
export declare const HostThemeSubscribeItem: S.Codec<HostThemeSubscribeItem>;
/** Render work sent by the host when a native custom-message cell appears. */
export interface ProductChatCustomMessageRenderRequest {
    /** Stable identifier used to correlate triggered actions. */
    messageId: string;
    /** Product-defined discriminator used to select a renderer. */
    messageType: string;
    /** Stored product-defined message payload. */
    payload: HexString;
}
export declare const ProductChatCustomMessageRenderRequest: S.Codec<ProductChatCustomMessageRenderRequest>;
/** Request to fetch the body of a pinned block. */
export interface RemoteChainHeadBodyRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
    /** Follow subscription identifier. */
    followSubscriptionId: string;
    /** Block hash. */
    hash: HexString;
}
export declare const RemoteChainHeadBodyRequest: S.Codec<RemoteChainHeadBodyRequest>;
/** Response to a body request; results arrive as follow events. */
export interface RemoteChainHeadBodyResponse {
    /** Started operation result. */
    operation: OperationStartedResult;
}
export declare const RemoteChainHeadBodyResponse: S.Codec<RemoteChainHeadBodyResponse>;
/** Request to invoke a runtime call at a pinned block. */
export interface RemoteChainHeadCallRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
    /** Follow subscription identifier. */
    followSubscriptionId: string;
    /** Block hash. */
    hash: HexString;
    /** Runtime API function name. */
    function: string;
    /** SCALE-encoded call parameters. */
    callParameters: HexString;
}
export declare const RemoteChainHeadCallRequest: S.Codec<RemoteChainHeadCallRequest>;
/** Response to a runtime call request; the output arrives as a follow event. */
export interface RemoteChainHeadCallResponse {
    /** Started operation result. */
    operation: OperationStartedResult;
}
export declare const RemoteChainHeadCallResponse: S.Codec<RemoteChainHeadCallResponse>;
/** Request to continue a paused chain-head operation. */
export interface RemoteChainHeadContinueRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
    /** Follow subscription identifier. */
    followSubscriptionId: string;
    /** Operation identifier. */
    operationId: string;
}
export declare const RemoteChainHeadContinueRequest: S.Codec<RemoteChainHeadContinueRequest>;
/** Event emitted on a chain-head follow subscription. */
export type RemoteChainHeadFollowItem = 
/** First event of the subscription, describing the current finalized blocks. */
{
    tag: "Initialized";
    value: {
        finalizedBlockHashes: Array<HexString>;
        finalizedBlockRuntime?: RuntimeType;
    };
}
/** A new non-finalized block was announced. */
 | {
    tag: "NewBlock";
    value: {
        blockHash: HexString;
        parentBlockHash: HexString;
        newRuntime?: RuntimeType;
    };
}
/** The best block has changed. */
 | {
    tag: "BestBlockChanged";
    value: {
        bestBlockHash: HexString;
    };
}
/** One or more blocks were finalized. */
 | {
    tag: "Finalized";
    value: {
        finalizedBlockHashes: Array<HexString>;
        prunedBlockHashes: Array<HexString>;
    };
}
/** A body operation completed. */
 | {
    tag: "OperationBodyDone";
    value: {
        operationId: string;
        value: Array<HexString>;
    };
}
/** A runtime call operation completed. */
 | {
    tag: "OperationCallDone";
    value: {
        operationId: string;
        output: HexString;
    };
}
/** A storage operation produced a batch of results. */
 | {
    tag: "OperationStorageItems";
    value: {
        operationId: string;
        items: Array<StorageResultItem>;
    };
}
/** A storage operation finished emitting results. */
 | {
    tag: "OperationStorageDone";
    value: {
        operationId: string;
    };
}
/** A storage operation is paused until the product requests continuation. */
 | {
    tag: "OperationWaitingForContinue";
    value: {
        operationId: string;
    };
}
/** The operation failed because the required data was not accessible; it can be retried. */
 | {
    tag: "OperationInaccessible";
    value: {
        operationId: string;
    };
}
/** The operation failed with an error. */
 | {
    tag: "OperationError";
    value: {
        operationId: string;
        error: string;
    };
}
/** The subscription was stopped by the host and is no longer valid. */
 | {
    tag: "Stop";
    value?: undefined;
};
export declare const RemoteChainHeadFollowItem: S.Codec<RemoteChainHeadFollowItem>;
/** Request to start a chain-head follow subscription. */
export interface RemoteChainHeadFollowRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
    /** Whether to include runtime information in events. */
    withRuntime: boolean;
}
export declare const RemoteChainHeadFollowRequest: S.Codec<RemoteChainHeadFollowRequest>;
/** Request to fetch the header of a pinned block. */
export interface RemoteChainHeadHeaderRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
    /** Follow subscription identifier. */
    followSubscriptionId: string;
    /** Block hash. */
    hash: HexString;
}
export declare const RemoteChainHeadHeaderRequest: S.Codec<RemoteChainHeadHeaderRequest>;
/** Response containing the requested block header. */
export interface RemoteChainHeadHeaderResponse {
    /** SCALE-encoded block header. */
    header?: HexString;
}
export declare const RemoteChainHeadHeaderResponse: S.Codec<RemoteChainHeadHeaderResponse>;
/** Request to stop an in-progress chain-head operation. */
export interface RemoteChainHeadStopOperationRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
    /** Follow subscription identifier. */
    followSubscriptionId: string;
    /** Operation identifier. */
    operationId: string;
}
export declare const RemoteChainHeadStopOperationRequest: S.Codec<RemoteChainHeadStopOperationRequest>;
/** Request to query storage at a pinned block. */
export interface RemoteChainHeadStorageRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
    /** Follow subscription identifier. */
    followSubscriptionId: string;
    /** Block hash. */
    hash: HexString;
    /** Storage items to query. */
    items: Array<StorageQueryItem>;
    /** Optional child trie. */
    childTrie?: HexString;
}
export declare const RemoteChainHeadStorageRequest: S.Codec<RemoteChainHeadStorageRequest>;
/** Response to a storage request; results arrive as follow events. */
export interface RemoteChainHeadStorageResponse {
    /** Started operation result. */
    operation: OperationStartedResult;
}
export declare const RemoteChainHeadStorageResponse: S.Codec<RemoteChainHeadStorageResponse>;
/** Request to release pinned blocks. */
export interface RemoteChainHeadUnpinRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
    /** Follow subscription identifier. */
    followSubscriptionId: string;
    /** Block hashes to unpin. */
    hashes: Array<HexString>;
}
export declare const RemoteChainHeadUnpinRequest: S.Codec<RemoteChainHeadUnpinRequest>;
/** Error from [`crate::api::Chain::get_chain_info`]. */
export type RemoteChainInfoError = 
/** The host does not serve the requested chain. */
{
    tag: "NotSupported";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: GenericError;
};
export declare const RemoteChainInfoError: S.Codec<RemoteChainInfoError>;
/** Request to resolve one chain identifier against the host's environment. */
export interface RemoteChainInfoRequest {
    /** Chain to resolve. */
    chain: ChainIdentifier;
}
export declare const RemoteChainInfoRequest: S.Codec<RemoteChainInfoRequest>;
/** Response carrying the resolved chain data. */
export interface RemoteChainInfoResponse {
    /** Ecosystem the host is configured for, e.g. "polkadot", "kusama", "paseo". */
    network: string;
    /** Chain this response resolves, echoed from the request. */
    chain: ChainIdentifier;
    /** Genesis hash identifying the chain in all chain-scoped calls. */
    genesisHash: HexString;
}
export declare const RemoteChainInfoResponse: S.Codec<RemoteChainInfoResponse>;
/** Request for the display name of a chain. */
export interface RemoteChainSpecChainNameRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
}
export declare const RemoteChainSpecChainNameRequest: S.Codec<RemoteChainSpecChainNameRequest>;
/** Response containing the chain display name. */
export interface RemoteChainSpecChainNameResponse {
    /** Chain display name. */
    chainName: string;
}
export declare const RemoteChainSpecChainNameResponse: S.Codec<RemoteChainSpecChainNameResponse>;
/** Request for the canonical genesis hash of a chain. */
export interface RemoteChainSpecGenesisHashRequest {
    /** Chain genesis hash requested by the product. */
    genesisHash: HexString;
}
export declare const RemoteChainSpecGenesisHashRequest: S.Codec<RemoteChainSpecGenesisHashRequest>;
/** Response containing the canonical genesis hash. */
export interface RemoteChainSpecGenesisHashResponse {
    /** Chain genesis hash. */
    genesisHash: HexString;
}
export declare const RemoteChainSpecGenesisHashResponse: S.Codec<RemoteChainSpecGenesisHashResponse>;
/** Request for the JSON-encoded properties of a chain. */
export interface RemoteChainSpecPropertiesRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
}
export declare const RemoteChainSpecPropertiesRequest: S.Codec<RemoteChainSpecPropertiesRequest>;
/** Response containing the chain properties. */
export interface RemoteChainSpecPropertiesResponse {
    /** JSON-encoded properties. */
    properties: string;
}
export declare const RemoteChainSpecPropertiesResponse: S.Codec<RemoteChainSpecPropertiesResponse>;
/** Request to broadcast a signed transaction. */
export interface RemoteChainTransactionBroadcastRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
    /** Signed transaction bytes. */
    transaction: HexString;
}
export declare const RemoteChainTransactionBroadcastRequest: S.Codec<RemoteChainTransactionBroadcastRequest>;
/** Response to a transaction broadcast request. */
export interface RemoteChainTransactionBroadcastResponse {
    /** Broadcast operation identifier, if available. */
    operationId?: string;
}
export declare const RemoteChainTransactionBroadcastResponse: S.Codec<RemoteChainTransactionBroadcastResponse>;
/** Request to stop broadcasting a transaction. */
export interface RemoteChainTransactionStopRequest {
    /** Chain genesis hash. */
    genesisHash: HexString;
    /** Operation identifier of the broadcast to stop. */
    operationId: string;
}
export declare const RemoteChainTransactionStopRequest: S.Codec<RemoteChainTransactionStopRequest>;
/** remote-permission request (RFC 0002). */
export interface RemotePermissionRequest {
    /** Permission requested by the product. */
    permission: RemotePermission;
}
export declare const RemotePermissionRequest: S.Codec<RemotePermissionRequest>;
/** Outcome of a remote-permission request. */
export interface RemotePermissionResponse {
    /** Whether the permission was granted. */
    granted: boolean;
}
export declare const RemotePermissionResponse: S.Codec<RemotePermissionResponse>;
/** Item containing an optional preimage lookup result. */
export interface RemotePreimageLookupSubscribeItem {
    /** Preimage data, if found. */
    value?: HexString;
}
export declare const RemotePreimageLookupSubscribeItem: S.Codec<RemotePreimageLookupSubscribeItem>;
/** Request to subscribe to preimage lookup results. */
export interface RemotePreimageLookupSubscribeRequest {
    /** Hash of the preimage. */
    key: HexString;
}
export declare const RemotePreimageLookupSubscribeRequest: S.Codec<RemotePreimageLookupSubscribeRequest>;
/** Statement proof creation error. */
export type RemoteStatementStoreCreateProofError = 
/** Signing operation failed. */
{
    tag: "UnableToSign";
    value?: undefined;
}
/** Account not recognized. */
 | {
    tag: "UnknownAccount";
    value?: undefined;
}
/** Catch-all. */
 | {
    tag: "Unknown";
    value: {
        reason: string;
    };
};
export declare const RemoteStatementStoreCreateProofError: S.Codec<RemoteStatementStoreCreateProofError>;
/** Request to create a cryptographic proof for a statement. */
export interface RemoteStatementStoreCreateProofRequest {
    /** Product account that should create the proof. */
    productAccountId: ProductAccountId;
    /** Statement to prove. */
    statement: Statement;
}
export declare const RemoteStatementStoreCreateProofRequest: S.Codec<RemoteStatementStoreCreateProofRequest>;
/** Response containing a statement proof. */
export interface RemoteStatementStoreCreateProofResponse {
    /** Created statement proof. */
    proof: StatementProof;
}
export declare const RemoteStatementStoreCreateProofResponse: S.Codec<RemoteStatementStoreCreateProofResponse>;
/**
 * Page of signed statements delivered by the statement store subscription
 * (RFC 0008). The `is_complete` flag distinguishes the historical-dump phase
 * (`false`) from the live-update phase (`true`).
 */
export interface RemoteStatementStoreSubscribeItem {
    /** Signed statements matching the subscription. */
    statements: Array<SignedStatement>;
    /**
     * `false` while the host is still streaming the historical dump (more
     * pages to follow). `true` once the dump is complete; all subsequent
     * pages are also `true` and carry only newly-arrived statements.
     */
    isComplete: boolean;
}
export declare const RemoteStatementStoreSubscribeItem: S.Codec<RemoteStatementStoreSubscribeItem>;
/** Request to subscribe to statements via a topic filter (RFC 0008). */
export type RemoteStatementStoreSubscribeRequest = 
/** AND: statement must contain every listed topic. */
{
    tag: "MatchAll";
    value: Array<Topic>;
}
/** OR: statement must contain at least one listed topic. */
 | {
    tag: "MatchAny";
    value: Array<Topic>;
};
export declare const RemoteStatementStoreSubscribeRequest: S.Codec<RemoteStatementStoreSubscribeRequest>;
/** Vertical alignment options. */
export type VerticalAlignment = "Top" | "Center" | "Bottom";
export declare const VerticalAlignment: S.Codec<VerticalAlignment>;
/** An sr25519 (schnorrkel) VRF signature: the VRF pre-output and its proof. */
export interface VrfSignature {
    /** schnorrkel `VRFPreOut` — the 32-byte VRF output point. */
    preOutput: HexString;
    /** schnorrkel `VRFProof` — the 64-byte DLEQ proof. */
    proof: HexString;
}
export declare const VrfSignature: S.Codec<VrfSignature>;
/** One `append_message` call replayed against the signing transcript. */
export interface VrfTranscriptItem {
    /** Merlin `append_message` label. */
    label: HexString;
    /** Merlin `append_message` value. */
    value: HexString;
}
export declare const VrfTranscriptItem: S.Codec<VrfTranscriptItem>;
