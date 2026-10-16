// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Runtime config reaches documents through a global, but the protocol SharedWorker has no document and builds the
// built-in table. That is safe only while the worker reads fields an override cannot change.

const REPO = resolve(import.meta.dirname, '../../..');

/** Fields a runtime override may set, and therefore may differ per context. */
const OVERRIDABLE_FIELDS = ['label', 'rpcs', 'ipfsGateways'] as const;

/** The worker and the resolver modules it imports that read the network table. */
const WORKER_GRAPH = [
  'apps/protocol/src/protocol-shared-worker.ts',
  'packages/resolver/src/provider.ts',
  'packages/resolver/src/resolve.ts',
] as const;

function read(relative: string): string {
  return readFileSync(resolve(REPO, relative), 'utf8');
}

describe('worker / document override isolation', () => {
  it('As a maintainer, I see the worker read only fields an override cannot change', () => {
    for (const file of WORKER_GRAPH) {
      const source = read(file);
      // Reads off the config, directly or through a local `cfg` alias.
      const reads = [
        ...source.matchAll(/(?:getActiveServicesConfig\(\)|\bcfg)\.(?:relay|assethub|bulletin|people)\.(\w+)/g),
      ].map(m => m[1]);

      for (const field of reads) {
        expect(
          OVERRIDABLE_FIELDS as readonly string[],
          `${file} reads .${String(field)} off the network table. That field is ` +
            `overridable, so the worker would see a different value than the ` +
            `documents. Either stop reading it in the worker, or plumb runtime ` +
            `config into the worker so both agree.`,
        ).not.toContain(field);
      }
    }
  });

  it('As a maintainer, I see genesis and dotns stay non-overridable', () => {
    const source = read('packages/config/src/network.ts');

    // Merges copy genesis from the built-in, never the patch.
    const chainMerges = [...source.matchAll(/function merge(?:Chain|Bulletin)\([^]*?\n\}/g)];
    expect(chainMerges.length).toBeGreaterThan(0);
    for (const [body] of chainMerges) {
      expect(body).toContain('genesis: base.genesis');
    }

    const allowLists = [...source.matchAll(/checkFields\(\s*p,\s*(\[[^\]]*\])/g)].map(m => m[1]).join(' ');
    expect(allowLists).not.toContain('genesis');
    expect(allowLists).not.toContain('dotns');
  });
});
