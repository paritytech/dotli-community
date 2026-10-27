// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The JSON-RPC method names the package sends or matches, and the events that end a transaction watch.

export const CHAIN_HEAD_FOLLOW = 'chainHead_v1_follow';
export const CHAIN_HEAD_FOLLOW_EVENT = 'chainHead_v1_followEvent';
export const CHAIN_HEAD_HEADER = 'chainHead_v1_header';
export const CHAIN_HEAD_UNFOLLOW = 'chainHead_v1_unfollow';
export const CHAIN_HEAD_UNPIN = 'chainHead_v1_unpin';
export const STATEMENT_SUBSCRIBE = 'statement_subscribeStatement';
export const STATEMENT_UNSUBSCRIBE = 'statement_unsubscribeStatement';
export const TRANSACTION_BROADCAST = 'transaction_v1_broadcast';
export const TRANSACTION_STOP = 'transaction_v1_stop';
export const SYSTEM_PEERS = 'system_peers';
export const SUBMIT_AND_WATCH = 'transactionWatch_v1_submitAndWatch';
export const UNWATCH = 'transactionWatch_v1_unwatch';
export const WATCH_EVENT = 'transactionWatch_v1_watchEvent';
/** The watch events after which the node ends the watch on its own. */
export const TERMINAL_WATCH_EVENTS: ReadonlySet<string> = new Set(['finalized', 'error', 'invalid', 'dropped']);
