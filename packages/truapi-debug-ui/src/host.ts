// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the debug panel reads of the host page and asks of it. The host builds it from its own stores and layers, so
// the panel imports none of them.

import type { ReadableStore } from '@dotli/shared';
import type { ArchiveFiles } from '@dotli/content';

/** The product on show. Only a dotNS product has a CID. */
export type HostProduct = { status: 'loaded'; cid?: string | undefined } | { status: 'none' | 'error' };

/** The login state. Its session is read only while `tag` is `Connected`. */
export interface HostAuth {
  tag: string;
  session?: { identityAccountId?: string | undefined; liteUsername?: string | undefined };
}

export interface HostWalletMode {
  mode: 'app' | 'local';
  /** Why local mode could not start on this boot. */
  failure: string | null;
}

/** `reloading` once the switch is stored for every app, `failed` after the failure was reported. */
export type WalletSwitchOutcome = 'reloading' | 'failed';

export interface WalletSwitch {
  /** Uses this wallet in every app on the domain. */
  useLocalWallet(entropy: Uint8Array): Promise<WalletSwitchOutcome>;
  /** Forgets the local wallet in every app on the domain, so they sign with Polkadot App again. */
  usePolkadotApp(): Promise<WalletSwitchOutcome>;
}

/** A row the host marks `copyable` gets a copy button. */
export type DiagnosticsRow = [label: string, value: string, copyable?: boolean];

export interface PackageVersion {
  name: string;
  version: string;
}

/** What the Diagnostics tab shows and shares. */
export interface DiagnosticsSource {
  /** The page rows, read each time the tab opens. */
  rows: () => DiagnosticsRow[];
  lightClientVersion: () => string;
  packages: () => { polkadotApi: PackageVersion[]; parityTruapi: PackageVersion[] };
  /** The shared report of `rows`. */
  report: (rows: readonly DiagnosticsRow[]) => Promise<string>;
  /** Opens the pre-filled issue in a new tab. */
  openIssue: (url: string) => void;
}

/** CSS lengths, such as `var(--content-top)`, which the page resolves for its own layout. */
export interface ContentInsets {
  top: string;
  bottom: string;
}

/** In px. */
export interface DockInset {
  right: number;
  bottom: number;
}

/** Reads the files of a product archive by its root CID, the way the product was served. */
export type ArchiveLoader = (cid: string) => Promise<ArchiveFiles>;

export interface DebugPanelHost {
  /** The Archive tab reads the files of the product on show. */
  product: ReadableStore<HostProduct>;
  /** The Wallet tab shows the local wallet's account from it. */
  auth: ReadableStore<HostAuth>;
  walletMode: ReadableStore<HostWalletMode>;
  /** Each switch reports its own failure, so the Wallet tab only shows it. */
  walletSwitch: WalletSwitch;
  /** Null for anything that is not a valid recovery phrase. */
  phraseToEntropy: (phrase: string) => Uint8Array | null;
  diagnostics: DiagnosticsSource;
  archive: ArchiveLoader;
  /** Where the page's content starts and ends, which the panel docks against. */
  contentInsets: ContentInsets;
  /** Read as the panel docks right, so it sits below the bar. */
  topbarPresent: () => boolean;
  /** Hears the room the panel takes from the product frame, each time it changes. */
  reportDockInset: (inset: DockInset) => void;
  /** Turns debug mode off for this tab and reloads it without the panel. */
  leaveDebugMode: () => void;
}
