// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolves once `met` holds, checked now and at each DOM change rather than by polling, so a slow chunk under load
 * only takes longer.
 */
export function untilDom(met: () => boolean): Promise<void> {
  return new Promise(resolve => {
    if (met()) {
      resolve();
      return;
    }
    const observer = new MutationObserver(() => {
      if (met()) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true });
  });
}
