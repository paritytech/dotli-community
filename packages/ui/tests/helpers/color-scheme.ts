// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from "vitest";

/**
 * Deterministic stand-in for the OS colour scheme, since happy-dom cannot
 * evaluate prefers-color-scheme queries. `set` changes it and notifies the
 * `change` listeners.
 */
export function stubColorScheme(initial: "light" | "dark"): {
  set: (scheme: "light" | "dark") => void;
} {
  let scheme = initial;
  const listeners = new Set<(e: Event) => void>();
  const mql = {
    get matches() {
      return scheme === "light";
    },
    media: "(prefers-color-scheme: light)",
    addEventListener: (_type: string, cb: (e: Event) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: (e: Event) => void) => {
      listeners.delete(cb);
    },
  };
  vi.stubGlobal("matchMedia", () => mql);
  return {
    set: (next) => {
      scheme = next;
      for (const cb of listeners) {
        cb(new Event("change"));
      }
    },
  };
}
