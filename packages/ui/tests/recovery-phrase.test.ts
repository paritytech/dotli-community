// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { DEV_PHRASE, entropyToMnemonic, mnemonicToEntropy } from '@polkadot-labs/hdkd-helpers';
import { phraseToEntropy } from '../src/recovery-phrase.js';

describe('phraseToEntropy', () => {
  it('As a user, I turn a 12-word Polkadot App phrase into its 16 bytes of entropy', () => {
    // Given
    const phrase = DEV_PHRASE;

    // When
    const entropy = phraseToEntropy(phrase);

    // Then
    expect(entropy).toEqual(mnemonicToEntropy(DEV_PHRASE));
    expect(entropy?.length).toBe(16);
  });

  it('As a user pasting from my phone, I am not tripped up by line breaks, extra spaces or capitals', () => {
    // Given
    const phrase = `  ${DEV_PHRASE.toUpperCase().split(' ').join('\n  ')}  `;

    // When
    const entropy = phraseToEntropy(phrase);

    // Then
    expect(entropy).toEqual(mnemonicToEntropy(DEV_PHRASE));
  });

  it('As a user with a 24-word phrase, I get its 32 bytes of entropy', () => {
    // Given
    const expected = Uint8Array.from({ length: 32 }, (_, i) => i);
    const phrase = entropyToMnemonic(expected);

    // When
    const entropy = phraseToEntropy(phrase);

    // Then
    expect(entropy).toEqual(expected);
  });

  it('As a user who mistyped a word, I get nothing back', () => {
    // Given
    const words = DEV_PHRASE.split(' ');
    words[11] = words[11] === 'abandon' ? 'ability' : 'abandon';

    // When
    const entropy = phraseToEntropy(words.join(' '));

    // Then
    expect(entropy).toBeNull();
  });

  it('As a user who pasted something else, I get nothing back', () => {
    // Given
    const phrase = 'not a recovery phrase at all';

    // When
    const entropy = phraseToEntropy(phrase);

    // Then
    expect(entropy).toBeNull();
  });
});
