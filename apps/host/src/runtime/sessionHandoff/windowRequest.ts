// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads a session window's request from its URL fragment and keeps it in this tab's session storage, so a reload of the
 * window answers the same round. The fragment is removed from the URL once read, since it only serves the load it came
 * with.
 */

import { isRecord, type SafeStorage } from '@dotli/shared';
import { readRequestParams, readSessionRequest, type SessionRequest } from './readSessionRequest.js';
import { getRoute, type SessionRoute } from './sessionRoute.js';

type TakeWindowRequestParams = {
  pathname: string;
  search: string;
  hash: string;
  storage: SafeStorage;
  /** Puts `url` in place of the window's URL, without a load. */
  replaceUrl: (url: string) => void;
};

type WatchNewRequestsParams = {
  pathname: string;
  /** Hears each change of the window's fragment until the returned stop. */
  listen: (handler: () => void) => () => void;
  /** The window's fragment now, with its leading `#`. */
  hash: () => string;
  storage: SafeStorage;
  /** Loads the window again. */
  reload: () => void;
};

type KeepRequestParams = {
  storage: SafeStorage;
  pathname: string;
  params: Record<string, unknown>;
};

type ReadKeptRequestParams = {
  storage: SafeStorage;
  pathname: string;
  route: SessionRoute;
};

const REQUEST_KEY = 'dotli:s:request';

/**
 * The request this window answers, or null when it has none. A fragment with params is this load's request whether or
 * not it reads, so it replaces what was kept. Without one, the request kept for this path serves a reload. Only a round
 * is required here, so a request of another version or for another party is kept for the window to answer.
 */
export function takeWindowRequest({
  pathname,
  search,
  hash,
  storage,
  replaceUrl,
}: TakeWindowRequestParams): SessionRequest | null {
  const route = getRoute(pathname);
  if (route === null) {
    return null;
  }
  const params = readRequestParams(hash);
  if (params === undefined) {
    return readKeptRequest({ storage, pathname, route });
  }
  replaceUrl(pathname + search);
  const request = params === null ? null : readSessionRequest(route, params);
  if (params === null || request === null) {
    storage.removeItem(REQUEST_KEY);
    return null;
  }
  keepRequest({ storage, pathname, params });
  return request;
}

/** Forgets the kept request, so a reload or a step back to the window answers no round. */
export function forgetWindowRequest(storage: SafeStorage): void {
  storage.removeItem(REQUEST_KEY);
}

/** Keeps and reloads for each new request a page puts in this window's fragment. Returns the stop function. */
export function watchNewRequests({ pathname, listen, hash, storage, reload }: WatchNewRequestsParams): () => void {
  const route = getRoute(pathname);
  return listen(() => {
    const params = readRequestParams(hash());
    if (route === null || params === undefined || params === null || readSessionRequest(route, params) === null) {
      return;
    }
    keepRequest({ storage, pathname, params });
    reload();
  });
}

function keepRequest({ storage, pathname, params }: KeepRequestParams): void {
  storage.setItem(REQUEST_KEY, JSON.stringify({ path: pathname, params }));
}

/** The request kept for `pathname`, or null when none is kept or the kept one no longer parses. */
function readKeptRequest({ storage, pathname, route }: ReadKeptRequestParams): SessionRequest | null {
  const raw = storage.getItem(REQUEST_KEY);
  if (raw === null) {
    return null;
  }
  let entry: unknown;
  try {
    entry = JSON.parse(raw);
  } catch {
    // A kept entry that is not JSON is the documented no-request outcome.
    return null;
  }
  if (!isRecord(entry)) {
    return null;
  }
  const params = entry['params'];
  return entry['path'] === pathname && isRecord(params) ? readSessionRequest(route, params) : null;
}
