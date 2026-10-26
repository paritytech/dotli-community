// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads a session window's request from its URL fragment and keeps it in this tab's session storage, so a reload of the
 * window answers the same round. The fragment is removed from the URL once read, since it only serves the load it came
 * with.
 */

import type { SafeStorage } from '@dotli/shared';
import { parseWindowRequest, type WindowRequest } from './messages.js';
import { asRecord, readRequestParams, routeOfPath, type SessionRoute } from './session-protocol.js';

const REQUEST_KEY = 'dotli:s:request';

export interface WindowRequestDeps {
  pathname: string;
  search: string;
  hash: string;
  storage: SafeStorage;
  replaceUrl: (url: string) => void;
}

function keep(storage: SafeStorage, pathname: string, params: Record<string, unknown>): void {
  storage.setItem(REQUEST_KEY, JSON.stringify({ path: pathname, params }));
}

/** The request kept for `pathname`, or null when none is kept or the kept one no longer parses. */
function kept(storage: SafeStorage, pathname: string, route: SessionRoute): WindowRequest | null {
  const raw = storage.getItem(REQUEST_KEY);
  if (raw === null) {
    return null;
  }
  let entry: Record<string, unknown> | null;
  try {
    entry = asRecord(JSON.parse(raw));
  } catch {
    // A kept entry that is not JSON is the documented no-request outcome.
    return null;
  }
  const params = asRecord(entry?.['params']);
  return entry?.['path'] === pathname && params !== null ? parseWindowRequest(route, params) : null;
}

/**
 * The request this window answers, or null when it has none. A fragment with params is this load's request whether or
 * not it reads, so it replaces what was kept. Without one, the request kept for this path serves a reload.
 */
export function takeWindowRequest(deps: WindowRequestDeps): WindowRequest | null {
  const { pathname, search, hash, storage, replaceUrl } = deps;
  const route = routeOfPath(pathname);
  if (route === null) {
    return null;
  }
  const params = readRequestParams(hash);
  if (params === undefined) {
    return kept(storage, pathname, route);
  }
  replaceUrl(pathname + search);
  const request = params === null ? null : parseWindowRequest(route, params);
  if (params === null || request === null) {
    storage.removeItem(REQUEST_KEY);
    return null;
  }
  keep(storage, pathname, params);
  return request;
}

export interface NewRequestDeps {
  pathname: string;
  listen: (handler: () => void) => () => void;
  hash: () => string;
  storage: SafeStorage;
  reload: () => void;
}

/** Keeps and reloads for each new request a page puts in this window's fragment. Returns the stop function. */
export function watchNewRequests(deps: NewRequestDeps): () => void {
  const { pathname, listen, hash, storage, reload } = deps;
  const route = routeOfPath(pathname);
  return listen(() => {
    const params = readRequestParams(hash());
    if (route === null || params === undefined || params === null || parseWindowRequest(route, params) === null) {
      return;
    }
    keep(storage, pathname, params);
    reload();
  });
}
