// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { releaseFromDescribe } from '../src/sentry-release.js';

describe('Sentry release names', () => {
  it('As a maintainer, a build of a release tag is that release', () => {
    expect(releaseFromDescribe('v0.9.2-0-g60c05e4\n')).toBe('dotli@0.9.2');
  });

  it('As a maintainer, a build after a release is a prerelease of the next patch that names its commit', () => {
    expect(releaseFromDescribe('v0.9.2-4-g60c05e4')).toBe('dotli@0.9.3-dev.4+60c05e4');
  });

  it('As a maintainer, a release candidate tag is released under its own name', () => {
    expect(releaseFromDescribe('v1.0.0-rc.1-0-gabc1234')).toBe('dotli@1.0.0-rc.1');
  });

  it('As a maintainer, a build after a release candidate sorts before the next candidate', () => {
    expect(releaseFromDescribe('v1.0.0-rc.1-3-gabc1234')).toBe('dotli@1.0.0-rc.1.dev.3+abc1234');
  });

  it('As a maintainer, a tag that is not semver names no release', () => {
    expect(releaseFromDescribe('vnext-2-gabc1234')).toBeNull();
    expect(releaseFromDescribe('abc1234')).toBeNull();
  });
});
