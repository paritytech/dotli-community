// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ArchiveFiles } from '@dotli/content';

import { createDecryptIfNeeded, type DecryptDeps } from './decrypt-prompt.js';

const CID = 'bafyEncrypted';
const CIPHERTEXT = new Uint8Array([1, 2, 3]);
const FILES: ArchiveFiles = { 'index.html': new TextEncoder().encode('<html></html>') };

interface Visitor {
  deps: DecryptDeps;
  /** The error each prompt showed, in order. */
  prompts: (string | undefined)[];
  dismissed: () => number;
  /** What the decrypt asked of the page, in order. */
  steps: string[];
}

/** A visitor who types `passwords` in turn. Only `secret` opens the content, and a corrupt archive fails any password. */
function visitor(passwords: string[], options: { corrupt?: boolean } = {}): Visitor {
  const prompts: (string | undefined)[] = [];
  let dismissed = 0;
  const steps: string[] = [];
  const deps: DecryptDeps = {
    prompt: ({ error } = {}) => {
      steps.push('prompt');
      prompts.push(error);
      const password = passwords.shift();
      return password === undefined ? new Promise<string>(() => undefined) : Promise.resolve(password);
    },
    preparePrompt: () => {
      steps.push('prepare');
    },
    dismissHostLoading: () => {
      steps.push('dismiss');
      dismissed += 1;
    },
    isEncrypted: data => data === CIPHERTEXT,
    decryptContent: (_data, password) => {
      if (options.corrupt === true) {
        return Promise.reject(new Error('ciphertext is truncated'));
      }
      return password === 'secret' ? Promise.resolve(new Uint8Array([9])) : Promise.reject(new Error('invalid tag'));
    },
    parseIpfsResponse: () => Promise.resolve(FILES),
  };
  return { deps, prompts, dismissed: () => dismissed, steps };
}

describe('createDecryptIfNeeded', () => {
  it('As a visitor, I enter a wrong password and am asked again, and the right one opens the content', async () => {
    // Given
    const { deps, prompts, dismissed } = visitor(['guess', 'secret']);
    const decryptIfNeeded = createDecryptIfNeeded(deps);

    // When
    const files = await decryptIfNeeded(CIPHERTEXT, CID);

    // Then
    expect(files).toBe(FILES);
    expect(prompts).toEqual([undefined, 'Wrong password. Please try again.']);
    expect(dismissed()).toBe(1);
  });

  it('As a visitor of encrypted content, the prompt starts loading before the loading screen goes, once', async () => {
    // Given
    const { deps, steps } = visitor(['guess', 'secret']);
    const decryptIfNeeded = createDecryptIfNeeded(deps);

    // When
    await decryptIfNeeded(CIPHERTEXT, CID);

    // Then
    expect(steps).toEqual(['prepare', 'dismiss', 'prompt', 'prompt']);
  });

  it('As a visitor, a corrupt archive fails at once rather than asking me again', async () => {
    // Given
    const { deps, prompts } = visitor(['secret'], { corrupt: true });
    const decryptIfNeeded = createDecryptIfNeeded(deps);

    // When
    const opened = decryptIfNeeded(CIPHERTEXT, CID);

    // Then
    await expect(opened).rejects.toThrow('ciphertext is truncated');
    expect(prompts).toHaveLength(1);
  });

  it('As a visitor, the same content fetched again in my tab opens without a second prompt', async () => {
    // Given content I already unlocked
    const { deps, prompts, steps } = visitor(['secret']);
    const decryptIfNeeded = createDecryptIfNeeded(deps);
    await decryptIfNeeded(CIPHERTEXT, CID);

    // When
    const files = await decryptIfNeeded(CIPHERTEXT, CID);

    // Then
    expect(files).toBe(FILES);
    expect(prompts).toHaveLength(1);
    expect(steps.filter(step => step === 'prepare')).toHaveLength(1);
  });

  it('As a visitor, content that is not encrypted passes through without a prompt', async () => {
    // Given
    const { deps, prompts, steps } = visitor([]);
    const decryptIfNeeded = createDecryptIfNeeded(deps);

    // When
    const files = await decryptIfNeeded(new Uint8Array([7]), CID);

    // Then
    expect(files).toBeNull();
    expect(prompts).toEqual([]);
    expect(steps).toEqual([]);
  });
});
