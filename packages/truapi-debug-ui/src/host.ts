// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the debug panel reads of the host page and asks of it. The host builds it from its own stores and layers, so
// the panel imports none of them.

import type { ReadableStore } from '@dotli/shared';
import type { ArchiveFiles } from '@dotli/content';

/** The product on show. Only a dotNS product has a CID. */
export type HostProduct = { status: 'loaded'; cid?: string | undefined } | { status: 'none' | 'error' };

/** The login state. Its session is read only while `tag` is `Connected`. */
export type HostAuth = {
  tag: string;
  session?: { identityAccountId?: string | undefined; liteUsername?: string | undefined };
};

export type HostWalletMode = {
  mode: 'app' | 'local';
  /** Why local mode could not start on this boot. */
  failure: string | null;
};

/**
 * The page's sign-in, where the page takes it: its sign-in window, or its own modal on a page that pairs in place. Each
 * call opens it before it returns, so a click handler calls it with no wait.
 */
export type WalletSwitch = {
  /** Opens the page's recovery phrase view, where the phrase is typed. */
  importPhrase(): void;
  /** Signs out, so every app on the domain signs with Polkadot App again. */
  usePolkadotApp(): void;
};

/** A row the host marks `copyable` gets a copy button. */
export type DiagnosticsRow = [label: string, value: string, copyable?: boolean];

export type PackageVersion = {
  name: string;
  version: string;
};

/** What the Diagnostics tab shows and shares. */
export type DiagnosticsSource = {
  /** The page rows, read each time the tab opens. */
  rows: () => DiagnosticsRow[];
  lightClientVersion: () => string;
  packages: () => { polkadotApi: PackageVersion[]; parityTruapi: PackageVersion[] };
  /** The shared report of `rows`. */
  report: (rows: readonly DiagnosticsRow[]) => Promise<string>;
  /** Opens the pre-filled issue in a new tab. */
  openIssue: (url: string) => void;
};

/** CSS lengths, such as `var(--content-top)`, which the page resolves for its own layout. */
export type ContentInsets = {
  top: string;
  bottom: string;
};

/** In px. */
export type DockInset = {
  right: number;
  bottom: number;
};

/** Reads the files of a product archive by its root CID, the way the product was served. */
export type ArchiveLoader = (cid: string) => Promise<ArchiveFiles>;

export type DebugPanelHost = {
  /** The Archive tab reads the files of the product on show. */
  product: ReadableStore<HostProduct>;
  /** The Wallet tab shows the local wallet's account from it. */
  auth: ReadableStore<HostAuth>;
  walletMode: ReadableStore<HostWalletMode>;
  walletSwitch: WalletSwitch;
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
};
