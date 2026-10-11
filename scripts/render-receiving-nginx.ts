// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseReceivingOrigins } from '@dotli/config/receiving';
import { renderReceivingNginx } from './receiving-nginx.ts';

const [manifest, site, output] = process.argv.slice(2);
if (
  manifest === undefined ||
  manifest === '' ||
  site === undefined ||
  site === '' ||
  output === undefined ||
  output === ''
) {
  throw new Error(
    'Usage: node scripts/render-receiving-nginx.ts <host-receiving-config.json> <site> <snippet-directory>',
  );
}
// Read the matching build artifact, not a second environment configuration.
const entries = parseReceivingOrigins(await readFile(manifest, 'utf8'));
const { csp, proxy } = renderReceivingNginx(entries, site);
await writeFile(resolve(output, 'dotli-receiving-csp.conf'), csp);
await writeFile(resolve(output, 'dotli-receiving-proxy.conf'), proxy);
