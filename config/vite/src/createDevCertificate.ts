// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Plugin, PluginOption } from 'vite';
import mkcert from 'vite-plugin-mkcert';

/**
 * Returns a plugin that serves the dev servers over https with a locally trusted certificate for `roots` and their
 * subdomains, since Safari keeps `Secure` cookies and the session window's opener rule off plain http on any host but
 * localhost. Previews stay on http. Never throws.
 */
export function createDevCertificate(roots: readonly string[]): PluginOption {
  // Its declarations type the result as any `PluginOption`, but it is one plugin object.
  const plugin = mkcert({
    hosts: roots.flatMap(root => [root, `*.${root}`, `*.app.${root}`]),
  }) as Plugin;
  // Its own `apply` takes only a command, and 'serve' covers the preview server too.
  return { ...plugin, apply: (_config, { command, isPreview }) => command === 'serve' && isPreview !== true };
}
