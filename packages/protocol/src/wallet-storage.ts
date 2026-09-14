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
  if (typeof value !== "object" || value === null) return false;
  const state = value as SharedWalletState;
  return (
    Number.isSafeInteger(state.version) &&
    state.version >= 0 &&
    (state.revision === null || typeof state.revision === "string") &&
    typeof state.enabled === "boolean" &&
    typeof state.hasWallet === "boolean"
  );
}
