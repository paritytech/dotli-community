// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Renders one queued ModalView in the layout shared by the permission,
// preimage, confirmation and password dialogs.

import { createSignal, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { settleModal, type ModalButton, type ModalButtonVariant, type ModalEntry } from '../../state/modals.js';
import { Dialog } from './Dialog.js';
import s from './SigningDialog.module.css';

const BUTTON_CLASS: Record<ModalButtonVariant, string | undefined> = {
  cancel: s['cancel'],
  secondary: s['secondary'],
  primary: s['primary'],
};

/** Each variant's `data-testid`, the name its button has always had. */
const BUTTON_TEST_ID: Record<ModalButtonVariant, string> = {
  cancel: 'signing-btn-cancel',
  secondary: 'signing-btn-secondary',
  primary: 'signing-btn-sign',
};

export function SigningDialog(props: { entry: ModalEntry }): JSX.Element {
  // The outlet re-creates this component per entry (keyed), so reading once is intended.
  // eslint-disable-next-line solid/reactivity -- keyed entry, read once
  const { id, view } = props.entry;
  const titleId = `overlay-modal-title-${String(id)}`;
  const [password, setPassword] = createSignal('');
  let input: HTMLInputElement | undefined;

  const needsPassword = (button: ModalButton<string>): boolean =>
    view.input !== undefined && button.variant === 'primary';

  const choose = (button: ModalButton<string>): void => {
    if (needsPassword(button)) {
      if (password() === '') {
        return;
      }
      settleModal(id, button.result, password());
      return;
    }
    settleModal(id, button.result);
  };

  const dismiss = (): void => {
    if (view.dismissOnBackdrop && view.dismissResult !== undefined) {
      settleModal(id, view.dismissResult);
    }
  };

  const submitWithEnter = (): void => {
    const primary = view.buttons.find(b => b.variant === 'primary');
    if (primary !== undefined) {
      choose(primary);
    }
  };

  return (
    <Dialog titleId={titleId} initialFocus={() => input} onDismiss={dismiss} testId="signing-modal">
      <Show when={view.icon}>
        {icon => (
          // eslint-disable-next-line solid/no-innerhtml -- trusted SVG markup from ModalView.icon, not user input
          <div class={s['icon']} data-testid="permission-modal-icon" innerHTML={icon()} />
        )}
      </Show>
      <h2 class={s['title']} id={titleId}>
        {view.title}
      </h2>
      <div class={s['fields']}>
        <For each={view.fields}>
          {field => (
            <div class={s['field']} data-testid="signing-field" data-warning={field.warning === true ? '' : undefined}>
              <div class={s['fieldLabel']} data-testid="signing-field-label">
                {field.label}
              </div>
              <div
                class={s['fieldValue']}
                data-testid="signing-field-value"
                data-mono={field.mono === true ? '' : undefined}
              >
                {field.value}
              </div>
            </div>
          )}
        </For>
        <Show when={view.notice}>
          {notice => (
            <div class={s['notice']} data-testid="permission-modal-notice">
              {notice()}
            </div>
          )}
        </Show>
        <Show when={view.input}>
          {spec => (
            <>
              <Show when={spec().hint}>
                {hint => (
                  <div class={s['fieldValue']} data-testid="password-prompt-hint">
                    {hint()}
                  </div>
                )}
              </Show>
              <Show when={spec().error}>
                {error => (
                  <div class={s['passwordError']} data-testid="password-prompt-error" role="alert">
                    {error()}
                  </div>
                )}
              </Show>
              <input
                ref={el => {
                  input = el;
                }}
                type="password"
                class={s['passwordInput']}
                data-testid="password-prompt-input"
                aria-labelledby={titleId}
                placeholder={spec().placeholder}
                autocomplete="off"
                spellcheck="false"
                onInput={event => setPassword(event.currentTarget.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    submitWithEnter();
                  }
                }}
              />
            </>
          )}
        </Show>
      </div>
      <div class={s['footer']} data-testid="signing-modal-footer">
        <For each={view.buttons}>
          {button => (
            <button
              type="button"
              class={BUTTON_CLASS[button.variant]}
              data-testid={BUTTON_TEST_ID[button.variant]}
              disabled={needsPassword(button) && password() === ''}
              onClick={() => {
                choose(button);
              }}
            >
              {button.label}
            </button>
          )}
        </For>
      </div>
    </Dialog>
  );
}
