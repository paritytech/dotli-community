// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CONTENT_ERRORS, type ArchiveFiles } from '@dotli/content';
import { getErrorName, log } from '@dotli/shared';

export type CreateDecryptIfNeededParams = {
  /**
   * Resolves with the visitor's password, showing why the attempt before failed. Rejects when no password is given or
   * the prompt cannot be shown.
   */
  prompt: (options?: { error?: string }) => Promise<string>;
  /** Ends the host's loading screen, which would cover the prompt. A throw rejects the decryption with it. */
  dismissHostLoading: () => void;
  /** Whether `data` is encrypted content. Never throws. */
  isEncrypted: (data: Uint8Array) => boolean;
  /**
   * The plaintext of `data` under `password`. Rejects a wrong password with an error named
   * `CONTENT_ERRORS.WRONG_PASSWORD`, and data it cannot decrypt otherwise with any other error.
   */
  decryptContent: (data: Uint8Array, password: string) => Promise<Uint8Array>;
  /** The files the decrypted `data` holds. Rejects on data that holds none. */
  parseIpfsResponse: (data: Uint8Array) => Promise<ArchiveFiles>;
};

/**
 * A function that opens encrypted content with the visitor's password. It resolves the content's files, or `null` when
 * the data is not encrypted. It asks again after a wrong password, and rejects with what the prompt rejects with, or
 * with any other decryption or parse failure.
 */
export function createDecryptIfNeeded({
  prompt,
  dismissHostLoading,
  isEncrypted,
  decryptContent,
  parseIpfsResponse,
}: CreateDecryptIfNeededParams): (data: Uint8Array, cid: string) => Promise<ArchiveFiles | null> {
  // So a re-fetch of the same CID in this tab does not prompt again.
  const decryptedPasswords = new Map<string, string>();

  return decryptIfNeeded;

  async function decryptIfNeeded(data: Uint8Array, cid: string): Promise<ArchiveFiles | null> {
    if (!isEncrypted(data)) {
      return null;
    }
    log.event(`Content ${cid} is encrypted, asking for the password`, { flow: 'content' });

    let password = decryptedPasswords.get(cid);
    dismissHostLoading();

    let shownError: string | undefined;
    let attempt = 0;

    // Only a wrong password asks again. Any other failure is fatal, rather than an endless misleading prompt.
    for (;;) {
      password ??= await prompt(shownError !== undefined ? { error: shownError } : {});
      attempt += 1;
      try {
        const plaintext = await decryptContent(data, password);
        decryptedPasswords.set(cid, password);
        return await parseIpfsResponse(plaintext);
      } catch (error: unknown) {
        if (getErrorName(error) !== CONTENT_ERRORS.WRONG_PASSWORD) {
          throw error;
        }
        log.event(`Wrong password on attempt ${String(attempt)}, asking again`, { flow: 'content', attempt });
        shownError = 'Wrong password. Please try again.';
        password = undefined;
      }
    }
  }
}
