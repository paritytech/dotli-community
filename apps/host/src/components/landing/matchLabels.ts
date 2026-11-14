// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { typedName } from './dotUrl.js';

/** At most 6 labels that start with the typed name, shortest first, then alphabetical. None for empty text or no suffix. */
export function matchLabels(labels: readonly string[], text: string, suffix: string | null): string[] {
  if (suffix === null) {
    return [];
  }
  const prefix = typedName(text, suffix);
  if (prefix === '') {
    return [];
  }
  return labels
    .filter(label => label.startsWith(prefix))
    .sort((a, b) => a.length - b.length || compareText(a, b))
    .slice(0, 6);
}

// Code point order, since a locale order would move the hyphen a label may hold.
function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
