// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createMorphCount } from './createMorphCount.js';

describe('createMorphCount', () => {
  it('As a user opening a menu from the pill, I wait out two overlapping bar morphs and the menu waits for the last to end, and an end with none running ends nothing', () => {
    // Given two overlapping morphs
    const morphs = createMorphCount({ areTransitionsRunning: () => true });
    morphs.start();
    morphs.start();

    // When they end, and an end comes with none running
    const answers = {
      firstEnd: morphs.end(),
      runningAfterFirst: morphs.isRunning(),
      lastEnd: morphs.end(),
      runningAfterLast: morphs.isRunning(),
      extraEnd: morphs.end(),
    };

    // Then
    expect(answers).toEqual({
      firstEnd: false,
      runningAfterFirst: true,
      lastEnd: true,
      runningAfterLast: false,
      extraEnd: false,
    });
  });

  it('As a user opening a menu from the pill, I lose the end event of a morph and the menu still reads its box', () => {
    // Given a fold that started and was dropped without a transitionend or transitioncancel
    const morphs = createMorphCount({ areTransitionsRunning: () => false });
    morphs.start();

    // When
    const running = morphs.isRunning();

    // Then
    expect(running).toBe(false);
  });

  it('As a user opening a menu from the pill, I lose the end event of one morph and the next morph still ends the wait', () => {
    // Given a fold dropped without its end event, then a reveal, with no read of the count between them
    const morphs = createMorphCount({ areTransitionsRunning: () => false });
    morphs.start();
    morphs.start();

    // When the reveal ends
    const ended = morphs.end();

    // Then
    expect(ended).toBe(true);
  });
});
