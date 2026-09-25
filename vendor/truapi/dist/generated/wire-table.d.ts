export declare const SYSTEM_HANDSHAKE: {
    readonly trait: 1;
    readonly method: 0;
    readonly kind: "request";
};
export declare const SYSTEM_FEATURE_SUPPORTED: {
    readonly trait: 1;
    readonly method: 1;
    readonly kind: "request";
};
export declare const SYSTEM_NAVIGATE_TO: {
    readonly trait: 1;
    readonly method: 2;
    readonly kind: "request";
};
export declare const SYSTEM_HOST_INFO: {
    readonly trait: 1;
    readonly method: 3;
    readonly kind: "request";
};
export declare const SYSTEM_GET_PRODUCT_CONTEXT: {
    readonly trait: 1;
    readonly method: 4;
    readonly kind: "request";
};
export declare const ACCOUNT_CONNECTION_STATUS_SUBSCRIBE: {
    readonly trait: 2;
    readonly method: 0;
    readonly kind: "subscription";
};
export declare const ACCOUNT_GET_ACCOUNT: {
    readonly trait: 2;
    readonly method: 1;
    readonly kind: "request";
};
export declare const ACCOUNT_GET_ACCOUNT_ALIAS: {
    readonly trait: 2;
    readonly method: 2;
    readonly kind: "request";
};
export declare const ACCOUNT_CREATE_ACCOUNT_PROOF: {
    readonly trait: 2;
    readonly method: 3;
    readonly kind: "request";
};
export declare const ACCOUNT_GET_LEGACY_ACCOUNTS: {
    readonly trait: 2;
    readonly method: 4;
    readonly kind: "request";
};
export declare const ACCOUNT_GET_USER_ID: {
    readonly trait: 2;
    readonly method: 5;
    readonly kind: "request";
};
export declare const ACCOUNT_REQUEST_LOGIN: {
    readonly trait: 2;
    readonly method: 6;
    readonly kind: "request";
};
export declare const ACCOUNT_SIGN_VRF: {
    readonly trait: 2;
    readonly method: 7;
    readonly kind: "request";
};
export declare const ACCOUNT_REGISTER_RING_VRF_KEY: {
    readonly trait: 2;
    readonly method: 8;
    readonly kind: "request";
};
export declare const ACCOUNT_LIST_RING_VRF_KEYS: {
    readonly trait: 2;
    readonly method: 9;
    readonly kind: "request";
};
export declare const ACCOUNT_RING_VRF_SIGN: {
    readonly trait: 2;
    readonly method: 10;
    readonly kind: "request";
};
export declare const CHAIN_FOLLOW_HEAD_SUBSCRIBE: {
    readonly trait: 3;
    readonly method: 0;
    readonly kind: "subscription";
};
export declare const CHAIN_GET_HEAD_HEADER: {
    readonly trait: 3;
    readonly method: 1;
    readonly kind: "request";
};
export declare const CHAIN_GET_HEAD_BODY: {
    readonly trait: 3;
    readonly method: 2;
    readonly kind: "request";
};
export declare const CHAIN_GET_HEAD_STORAGE: {
    readonly trait: 3;
    readonly method: 3;
    readonly kind: "request";
};
export declare const CHAIN_CALL_HEAD: {
    readonly trait: 3;
    readonly method: 4;
    readonly kind: "request";
};
export declare const CHAIN_UNPIN_HEAD: {
    readonly trait: 3;
    readonly method: 5;
    readonly kind: "request";
};
export declare const CHAIN_CONTINUE_HEAD: {
    readonly trait: 3;
    readonly method: 6;
    readonly kind: "request";
};
export declare const CHAIN_STOP_HEAD_OPERATION: {
    readonly trait: 3;
    readonly method: 7;
    readonly kind: "request";
};
export declare const CHAIN_GET_SPEC_GENESIS_HASH: {
    readonly trait: 3;
    readonly method: 8;
    readonly kind: "request";
};
export declare const CHAIN_GET_SPEC_CHAIN_NAME: {
    readonly trait: 3;
    readonly method: 9;
    readonly kind: "request";
};
export declare const CHAIN_GET_SPEC_PROPERTIES: {
    readonly trait: 3;
    readonly method: 10;
    readonly kind: "request";
};
export declare const CHAIN_BROADCAST_TRANSACTION: {
    readonly trait: 3;
    readonly method: 11;
    readonly kind: "request";
};
export declare const CHAIN_STOP_TRANSACTION: {
    readonly trait: 3;
    readonly method: 12;
    readonly kind: "request";
};
export declare const CHAIN_GET_CHAIN_INFO: {
    readonly trait: 3;
    readonly method: 13;
    readonly kind: "request";
};
export declare const CHAT_CREATE_ROOM: {
    readonly trait: 4;
    readonly method: 0;
    readonly kind: "request";
};
export declare const CHAT_REGISTER_BOT: {
    readonly trait: 4;
    readonly method: 1;
    readonly kind: "request";
};
export declare const CHAT_LIST_SUBSCRIBE: {
    readonly trait: 4;
    readonly method: 2;
    readonly kind: "subscription";
};
export declare const CHAT_POST_MESSAGE: {
    readonly trait: 4;
    readonly method: 3;
    readonly kind: "request";
};
export declare const CHAT_ACTION_SUBSCRIBE: {
    readonly trait: 4;
    readonly method: 4;
    readonly kind: "subscription";
};
export declare const COIN_PAYMENT_CREATE_PURSE: {
    readonly trait: 5;
    readonly method: 0;
    readonly kind: "request";
};
export declare const COIN_PAYMENT_QUERY_PURSE: {
    readonly trait: 5;
    readonly method: 1;
    readonly kind: "request";
};
export declare const COIN_PAYMENT_REBALANCE_PURSE: {
    readonly trait: 5;
    readonly method: 2;
    readonly kind: "subscription";
};
export declare const COIN_PAYMENT_DELETE_PURSE: {
    readonly trait: 5;
    readonly method: 3;
    readonly kind: "subscription";
};
export declare const COIN_PAYMENT_CREATE_RECEIVABLE: {
    readonly trait: 5;
    readonly method: 4;
    readonly kind: "request";
};
export declare const COIN_PAYMENT_CREATE_CHEQUE: {
    readonly trait: 5;
    readonly method: 5;
    readonly kind: "request";
};
export declare const COIN_PAYMENT_DEPOSIT: {
    readonly trait: 5;
    readonly method: 6;
    readonly kind: "subscription";
};
export declare const COIN_PAYMENT_REFUND: {
    readonly trait: 5;
    readonly method: 7;
    readonly kind: "subscription";
};
export declare const COIN_PAYMENT_LISTEN_FOR_PAYMENT: {
    readonly trait: 5;
    readonly method: 8;
    readonly kind: "subscription";
};
export declare const ENTROPY_DERIVE: {
    readonly trait: 6;
    readonly method: 0;
    readonly kind: "request";
};
export declare const LOCAL_STORAGE_READ: {
    readonly trait: 7;
    readonly method: 0;
    readonly kind: "request";
};
export declare const LOCAL_STORAGE_WRITE: {
    readonly trait: 7;
    readonly method: 1;
    readonly kind: "request";
};
export declare const LOCAL_STORAGE_CLEAR: {
    readonly trait: 7;
    readonly method: 2;
    readonly kind: "request";
};
export declare const LOCAL_STORAGE_SUBSCRIBE: {
    readonly trait: 7;
    readonly method: 3;
    readonly kind: "subscription";
};
export declare const NOTIFICATIONS_SEND_PUSH_NOTIFICATION: {
    readonly trait: 8;
    readonly method: 0;
    readonly kind: "request";
};
export declare const NOTIFICATIONS_CANCEL_PUSH_NOTIFICATION: {
    readonly trait: 8;
    readonly method: 1;
    readonly kind: "request";
};
export declare const PAYMENT_BALANCE_SUBSCRIBE: {
    readonly trait: 9;
    readonly method: 0;
    readonly kind: "subscription";
};
export declare const PAYMENT_TOP_UP: {
    readonly trait: 9;
    readonly method: 1;
    readonly kind: "request";
};
export declare const PAYMENT_REQUEST: {
    readonly trait: 9;
    readonly method: 2;
    readonly kind: "request";
};
export declare const PAYMENT_STATUS_SUBSCRIBE: {
    readonly trait: 9;
    readonly method: 3;
    readonly kind: "subscription";
};
export declare const PERMISSIONS_REQUEST_DEVICE_PERMISSION: {
    readonly trait: 10;
    readonly method: 0;
    readonly kind: "request";
};
export declare const PERMISSIONS_REQUEST_REMOTE_PERMISSION: {
    readonly trait: 10;
    readonly method: 1;
    readonly kind: "request";
};
export declare const PERMISSIONS_AUTHORIZE_REMOTE_PERMISSION: {
    readonly trait: 10;
    readonly method: 2;
    readonly kind: "request";
};
export declare const PERMISSIONS_AUTHORIZE_DEVICE_PERMISSION: {
    readonly trait: 10;
    readonly method: 3;
    readonly kind: "request";
};
export declare const PREIMAGE_LOOKUP_SUBSCRIBE: {
    readonly trait: 11;
    readonly method: 0;
    readonly kind: "subscription";
};
export declare const PREIMAGE_SUBMIT: {
    readonly trait: 11;
    readonly method: 1;
    readonly kind: "request";
};
export declare const RESOURCE_ALLOCATION_REQUEST: {
    readonly trait: 12;
    readonly method: 0;
    readonly kind: "request";
};
export declare const SIGNING_CREATE_TRANSACTION: {
    readonly trait: 13;
    readonly method: 0;
    readonly kind: "request";
};
export declare const SIGNING_CREATE_TRANSACTION_WITH_LEGACY_ACCOUNT: {
    readonly trait: 13;
    readonly method: 1;
    readonly kind: "request";
};
export declare const SIGNING_SIGN_RAW_WITH_LEGACY_ACCOUNT: {
    readonly trait: 13;
    readonly method: 2;
    readonly kind: "request";
};
export declare const SIGNING_SIGN_PAYLOAD_WITH_LEGACY_ACCOUNT: {
    readonly trait: 13;
    readonly method: 3;
    readonly kind: "request";
};
export declare const SIGNING_SIGN_RAW: {
    readonly trait: 13;
    readonly method: 4;
    readonly kind: "request";
};
export declare const SIGNING_SIGN_PAYLOAD: {
    readonly trait: 13;
    readonly method: 5;
    readonly kind: "request";
};
export declare const SIGNING_SIGN_RAW_UNWATERMARKED_DEPRECATED: {
    readonly trait: 13;
    readonly method: 6;
    readonly kind: "request";
};
export declare const SIGNING_SIGN_RAW_UNWATERMARKED_DEPRECATED_WITH_LEGACY_ACCOUNT: {
    readonly trait: 13;
    readonly method: 7;
    readonly kind: "request";
};
export declare const STATEMENT_STORE_SUBSCRIBE: {
    readonly trait: 14;
    readonly method: 0;
    readonly kind: "subscription";
};
export declare const STATEMENT_STORE_CREATE_PROOF: {
    readonly trait: 14;
    readonly method: 1;
    readonly kind: "request";
};
export declare const STATEMENT_STORE_SUBMIT: {
    readonly trait: 14;
    readonly method: 2;
    readonly kind: "request";
};
export declare const STATEMENT_STORE_CREATE_PROOF_AUTHORIZED: {
    readonly trait: 14;
    readonly method: 3;
    readonly kind: "request";
};
export declare const THEME_SUBSCRIBE: {
    readonly trait: 15;
    readonly method: 0;
    readonly kind: "subscription";
};
export declare const LOCALE_SUBSCRIBE: {
    readonly trait: 16;
    readonly method: 0;
    readonly kind: "subscription";
};
export declare const RENDERER_RENDER: {
    readonly trait: 17;
    readonly method: 0;
    readonly kind: "subscription";
};
export declare const RENDERER_ACTION_SUBSCRIBE: {
    readonly trait: 17;
    readonly method: 1;
    readonly kind: "subscription";
};
export declare const POCKET_LIST_SUBSCRIBE: {
    readonly trait: 18;
    readonly method: 0;
    readonly kind: "subscription";
};
export declare const POCKET_REMOVE_CARD: {
    readonly trait: 18;
    readonly method: 1;
    readonly kind: "request";
};
export declare const WORKER_BEGIN_OPERATION: {
    readonly trait: 19;
    readonly method: 0;
    readonly kind: "request";
};
export declare const WORKER_END_OPERATION: {
    readonly trait: 19;
    readonly method: 1;
    readonly kind: "request";
};
