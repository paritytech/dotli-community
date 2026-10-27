// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Constants the test rig and the specs share.

import { toMessageBytes } from '../messageBytes.js';

export const RETRY_MS = 50;
export const TIMEOUT_MS = 5_000;
export const VERSION = 3;

/** A message whose leg tag no method has, so every method's leg reader refuses it. */
export const UNKNOWN_LEG = toMessageBytes(Uint8Array.of(9));

/** Text cut short: its length says two bytes and none follow, so `str` refuses it. */
export const CUT_SHORT_TEXT = Uint8Array.of(8);

/** The text `a` followed by a byte it leaves unread, so a whole decode refuses it. */
export const TRAILED_TEXT = Uint8Array.of(4, 0x61, 0);

/** Why a whole decode refuses `TRAILED_TEXT`. */
export const TRAILED_REASON = 'RangeError: The value is followed by unread bytes, 1 in all';
