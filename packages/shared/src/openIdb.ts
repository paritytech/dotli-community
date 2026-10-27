// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IdbOpenBlockedError } from './idbOpenBlockedError.js';

type Params = {
  factory: IDBFactory;
  name: string;
  version: number;
  upgrade: (db: IDBDatabase) => void;
};

/** Opens `name` at `version`, rejecting rather than hanging when an older tab blocks the upgrade. */
export function openIdb({ factory, name, version, upgrade }: Params): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => {
      upgrade(request.result);
    };
    // The caller already got the blocked rejection, so a late success has no owner and must not stay open.
    let abandoned = false;
    request.onsuccess = () => {
      if (abandoned) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => {
      // Only the cause keeps the DOMException's message for the report.
      const cause = request.error;
      reject(new Error(`Failed to open ${name} DB: ${cause?.name ?? 'unknown'}`, cause ? { cause } : undefined));
    };
    // A tab on an older schema blocks the upgrade, and blocked fires neither onsuccess nor onerror.
    request.onblocked = () => {
      abandoned = true;
      reject(new IdbOpenBlockedError(name));
    };
  });
}
