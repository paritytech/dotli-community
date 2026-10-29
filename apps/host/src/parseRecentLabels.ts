// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The recent list's stored form, the same in every store that holds it.

import { isValidDotLabel } from '@dotli/resolver';
import { MAX_RECENT } from './maxRecent.js';

/** Returns the usable labels of a stored list, dropping anything else and cut to the most it keeps. Never throws. */
export function parseRecentLabels(raw: string | null): string[] {
  if (raw === null || raw === '') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((label: unknown): label is string => typeof label === 'string' && isValidDotLabel(label))
      .slice(0, MAX_RECENT);
  } catch {
    // A stored list that is not JSON holds no usable label, so the list starts empty.
    return [];
  }
}

/** Returns the list as it is stored, cut to the most names it keeps. Never throws. */
export function serializeRecentLabels(labels: string[]): string {
  return JSON.stringify(labels.slice(0, MAX_RECENT));
}
