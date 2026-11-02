// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Version 1 of the wire protocol between a page and a session window: the postMessage payloads with their parsers and
 * builders. Parsers accept exactly the documented shape and return null for anything else. It knows no account data and
 * no message channel.
 */

import { isRecord } from '@dotli/shared';

/** Why a window refused a round, the closed set it ever posts. */
export type RefusalReason =
  | 'origin_not_allowed'
  | 'bad_request'
  | 'unsupported_version'
  | 'unknown_network'
  | 'declined'
  /** The wallet does not support or allow the transaction. */
  | 'transaction_invalid';

export type ReadyMessage = {
  type: 'dotli:s:ready';
  versions: number[];
};

export type HelloMessage = {
  type: 'dotli:s:hello';
  v: number;
  round: string;
};

/** A site's call too long for its request URL, sent after the hello. */
export type PayloadMessage = {
  type: 'dotli:s:payload';
  round: string;
  call: string;
};

export type ResultMessage<Result> = {
  type: 'dotli:s:result';
  round: string;
  result: Result;
  /** The token a site keeps to be known on its next sign-in. */
  site_token?: string;
};

export type RefusedMessage = {
  type: 'dotli:s:refused';
  round: string;
  /** A string as an opener reads it, since a window of another release may send a reason this one does not know. */
  reason: string;
};

/** The user left the round without an answer. */
export type CancelledMessage = {
  type: 'dotli:s:cancelled';
  round: string;
};

/** A message the window sends its opener. */
export type PageMessage = ReadyMessage | ResultMessage<unknown> | RefusedMessage | CancelledMessage;

type CreateResultMessageParams<Result> = {
  round: string;
  result: Result;
  /** The token the site keeps, left out of the message when undefined. */
  siteToken?: string | undefined;
};

export const PROTOCOL_VERSION = 1;

/** The window's first message, naming the versions it speaks. */
export const READY: ReadyMessage = { type: 'dotli:s:ready', versions: [PROTOCOL_VERSION] };

/** The opener's message to the window, or null when `data` is not one. */
export function parseHello(data: unknown): HelloMessage | null {
  if (!isRecord(data)) {
    return null;
  }
  const version = data['v'];
  const round = data['round'];
  return data['type'] === 'dotli:s:hello' && typeof version === 'number' && typeof round === 'string'
    ? { type: 'dotli:s:hello', v: version, round }
    : null;
}

/** A site's payload to the window, or null when `data` is not one. */
export function parsePayload(data: unknown): PayloadMessage | null {
  if (!isRecord(data)) {
    return null;
  }
  const round = data['round'];
  const call = data['call'];
  return data['type'] === 'dotli:s:payload' && typeof round === 'string' && typeof call === 'string'
    ? { type: 'dotli:s:payload', round, call }
    : null;
}

/** The window's message to the opener, or null when `data` is not one. */
export function parsePageMessage(data: unknown): PageMessage | null {
  if (!isRecord(data)) {
    return null;
  }
  switch (data['type']) {
    case 'dotli:s:ready':
      return parseReady(data);
    case 'dotli:s:result':
      return parseResult(data);
    case 'dotli:s:refused':
      return parseRefused(data);
    case 'dotli:s:cancelled':
      return parseCancelled(data);
    default:
      // The type is the sender's to choose, so any other is no message of the window's.
      return null;
  }
}

/** The opener's hello for `round`, in the version this page speaks. */
export function createHelloMessage(round: string): HelloMessage {
  return { type: 'dotli:s:hello', v: PROTOCOL_VERSION, round };
}

/** The round's result, with the token the site keeps when it gets one. */
export function createResultMessage<Result>({
  round,
  result,
  siteToken,
}: CreateResultMessageParams<Result>): ResultMessage<Result> {
  return { type: 'dotli:s:result', round, result, ...(siteToken === undefined ? {} : { site_token: siteToken }) };
}

/** The round refused with `reason`. */
export function createRefusedMessage(round: string, reason: RefusalReason): RefusedMessage {
  return { type: 'dotli:s:refused', round, reason };
}

/** The user left the round without an answer. */
export function createCancelledMessage(round: string): CancelledMessage {
  return { type: 'dotli:s:cancelled', round };
}

function parseReady(data: Record<string, unknown>): ReadyMessage | null {
  const versions = data['versions'];
  return Array.isArray(versions) && versions.every(version => typeof version === 'number')
    ? { type: 'dotli:s:ready', versions }
    : null;
}

function parseResult(data: Record<string, unknown>): ResultMessage<unknown> | null {
  const round = data['round'];
  if (typeof round !== 'string' || !('result' in data)) {
    return null;
  }
  const message: ResultMessage<unknown> = { type: 'dotli:s:result', round, result: data['result'] };
  if (!('site_token' in data)) {
    return message;
  }
  const siteToken = data['site_token'];
  return typeof siteToken === 'string' ? { ...message, site_token: siteToken } : null;
}

function parseRefused(data: Record<string, unknown>): RefusedMessage | null {
  const round = data['round'];
  const reason = data['reason'];
  return typeof round === 'string' && typeof reason === 'string' ? { type: 'dotli:s:refused', round, reason } : null;
}

function parseCancelled(data: Record<string, unknown>): CancelledMessage | null {
  const round = data['round'];
  return typeof round === 'string' ? { type: 'dotli:s:cancelled', round } : null;
}
