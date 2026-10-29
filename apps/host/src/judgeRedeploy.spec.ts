// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { toCachedManifest } from './cachedManifest.js';
import { judgeRedeploy } from './judgeRedeploy.js';
import { APP, APP_V2, ROOT } from './testing/manifestFixtures.js';

describe('cache revalidation', () => {
  it('As a dotli user, I come back to a redeployed app and it is cached again with the manifests it was redeployed with', () => {
    // When
    const decision = judgeRedeploy('bafy-fresh', { root: ROOT, app: APP });

    // Then
    expect(decision).toEqual({
      kind: 'update',
      cid: 'bafy-fresh',
      manifests: toCachedManifest({ root: ROOT, app: APP }),
    });
  });

  it('As a dotli user, I come back to an app redeployed with manifests this host cannot read and it is dropped from the cache', () => {
    // When
    const decision = judgeRedeploy('bafy-fresh', { root: ROOT, app: APP_V2 });

    // Then
    expect(decision).toEqual({ kind: 'evict', reason: 'rejected' });
  });
});
