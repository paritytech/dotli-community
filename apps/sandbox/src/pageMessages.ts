// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The app service worker's side of the messages a page sends it: which it acts on, and how it answers.

/// <reference lib="webworker" />

import { isRecord } from '@dotli/shared';
import { APP_SERVICE_WORKER_MESSAGES } from './appServiceWorkerMessages.js';
import type { SetArchiveMessage } from './handOverArchive.js';

/** A handoff as the worker reads it. Each field stays unchecked until it is read. */
export type SetArchiveRequest = {
  type: typeof APP_SERVICE_WORKER_MESSAGES.SET_ARCHIVE;
  packed?: unknown;
  index?: unknown;
  directory?: unknown;
};

/** The types of a page's message the worker acts on. */
type PageMessageType =
  | typeof APP_SERVICE_WORKER_MESSAGES.CLAIM
  | typeof APP_SERVICE_WORKER_MESSAGES.GET_VERSION
  | typeof APP_SERVICE_WORKER_MESSAGES.SET_ARCHIVE;

/** A page's message the worker acts on. */
type PageMessage = { type: Exclude<PageMessageType, SetArchiveRequest['type']> } | SetArchiveRequest;

/** The worker's answer to a page's message. */
type WorkerReply =
  | { type: typeof APP_SERVICE_WORKER_MESSAGES.VERSION; version: string }
  | { type: typeof APP_SERVICE_WORKER_MESSAGES.ARCHIVE_READY }
  | { type: typeof APP_SERVICE_WORKER_MESSAGES.ARCHIVE_ERROR; reason: string };

const PAGE_MESSAGE_TYPES: readonly PageMessageType[] = [
  APP_SERVICE_WORKER_MESSAGES.CLAIM,
  APP_SERVICE_WORKER_MESSAGES.GET_VERSION,
  APP_SERVICE_WORKER_MESSAGES.SET_ARCHIVE,
];

/** Whether a page's message has a type the worker acts on. */
export function isPageMessage(data: unknown): data is PageMessage {
  return isRecord(data) && PAGE_MESSAGE_TYPES.some(type => type === data['type']);
}

/** Whether a `SET_ARCHIVE` message carries the packed archive, its index and the page's directory. */
export function hasArchivePayload(
  data: SetArchiveRequest,
): data is SetArchiveRequest & Pick<SetArchiveMessage, 'packed' | 'index' | 'directory'> {
  return data.packed instanceof ArrayBuffer && Array.isArray(data.index) && typeof data.directory === 'string';
}

/**
 * Answers a page's message on the port it sent, so a late answer cannot settle a later request and no global listener
 * is needed. A message without a port gets no answer. Throws what posting throws.
 */
export function replyToPage(event: ExtendableMessageEvent, message: WorkerReply): void {
  event.ports[0]?.postMessage(message);
}

/** The page that sent a message, or `null` when no client did. */
export function getSender({ source }: ExtendableMessageEvent): Client | null {
  // A page the worker controls sends as a `Client`, the one source with an id. No `instanceof` check, since Node has
  // no `Client` global.
  return source !== null && 'id' in source ? source : null;
}
