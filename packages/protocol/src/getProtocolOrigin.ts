// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN, DEV_HOST_PORT, LOCAL_ROOT } from '@dotli/config';

/** The page's own facts, so a spec can place the page without a `window`. */
export type ProtocolOriginEnv = {
  /** The local root the page is served under, which a local frame shares, or `null` when deployed. */
  localRoot: string | null;
  /** Whether the page is a development build. */
  dev: boolean;
  /** The page's own scheme with its colon, which a local frame shares. */
  protocol: string;
  /** The page's own port, empty for the scheme's default. */
  port: string;
};

/** The origin the hidden protocol frame loads from: the root domain's, or the local root's on a local page. */
export function getProtocolOrigin(env: ProtocolOriginEnv = readPageEnv()): string {
  if (env.localRoot !== null) {
    // Dev serves the frame from the host's own dev server. Preview and tests serve it on the page's port.
    const port = getLocalPort(env);
    return `${env.protocol}//${env.localRoot}:${port}`;
  }
  return `https://${BASE_DOMAIN}`;
}

function readPageEnv(): ProtocolOriginEnv {
  const { protocol, port } = window.location;
  return { localRoot: LOCAL_ROOT, dev: import.meta.env.DEV, protocol, port };
}

function getLocalPort(env: ProtocolOriginEnv): string {
  if (env.dev) {
    return DEV_HOST_PORT;
  }
  return env.port.length > 0 ? env.port : '5173';
}
