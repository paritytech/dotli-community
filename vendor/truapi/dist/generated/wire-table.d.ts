export declare const SYSTEM_HANDSHAKE: {
    readonly request: 0;
    readonly response: 1;
};
export declare const SYSTEM_FEATURE_SUPPORTED: {
    readonly request: 2;
    readonly response: 3;
};
export declare const NOTIFICATIONS_SEND_PUSH_NOTIFICATION: {
    readonly request: 4;
    readonly response: 5;
};
export declare const SYSTEM_NAVIGATE_TO: {
    readonly request: 6;
    readonly response: 7;
};
export declare const PERMISSIONS_REQUEST_DEVICE_PERMISSION: {
    readonly request: 8;
    readonly response: 9;
};
export declare const PERMISSIONS_REQUEST_REMOTE_PERMISSION: {
    readonly request: 10;
    readonly response: 11;
};
export declare const LOCAL_STORAGE_READ: {
    readonly request: 12;
    readonly response: 13;
};
export declare const LOCAL_STORAGE_WRITE: {
    readonly request: 14;
    readonly response: 15;
};
export declare const LOCAL_STORAGE_CLEAR: {
    readonly request: 16;
    readonly response: 17;
};
export declare const ACCOUNT_CONNECTION_STATUS_SUBSCRIBE: {
    readonly start: 18;
    readonly stop: 19;
    readonly interrupt: 20;
    readonly receive: 21;
};
export declare const ACCOUNT_GET_ACCOUNT: {
    readonly request: 22;
    readonly response: 23;
};
export declare const ACCOUNT_GET_ACCOUNT_ALIAS: {
    readonly request: 24;
    readonly response: 25;
};
export declare const ACCOUNT_CREATE_ACCOUNT_PROOF: {
    readonly request: 26;
    readonly response: 27;
};
export declare const ACCOUNT_GET_LEGACY_ACCOUNTS: {
    readonly request: 28;
    readonly response: 29;
};
export declare const SIGNING_CREATE_TRANSACTION: {
    readonly request: 30;
    readonly response: 31;
};
export declare const SIGNING_CREATE_TRANSACTION_WITH_LEGACY_ACCOUNT: {
    readonly request: 32;
    readonly response: 33;
};
export declare const SIGNING_SIGN_RAW_WITH_LEGACY_ACCOUNT: {
    readonly request: 34;
    readonly response: 35;
};
export declare const SIGNING_SIGN_PAYLOAD_WITH_LEGACY_ACCOUNT: {
    readonly request: 36;
    readonly response: 37;
};
export declare const CHAT_CREATE_ROOM: {
    readonly request: 38;
    readonly response: 39;
};
export declare const CHAT_REGISTER_BOT: {
    readonly request: 40;
    readonly response: 41;
};
export declare const CHAT_LIST_SUBSCRIBE: {
    readonly start: 42;
    readonly stop: 43;
    readonly interrupt: 44;
    readonly receive: 45;
};
export declare const CHAT_POST_MESSAGE: {
    readonly request: 46;
    readonly response: 47;
};
export declare const CHAT_ACTION_SUBSCRIBE: {
    readonly start: 48;
    readonly stop: 49;
    readonly interrupt: 50;
    readonly receive: 51;
};
export declare const CHAT_CUSTOM_MESSAGE_RENDER: {
    readonly start: 52;
    readonly stop: 53;
    readonly interrupt: 54;
    readonly receive: 55;
};
export declare const STATEMENT_STORE_SUBSCRIBE: {
    readonly start: 56;
    readonly stop: 57;
    readonly interrupt: 58;
    readonly receive: 59;
};
export declare const STATEMENT_STORE_CREATE_PROOF: {
    readonly request: 60;
    readonly response: 61;
};
export declare const STATEMENT_STORE_SUBMIT: {
    readonly request: 62;
    readonly response: 63;
};
export declare const PREIMAGE_LOOKUP_SUBSCRIBE: {
    readonly start: 64;
    readonly stop: 65;
    readonly interrupt: 66;
    readonly receive: 67;
};
export declare const PREIMAGE_SUBMIT: {
    readonly request: 68;
    readonly response: 69;
};
export declare const CHAIN_FOLLOW_HEAD_SUBSCRIBE: {
    readonly start: 76;
    readonly stop: 77;
    readonly interrupt: 78;
    readonly receive: 79;
};
export declare const CHAIN_GET_HEAD_HEADER: {
    readonly request: 80;
    readonly response: 81;
};
export declare const CHAIN_GET_HEAD_BODY: {
    readonly request: 82;
    readonly response: 83;
};
export declare const CHAIN_GET_HEAD_STORAGE: {
    readonly request: 84;
    readonly response: 85;
};
export declare const CHAIN_CALL_HEAD: {
    readonly request: 86;
    readonly response: 87;
};
export declare const CHAIN_UNPIN_HEAD: {
    readonly request: 88;
    readonly response: 89;
};
export declare const CHAIN_CONTINUE_HEAD: {
    readonly request: 90;
    readonly response: 91;
};
export declare const CHAIN_STOP_HEAD_OPERATION: {
    readonly request: 92;
    readonly response: 93;
};
export declare const CHAIN_GET_SPEC_GENESIS_HASH: {
    readonly request: 94;
    readonly response: 95;
};
export declare const CHAIN_GET_SPEC_CHAIN_NAME: {
    readonly request: 96;
    readonly response: 97;
};
export declare const CHAIN_GET_SPEC_PROPERTIES: {
    readonly request: 98;
    readonly response: 99;
};
export declare const CHAIN_BROADCAST_TRANSACTION: {
    readonly request: 100;
    readonly response: 101;
};
export declare const CHAIN_STOP_TRANSACTION: {
    readonly request: 102;
    readonly response: 103;
};
export declare const THEME_SUBSCRIBE: {
    readonly start: 104;
    readonly stop: 105;
    readonly interrupt: 106;
    readonly receive: 107;
};
export declare const ENTROPY_DERIVE: {
    readonly request: 108;
    readonly response: 109;
};
export declare const ACCOUNT_GET_USER_ID: {
    readonly request: 110;
    readonly response: 111;
};
export declare const ACCOUNT_REQUEST_LOGIN: {
    readonly request: 112;
    readonly response: 113;
};
export declare const SIGNING_SIGN_RAW: {
    readonly request: 114;
    readonly response: 115;
};
export declare const SIGNING_SIGN_PAYLOAD: {
    readonly request: 116;
    readonly response: 117;
};
export declare const PAYMENT_BALANCE_SUBSCRIBE: {
    readonly start: 118;
    readonly stop: 119;
    readonly interrupt: 120;
    readonly receive: 121;
};
export declare const PAYMENT_TOP_UP: {
    readonly request: 122;
    readonly response: 123;
};
export declare const PAYMENT_REQUEST: {
    readonly request: 124;
    readonly response: 125;
};
export declare const PAYMENT_STATUS_SUBSCRIBE: {
    readonly start: 126;
    readonly stop: 127;
    readonly interrupt: 128;
    readonly receive: 129;
};
export declare const RESOURCE_ALLOCATION_REQUEST: {
    readonly request: 130;
    readonly response: 131;
};
export declare const STATEMENT_STORE_CREATE_PROOF_AUTHORIZED: {
    readonly request: 132;
    readonly response: 133;
};
export declare const NOTIFICATIONS_CANCEL_PUSH_NOTIFICATION: {
    readonly request: 134;
    readonly response: 135;
};
export declare const COIN_PAYMENT_CREATE_PURSE: {
    readonly request: 136;
    readonly response: 137;
};
export declare const COIN_PAYMENT_QUERY_PURSE: {
    readonly request: 138;
    readonly response: 139;
};
export declare const COIN_PAYMENT_REBALANCE_PURSE: {
    readonly start: 140;
    readonly stop: 141;
    readonly interrupt: 142;
    readonly receive: 143;
};
export declare const COIN_PAYMENT_DELETE_PURSE: {
    readonly start: 144;
    readonly stop: 145;
    readonly interrupt: 146;
    readonly receive: 147;
};
export declare const COIN_PAYMENT_CREATE_RECEIVABLE: {
    readonly request: 148;
    readonly response: 149;
};
export declare const COIN_PAYMENT_CREATE_CHEQUE: {
    readonly request: 150;
    readonly response: 151;
};
export declare const COIN_PAYMENT_DEPOSIT: {
    readonly start: 152;
    readonly stop: 153;
    readonly interrupt: 154;
    readonly receive: 155;
};
export declare const COIN_PAYMENT_REFUND: {
    readonly start: 156;
    readonly stop: 157;
    readonly interrupt: 158;
    readonly receive: 159;
};
export declare const COIN_PAYMENT_LISTEN_FOR_PAYMENT: {
    readonly start: 160;
    readonly stop: 161;
    readonly interrupt: 162;
    readonly receive: 163;
};
export declare const ACCOUNT_SIGN_VRF: {
    readonly request: 164;
    readonly response: 165;
};
export declare const CHAIN_GET_CHAIN_INFO: {
    readonly request: 166;
    readonly response: 167;
};
export declare const ACCOUNT_REGISTER_RING_VRF_KEY: {
    readonly request: 168;
    readonly response: 169;
};
export declare const ACCOUNT_LIST_RING_VRF_KEYS: {
    readonly request: 170;
    readonly response: 171;
};
export declare const ACCOUNT_RING_VRF_SIGN: {
    readonly request: 172;
    readonly response: 173;
};
export declare const ACCOUNT_PRODUCT_DEVICE_CHAT: {
    readonly request: 174;
    readonly response: 175;
};
export declare const SYSTEM_GET_PRODUCT_CONTEXT: {
    readonly request: 190;
    readonly response: 191;
};
export declare const SYSTEM_HOST_INFO: {
    readonly request: 192;
    readonly response: 193;
};
export declare const LOCALE_SUBSCRIBE: {
    readonly start: 194;
    readonly stop: 195;
    readonly interrupt: 196;
    readonly receive: 197;
};
