// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModalView } from '@dotli/ui';
import type { PasswordDialogModule } from './lazy.js';

export interface PasswordPromptDeps {
  /** The dialog view's chunk. */
  load: () => Promise<PasswordDialogModule>;
  /** Shows a password dialog and resolves with the password typed. */
  show: (view: ModalView<'cancel' | 'unlock'>) => Promise<string>;
}

export interface PasswordPrompt {
  /** Starts loading the dialog, once the content is known to need it. A `prompt` call follows. */
  prepare: () => void;
  /** Asks for the password, showing why the attempt before failed. Rejects with the load's error if it failed. */
  prompt: (options?: { error?: string }) => Promise<string>;
}

/**
 * The sandbox's password prompt. Only encrypted content needs the dialog, so its view loads on demand. One load serves
 * both calls, so a failed chunk reaches the visitor once, through the prompt.
 */
export function createPasswordPrompt(deps: PasswordPromptDeps): PasswordPrompt {
  let dialog: Promise<PasswordDialogModule> | undefined;
  const loaded = (): Promise<PasswordDialogModule> => (dialog ??= deps.load());
  return {
    prepare: () => {
      // The prompt that follows awaits the same promise, which reports a failure.
      void loaded();
    },
    prompt: async options => {
      const { passwordPromptDialog } = await loaded();
      return deps.show(passwordPromptDialog(options));
    },
  };
}
