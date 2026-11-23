// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { followOrientation } from './followOrientation.js';
import { followPointer } from './followPointer.js';
import { pickOrbitFollower } from './pickOrbitFollower.js';

describe('pickOrbitFollower', () => {
  it.each([
    {
      who: 'with a mouse who asks for less motion',
      lessMotion: true,
      finePointer: true,
      follower: null,
      follows: 'no input',
    },
    { who: 'with a mouse', lessMotion: false, finePointer: true, follower: followPointer, follows: 'the pointer' },
    {
      who: 'on a phone',
      lessMotion: false,
      finePointer: false,
      follower: followOrientation,
      follows: 'the phone tilt',
    },
  ])('As a visitor $who, I see the orbit follow $follows', ({ lessMotion, finePointer, follower }) => {
    // Given
    function matchMedia(query: string) {
      return { matches: query.includes('reduced-motion') ? lessMotion : finePointer };
    }

    // When
    const picked = pickOrbitFollower(matchMedia);

    // Then
    expect(picked).toBe(follower);
  });
});
