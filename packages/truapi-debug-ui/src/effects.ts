// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the panel asks of the browser beyond its own DOM, handed down so a test can stand in for the browser.

import { createContext } from 'solid-js';

export interface PanelEffects {
  /** Rejects when the browser refuses, or when the origin has no clipboard. */
  writeClipboard: (text: string) => Promise<void>;
  /** Saves `json` as a file named `filename`. */
  download: (filename: string, json: string) => void;
}

export const pageEffects: PanelEffects = {
  writeClipboard: text => {
    // Typed as always present, but absent on non-secure origins.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    return clipboard === undefined
      ? Promise.reject(new Error('No clipboard on this origin'))
      : clipboard.writeText(text);
  },
  download: (filename, json) => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Safari silently aborts the download unless the link is attached and the URL revoked a tick later.
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  },
};

/** The page's own effects outside a panel, so a view rendered on its own still works. */
export const PanelEffectsContext = createContext<PanelEffects>(pageEffects);
