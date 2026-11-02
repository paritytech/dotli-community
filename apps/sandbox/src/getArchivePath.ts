// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference lib="webworker" />

/**
 * The archive path a request's `pathname` names under `base`, or `null` when its escapes do not decode, so it names no
 * archive file. Rethrows any other decode failure.
 */
export function getArchivePath(pathname: string, base: string): string | null {
  const relative = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.slice(1);
  try {
    return decodeURIComponent(relative);
  } catch (error) {
    if (error instanceof URIError) {
      return null;
    }
    throw error;
  }
}

/** Whether the last segment of `path` has a file extension. Never throws. */
export function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf('/');
  const lastDot = path.lastIndexOf('.');
  return lastDot > lastSlash;
}
