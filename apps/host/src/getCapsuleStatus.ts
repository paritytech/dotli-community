// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { NetworkHealth } from './networkVerdict.js';

/** What the capsule shows of the page's state. */
export type CapsuleStatus = {
  /** The tone of the page's network health. */
  tone: NetworkHealth;
  /** The capsule leads with the action dot. */
  action: boolean;
  /** The capsule's colour is not announced, so going offline is said in words. */
  announcement: string;
};

type Params = {
  /** The page's network health. */
  health: NetworkHealth;
  /** Whether the page waits on an action. */
  action: boolean;
  /** Whether the browser is online. */
  online: boolean;
};

/** Returns what the capsule shows for the page's network health, its waiting action and its connection. Never throws. */
export function getCapsuleStatus({ health, action, online }: Params): CapsuleStatus {
  return { tone: health, action, announcement: online ? '' : 'You are offline' };
}
