// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { DEV_PHRASE, entropyToMnemonic, mnemonicToEntropy } from '@polkadot-labs/hdkd-helpers';
import { toEntropy } from './recoveryPhrase.js';

describe('toEntropy', () => {
  it('As a user, I import a 12-word Polkadot App phrase and get its 16 bytes of entropy', () => {
    // Given
    const phrase = DEV_PHRASE;

    // When
    const entropy = toEntropy(phrase);

    // Then
    expect(entropy).toEqual(mnemonicToEntropy(DEV_PHRASE));
    expect(entropy?.length).toBe(16);
  });

  it('As a user pasting from my phone, I import a phrase with line breaks, extra spaces or capitals and get its entropy', () => {
    // Given
    const phrase = `  ${DEV_PHRASE.toUpperCase().split(' ').join('\n  ')}  `;

    // When
    const entropy = toEntropy(phrase);

    // Then
    expect(entropy).toEqual(mnemonicToEntropy(DEV_PHRASE));
  });

  it('As a user with a 24-word phrase, I import it and get its 32 bytes of entropy', () => {
    // Given
    const expected = Uint8Array.from({ length: 32 }, (_, index) => index);
    const phrase = entropyToMnemonic(expected);

    // When
    const entropy = toEntropy(phrase);

    // Then
    expect(entropy).toEqual(expected);
  });

  it('As a user who mistyped a word, I import the phrase and get nothing back', () => {
    // Given
    const words = DEV_PHRASE.split(' ');
    words[11] = words[11] === 'abandon' ? 'ability' : 'abandon';

    // When
    const entropy = toEntropy(words.join(' '));

    // Then
    expect(entropy).toBeNull();
  });

  it('As a user who pasted something else, I import it and get nothing back', () => {
    // Given
    const phrase = 'not a recovery phrase at all';

    // When
    const entropy = toEntropy(phrase);

    // Then
    expect(entropy).toBeNull();
  });
});
