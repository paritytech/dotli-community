// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const DOT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function expectedComputerHostOrigin(
  sandboxHostname: string,
  protocol: string,
  port: string,
  baseDomain: string,
  ancestorOrigin: string | null,
  referrer: string,
): string | null {
  if (protocol !== "https:" && protocol !== "http:") {
    return null;
  }
  const localSuffix = ".app.localhost";
  const productionSuffix = `.app.${baseDomain}`;
  const local = sandboxHostname.endsWith(localSuffix);
  const suffix = local ? localSuffix : productionSuffix;
  if (!sandboxHostname.endsWith(suffix)) {
    return null;
  }
  const label = sandboxHostname.slice(0, -suffix.length);
  if (!DOT_LABEL.test(label) || (!local && protocol !== "https:")) {
    return null;
  }

  const host = local ? `${label}.localhost` : `${label}.${baseDomain}`;
  const expected = `${protocol}//${host}${port === "" ? "" : `:${port}`}`;
  for (const candidate of [ancestorOrigin, referrer]) {
    if (candidate === null || candidate === "") {
      continue;
    }
    try {
      if (new URL(candidate).origin !== expected) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return expected;
}

interface ComputerDatabase {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): void;
}

export function computerNetworkEnabled(
  requested: boolean,
  relayUrl: string,
): boolean {
  return requested && relayUrl !== "";
}

export function ensureComputerDatabaseStores(database: ComputerDatabase): void {
  for (const name of ["saves", "translations"]) {
    if (!database.objectStoreNames.contains(name)) {
      database.createObjectStore(name);
    }
  }
}

export interface NetworkPermissionSession {
  decide(domain: string, request: () => Promise<boolean>): Promise<boolean>;
}

export function createNetworkPermissionSession(
  maxDistinctDomains: number,
  maxConcurrentRequests: number,
): NetworkPermissionSession {
  const decisions = new Map<string, Promise<boolean>>();
  let pending = 0;
  return {
    decide(domain, request) {
      const key = domain.toLowerCase().replace(/\.$/, "");
      if (key === "") {
        return Promise.resolve(false);
      }
      const existing = decisions.get(key);
      if (existing !== undefined) {
        return existing;
      }
      if (
        decisions.size >= maxDistinctDomains ||
        pending >= maxConcurrentRequests
      ) {
        return Promise.resolve(false);
      }
      pending += 1;
      const decision = Promise.resolve()
        .then(request)
        .finally(() => {
          pending -= 1;
        });
      decisions.set(key, decision);
      void decision.catch(() => {
        if (decisions.get(key) === decision) {
          decisions.delete(key);
        }
      });
      return decision;
    },
  };
}

export function createRetryableLazyPromise<T>(
  factory: () => Promise<T>,
): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return (): Promise<T> => {
    if (cached !== null) {
      return cached;
    }
    const attempt = factory();
    cached = attempt;
    void attempt.catch(() => {
      if (cached === attempt) {
        cached = null;
      }
    });
    return attempt;
  };
}
