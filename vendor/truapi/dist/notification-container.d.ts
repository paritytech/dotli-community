export declare const MAX_CONTAINER_BYTES: number;
export declare const NOTIFICATION_PREDICATE = "truapiNotification";
export declare const MAX_NOTIFICATION_CANDIDATES = 32;
/** Inspect bounded standard structure without interpreting application assertions. */
export declare function decodeNotificationContainer(bytes: Uint8Array): {
    headers: string[];
    subjects: Map<string, Uint8Array>;
};
/** Encode the minimal standard carrier, leaving application assertions to its owner. */
export declare function encodeNotificationContainer(headerJson: string, carrier: Uint8Array): Uint8Array;
