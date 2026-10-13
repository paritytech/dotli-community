// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ArchiveFiles } from '@dotli/content';
import { log } from '@dotli/shared';

export interface DecryptDeps {
  /** Asks the visitor for the password, showing why the attempt before failed. */
  prompt: (options?: { error?: string }) => Promise<string>;
  /** The host's loading screen would cover the prompt. */
  dismissHostLoading: () => void;
  isEncrypted: (data: Uint8Array) => boolean;
  decryptContent: (data: Uint8Array, password: string) => Promise<Uint8Array>;
  parseIpfsResponse: (data: Uint8Array) => Promise<ArchiveFiles>;
}

/** Opens encrypted content with the visitor's password. Resolves `null` when the data is not encrypted. */
export function createDecryptIfNeeded(
  deps: DecryptDeps,
): (data: Uint8Array, cid: string) => Promise<ArchiveFiles | null> {
  // So a re-fetch of the same CID in this tab does not prompt again.
  const decryptedPasswords = new Map<string, string>();

  return async (data, cid) => {
    if (!deps.isEncrypted(data)) {
      return null;
    }
    log.event(`Content ${cid} is encrypted, asking for the password`, { flow: 'content' });

    let password = decryptedPasswords.get(cid);
    deps.dismissHostLoading();

    let error: string | undefined;
    let attempt = 0;

    // Only an auth-tag mismatch is a wrong password. Any other error is fatal, rather than an endless misleading prompt.
    for (;;) {
      password ??= await deps.prompt(error !== undefined ? { error } : {});
      attempt += 1;
      try {
        const plaintext = await deps.decryptContent(data, password);
        decryptedPasswords.set(cid, password);
        return await deps.parseIpfsResponse(plaintext);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const looksLikeWrongPassword = /invalid tag|auth(entication)? failed|poly1305|chacha/i.test(msg);
        if (!looksLikeWrongPassword) {
          throw err;
        }
        log.event(`Wrong password on attempt ${String(attempt)}, asking again`, { flow: 'content', attempt });
        error = 'Wrong password. Please try again.';
        password = undefined;
      }
    }
  };
}
