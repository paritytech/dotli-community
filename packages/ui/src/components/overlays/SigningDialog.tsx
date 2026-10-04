// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { settleModal, type ModalButton, type ModalButtonVariant, type ModalEntry } from '../../state/modals.js';
import { Button, type ButtonVariant } from '../primitives/Button.js';
import { Field } from '../primitives/Field.js';
import { IconTile } from '../primitives/IconTile.js';
import { ReloadIcon } from '../primitives/Surface.js';
import { Callout, Well } from '../primitives/Well.js';
import { Dialog } from './Dialog.js';
import s from './SigningDialog.module.css';

const BUTTON_VARIANT: Record<ModalButtonVariant, ButtonVariant> = {
  danger: 'danger',
  cancel: 'secondary',
  secondary: 'secondary',
  primary: 'primary',
};

// A reject keeps the cancel test id: it is the same answer, drawn destructive.
const BUTTON_TEST_ID: Record<ModalButtonVariant, string> = {
  danger: 'signing-btn-cancel',
  cancel: 'signing-btn-cancel',
  secondary: 'signing-btn-secondary',
  primary: 'signing-btn-sign',
};

/**
 * One queued prompt as the board's modal: the icon tile over the centred
 * title, a well of fields, the notice, the password input, and a row of
 * equal-width answers. At 560 px and below the dialog is a bottom sheet led
 * by the title alone (SigningDialog.module.css).
 */
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
      <div class={s['head']}>
        <Show when={view.icon}>
          {icon => <IconTile markup={icon()} class={s['icon']} testId="permission-modal-icon" />}
        </Show>
        <h2 class={s['title']} id={titleId}>
          {view.title}
        </h2>
      </div>
      <div class={s['body']}>
        <Show when={view.fields.length > 0}>
          <Well layout="list">
            <For each={view.fields}>
              {field => (
                <Field
                  label={field.label}
                  value={field.value}
                  mono={field.mono === true}
                  warning={field.warning === true}
                  testId="signing-field"
                  labelTestId="signing-field-label"
                  valueTestId="signing-field-value"
                />
              )}
            </For>
          </Well>
        </Show>
        <Show when={view.notice}>
          {notice => (
            // The one notice says the app reloads, hence the board's reload arrow.
            <Callout icon={<ReloadIcon />} testId="permission-modal-notice">
              {notice()}
            </Callout>
          )}
        </Show>
        <Show when={view.input}>
          {spec => (
            <>
              <Show when={spec().hint}>
                {hint => (
                  <p class={s['caption']} data-testid="password-prompt-hint">
                    {hint()}
                  </p>
                )}
              </Show>
              <Show when={spec().error}>
                {error => (
                  <p class={s['error']} data-testid="password-prompt-error" role="alert">
                    {error()}
                  </p>
                )}
              </Show>
              <input
                ref={el => {
                  input = el;
                }}
                type="password"
                class={s['input']}
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
      <div class={s['actions']} data-testid="signing-modal-footer">
        <For each={view.buttons}>
          {button => (
            <Button
              variant={BUTTON_VARIANT[button.variant]}
              block
              class={s['action']}
              testId={BUTTON_TEST_ID[button.variant]}
              disabled={needsPassword(button) && password() === ''}
              onClick={() => {
                choose(button);
              }}
            >
              {button.label}
            </Button>
          )}
        </For>
      </div>
    </Dialog>
  );
}
