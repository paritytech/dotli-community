// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** The typed name, already parsed. */
  name: string;
  /** The recently visited names, newest first. */
  recents: readonly string[];
  /** Every app label the list may suggest. */
  apps: readonly string[];
};

/**
 * The suggestions for a typed name, in two sections. `recent` holds the recents that start with it, in their order, so
 * an empty name keeps them all. `apps` holds at most 6 app labels that start with a non-empty name, shortest first, then
 * in code point order. An app that is also a recent shows once, under `recent`.
 */
export function matchSuggestions({ name, recents, apps }: Params): { recent: string[]; apps: string[] } {
  const recent = recents.filter(label => label.startsWith(name));
  if (name === '') {
    return { recent, apps: [] };
  }
  const visited = new Set(recents);
  return {
    recent,
    apps: apps
      .filter(label => label.startsWith(name) && !visited.has(label))
      .sort((a, b) => a.length - b.length || compareText(a, b))
      .slice(0, 6),
  };
}

// Code point order, since a locale order would move the hyphen a label may hold.
function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
