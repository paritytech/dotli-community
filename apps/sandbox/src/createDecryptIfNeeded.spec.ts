// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { CONTENT_ERRORS, type ArchiveFiles } from '@dotli/content';
import { setErrorName } from '@dotli/shared';

import { createDecryptIfNeeded, type CreateDecryptIfNeededParams } from './createDecryptIfNeeded.js';

type Visitor = {
  /** The page the decrypt runs against, answered as this visitor would. */
  deps: CreateDecryptIfNeededParams;
  /** The error each prompt showed, in order. */
  prompts: (string | undefined)[];
  /** How often the host's loading screen was ended. */
  dismissed: () => number;
  /** What the decrypt asked of the page, in order. */
  steps: string[];
};

const CID = 'bafyEncrypted';
const CIPHERTEXT = new Uint8Array([1, 2, 3]);
const FILES: ArchiveFiles = { 'index.html': new TextEncoder().encode('<html></html>') };

/** A visitor who types `passwords` in turn. Only `secret` opens the content, and a corrupt archive fails any password. */
function createVisitor(passwords: string[], options: { corrupt?: boolean } = {}): Visitor {
  const prompts: (string | undefined)[] = [];
  let dismissed = 0;
  const steps: string[] = [];
  const deps: CreateDecryptIfNeededParams = {
    prompt({ error } = {}) {
      steps.push('prompt');
      prompts.push(error);
      const password = passwords.shift();
      return password === undefined ? new Promise<string>(() => undefined) : Promise.resolve(password);
    },
    dismissHostLoading() {
      steps.push('dismiss');
      dismissed += 1;
    },
    isEncrypted: data => data === CIPHERTEXT,
    decryptContent(_data, password) {
      if (options.corrupt === true) {
        return Promise.reject(new Error('ciphertext is truncated'));
      }
      if (password !== 'secret') {
        return Promise.reject(
          setErrorName(new Error('The password does not open the encrypted content'), CONTENT_ERRORS.WRONG_PASSWORD),
        );
      }
      return Promise.resolve(new Uint8Array([9]));
    },
    parseIpfsResponse: () => Promise.resolve(FILES),
  };
  return { deps, prompts, dismissed: () => dismissed, steps };
}

describe('createDecryptIfNeeded', () => {
  it('As a visitor, I enter a wrong password and am asked again, and the right one opens the content', async () => {
    // Given
    const { deps, prompts, dismissed } = createVisitor(['guess', 'secret']);
    const decryptIfNeeded = createDecryptIfNeeded(deps);

    // When
    const files = await decryptIfNeeded(CIPHERTEXT, CID);

    // Then
    expect(files).toBe(FILES);
    expect(prompts).toEqual([undefined, 'Wrong password. Please try again.']);
    expect(dismissed()).toBe(1);
  });

  it('As a visitor of encrypted content, I open it and the loading screen goes once, before the prompt asks me', async () => {
    // Given
    const { deps, steps } = createVisitor(['guess', 'secret']);
    const decryptIfNeeded = createDecryptIfNeeded(deps);

    // When
    await decryptIfNeeded(CIPHERTEXT, CID);

    // Then
    expect(steps).toEqual(['dismiss', 'prompt', 'prompt']);
  });

  it('As a visitor, I open a corrupt archive and it fails at once rather than asking me again', async () => {
    // Given
    const { deps, prompts } = createVisitor(['secret'], { corrupt: true });
    const decryptIfNeeded = createDecryptIfNeeded(deps);

    // When
    const opened = decryptIfNeeded(CIPHERTEXT, CID);

    // Then
    await expect(opened).rejects.toThrow('ciphertext is truncated');
    expect(prompts).toHaveLength(1);
  });

  it('As a visitor, I fetch the same content again in my tab and it opens without a second prompt', async () => {
    // Given content I already unlocked
    const { deps, prompts } = createVisitor(['secret']);
    const decryptIfNeeded = createDecryptIfNeeded(deps);
    await decryptIfNeeded(CIPHERTEXT, CID);

    // When
    const files = await decryptIfNeeded(CIPHERTEXT, CID);

    // Then
    expect(files).toBe(FILES);
    expect(prompts).toHaveLength(1);
  });

  it('As a visitor, I open content that is not encrypted and it passes through without a prompt', async () => {
    // Given
    const { deps, prompts, steps } = createVisitor([]);
    const decryptIfNeeded = createDecryptIfNeeded(deps);

    // When
    const files = await decryptIfNeeded(new Uint8Array([7]), CID);

    // Then
    expect(files).toBeNull();
    expect(prompts).toEqual([]);
    expect(steps).toEqual([]);
  });
});
