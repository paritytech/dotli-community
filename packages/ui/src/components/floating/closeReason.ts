// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Why an anchored surface closed, which decides whether focus returns to its trigger.
 * `sheet` is the phone sheet's own close. `released` means the trigger let go while open and refocuses itself.
 */
export type CloseReason =
  'outside' | 'escape' | 'trigger' | 'blur' | 'focus-out' | 'programmatic' | 'sheet' | 'released';

/** What closed a modal layer, which decides where focus goes after. */
export type CloseInput = 'pointer' | 'keyboard';

/** Returns what made `click`. Enter or Space on a button clicks it with no press count. Never throws. */
export function getClickInput(click: Pick<MouseEvent, 'detail'>): CloseInput {
  return click.detail === 0 ? 'keyboard' : 'pointer';
}
