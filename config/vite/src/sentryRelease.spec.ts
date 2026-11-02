// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseReleaseName } from './sentryRelease.js';

describe('Sentry release names', () => {
  it.each<[story: string, described: string, release: string | null]>([
    ['a release tag, and it is that release', 'v0.9.2-0-g60c05e4\n', 'dotli@0.9.2'],
    [
      'after a release, and it is a prerelease of the next patch that names its commit',
      'v0.9.2-4-g60c05e4',
      'dotli@0.9.3-dev.4+60c05e4',
    ],
    ['a release candidate tag, and it is released under its own name', 'v1.0.0-rc.1-0-gabc1234', 'dotli@1.0.0-rc.1'],
    [
      'after a release candidate, and it sorts before the next candidate',
      'v1.0.0-rc.1-3-gabc1234',
      'dotli@1.0.0-rc.1.dev.3+abc1234',
    ],
    ['a tag that is not semver, and it names no release', 'vnext-2-gabc1234', null],
    ['a commit with no tag, and it names no release', 'abc1234', null],
  ])('As a maintainer, I build %s', (_story, described, release) => {
    // Given the row's `git describe` output and expected release

    // When
    const name = parseReleaseName(described);

    // Then
    expect(name).toBe(release);
  });
});
