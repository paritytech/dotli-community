// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Public metadata only: never put entropy on a broadcast or mode-sync path. */
export interface SharedWalletState {
  version: number;
  revision: string | null;
  enabled: boolean;
  hasWallet: boolean;
}

export type SharedWalletOperation =
  | { action: "state" }
  | { action: "read" }
  | { action: "create"; expectedVersion: number }
  | { action: "delete"; expectedVersion: number }
  | { action: "enabled"; expectedVersion: number; enabled: boolean }
  | {
      action: "import" | "migrate";
      expectedVersion: number;
      secret: Uint8Array;
      enabled?: boolean;
    };

export interface SharedWalletResult {
  state: SharedWalletState;
  secret?: Uint8Array;
  created?: boolean;
}

export function isSharedWalletState(
  value: unknown,
): value is SharedWalletState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state = value as SharedWalletState;
  return (
    Number.isSafeInteger(state.version) &&
    state.version >= 0 &&
    (state.revision === null || typeof state.revision === "string") &&
    typeof state.enabled === "boolean" &&
    typeof state.hasWallet === "boolean"
  );
}

export function isSharedWalletOperation(
  value: unknown,
): value is SharedWalletOperation {
  if (typeof value !== "object" || value === null || !("action" in value)) {
    return false;
  }
  if (value.action === "state" || value.action === "read") {
    return true;
  }
  if (
    !("expectedVersion" in value) ||
    typeof value.expectedVersion !== "number" ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 0
  ) {
    return false;
  }
  switch (value.action) {
    case "create":
    case "delete":
      return true;
    case "enabled":
      return "enabled" in value && typeof value.enabled === "boolean";
    case "import":
    case "migrate":
      return (
        "secret" in value &&
        value.secret instanceof Uint8Array &&
        value.secret.length >= 16 &&
        value.secret.length <= 32 &&
        value.secret.length % 4 === 0 &&
        (value.action === "import" ||
          !("enabled" in value) ||
          value.enabled === undefined ||
          typeof value.enabled === "boolean")
      );
    default:
      return false;
  }
}
