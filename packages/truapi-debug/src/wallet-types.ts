// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { WalletAllowanceSnapshot } from '@parity/truapi-host/web';

export interface InspectorIdentity {
  network: string;
  identityAccountId: string;
  liteUsername?: string | undefined;
  fullUsername?: string | undefined;
  publicKey?: string | undefined;
  /** The username (or its absence) was read from chain in this session. */
  usernameVerified?: boolean | undefined;
}

export interface InspectorResource {
  id: string;
  label: string;
  request: unknown;
}

export interface InspectorProduct {
  id: string;
  name: string;
  origin: string;
  accountPublicKey?: string | undefined;
  accountError?: string | undefined;
  derivation: string;
  permissions: {
    id: string;
    label: string;
    status: 'ask' | 'granted' | 'denied';
  }[];
  resources: InspectorResource[];
}

export type LocalIdentityProgress =
  { stage: 'checking' | 'authenticating' | 'submitting' | 'confirming' } | { stage: 'retrying'; error: string };

export interface ExperimentalWalletControls {
  isActive(): boolean;
  networkLabel(): string;
  getCachedIdentity(): InspectorIdentity | undefined;
  /** Another app holds this browser's test wallet; this app has none. */
  storedInOtherApp(): Promise<boolean>;
  getIdentity(): Promise<InspectorIdentity>;
  getProduct(): Promise<InspectorProduct | null>;
  getAllowanceSnapshot(): Promise<WalletAllowanceSnapshot>;
  describeResource(resource: unknown): InspectorResource | null;
  requestResource(productId: string, resource: unknown): Promise<'Allocated' | 'Rejected' | 'NotAvailable'>;
  refreshUsername(): Promise<{
    identityAccountId: string;
    liteUsername?: string | undefined;
  }>;
  claimLiteUsername(
    baseUsername: string,
    onProgress?: (progress: LocalIdentityProgress) => void,
  ): Promise<{ identityAccountId: string; liteUsername?: string | undefined }>;
  activate(): Promise<void>;
  disconnect(): Promise<void>;
  deleteWallet(): Promise<void>;
  exportMnemonic(): Promise<string>;
  importMnemonic(mnemonic: string): Promise<void>;
}
