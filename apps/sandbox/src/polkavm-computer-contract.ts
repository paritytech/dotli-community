// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const DOT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function expectedComputerHostOrigin(
  sandboxHostname: string,
  ancestorOrigin: string | null,
  referrer: string,
  baseDomain: string,
): string | null {
  const localSuffix = ".app.localhost";
  const productionSuffix = `.app.${baseDomain}`;
  const local = sandboxHostname.endsWith(localSuffix);
  const suffix = local ? localSuffix : productionSuffix;
  if (!sandboxHostname.endsWith(suffix)) {
    return null;
  }
  const label = sandboxHostname.slice(0, -suffix.length);
  if (!DOT_LABEL.test(label)) {
    return null;
  }

  const candidate = ancestorOrigin ?? referrer;
  if (candidate === "") {
    return null;
  }
  try {
    const url = new URL(candidate);
    if (url.origin === "null") {
      return null;
    }
    if (local) {
      return url.protocol === "http:" && url.hostname === `${label}.localhost`
        ? url.origin
        : null;
    }
    const expected = `https://${label}.${baseDomain}`;
    return url.origin === expected ? expected : null;
  } catch {
    return null;
  }
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
