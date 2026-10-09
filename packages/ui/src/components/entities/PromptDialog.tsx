// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { settleModal, type ModalButton, type ModalButtonVariant, type ModalEntry } from '../../state/modals.js';
import { Modal } from '../floating/Modal.js';
import { Button, type ButtonVariant } from '../primitives/Button.js';
import { Field } from '../primitives/Field.js';
import { ReloadIcon } from '../primitives/Surface.js';
import { Callout, InfoIcon, Well } from '../primitives/Well.js';
import s from './PromptDialog.module.css';

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
 * Every queued app prompt (a permission request, the password prompt, a
 * preimage submit, a transaction or message to sign, a host-owned pick such
 * as a Chat contact) drawn as a Modal: its head, a well of fields, the
 * notice, the host's choices, the password input, and the answers.
 * A view with a `selection` draws its choices as a searchable checkbox list
 * whose edits only its primary answer confirms.
 * The close button (or a swipe) answers as the scrim does, and on a prompt
 * the scrim cannot dismiss, as its Cancel (or else its danger reject) does.
 */
export function PromptDialog(props: { entry: ModalEntry }): JSX.Element {
  // eslint-disable-next-line solid/reactivity -- keyed entry, read once
  const { id, view } = props.entry;
  const titleId = `overlay-modal-title-${String(id)}`;
  const [password, setPassword] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [selected, setSelected] = createSignal(new Set(view.selection?.selected));
  let input: HTMLInputElement | undefined;
  let search: HTMLInputElement | undefined;
  let firstChoice: HTMLButtonElement | undefined;

  const matches = (choice: { label: string }): boolean =>
    choice.label.toLowerCase().includes(query().trim().toLowerCase());

  const toggle = (result: string, checked: boolean): void => {
    const next = new Set(selected());
    if (checked) {
      next.add(result);
    } else {
      next.delete(result);
    }
    setSelected(next);
  };

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
    settleModal(
      id,
      button.result,
      undefined,
      view.selection !== undefined && button.variant === 'primary' ? [...selected()] : undefined,
    );
  };

  const dismiss = (): void => {
    if (view.dismissOnBackdrop && view.dismissResult !== undefined) {
      settleModal(id, view.dismissResult);
    }
  };

  // Close always answers, so no prompt shape leaves a dead button.
  const close = (): void => {
    if (view.dismissOnBackdrop && view.dismissResult !== undefined) {
      settleModal(id, view.dismissResult);
      return;
    }
    const decline = view.buttons.find(b => b.variant === 'cancel') ?? view.buttons.find(b => b.variant === 'danger');
    if (decline !== undefined) {
      choose(decline);
    }
  };

  const submitWithEnter = (): void => {
    const primary = view.buttons.find(b => b.variant === 'primary');
    if (primary !== undefined) {
      choose(primary);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(_, reason) => {
        if (reason === 'close') {
          close();
        } else {
          dismiss();
        }
      }}
      title={view.title}
      labelledBy={titleId}
      initialFocus={() => input ?? search ?? firstChoice}
      testId="signing-modal"
    >
      <Modal.Head titleId={titleId} title={view.title} icon={view.icon} iconTestId="permission-modal-icon" />
      <Modal.Body>
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
            // A reload notice leads with the board's reload arrow, anything else with info.
            <Callout icon={view.noticeIcon === 'info' ? <InfoIcon /> : <ReloadIcon />} testId="permission-modal-notice">
              {notice()}
            </Callout>
          )}
        </Show>
        <Show when={view.selection}>
          {selection => (
            <>
              <input
                ref={el => {
                  search = el;
                }}
                type="search"
                class={s['input']}
                data-testid="prompt-choice-search"
                placeholder="Search contacts"
                aria-label="Search contacts"
                autocomplete="off"
                spellcheck="false"
                onInput={event => setQuery(event.currentTarget.value)}
              />
              <p class={s['caption']} data-testid="prompt-choice-status" role="status">
                {selected().size === 0
                  ? 'No contacts selected. Use selection to remove everyone.'
                  : `${String(selected().size)} selected${selected().size === selection().limit ? ' (selection limit)' : ''}`}
              </p>
            </>
          )}
        </Show>
        <Show when={view.choices}>
          {choices => (
            <div
              class={s['choices']}
              data-selection={view.selection === undefined ? undefined : ''}
              data-testid="prompt-choices"
            >
              <For each={choices()}>
                {choice => (
                  <Show
                    when={view.selection}
                    fallback={
                      <Button
                        ref={el => {
                          firstChoice ??= el;
                        }}
                        block
                        class={s['choice']}
                        testId="prompt-choice"
                        onClick={() => {
                          settleModal(id, choice.result);
                        }}
                      >
                        {choice.label}
                      </Button>
                    }
                  >
                    {selection => (
                      <label class={s['check']} data-testid="prompt-choice" hidden={!matches(choice)}>
                        <input
                          type="checkbox"
                          class={s['box']}
                          checked={selected().has(choice.result)}
                          disabled={!selected().has(choice.result) && selected().size >= selection().limit}
                          onChange={event => {
                            toggle(choice.result, event.currentTarget.checked);
                          }}
                        />
                        <span class={s['label']}>{choice.label}</span>
                      </label>
                    )}
                  </Show>
                )}
              </For>
              <Show when={view.selection !== undefined && !choices().some(matches)}>
                <p class={s['caption']} role="status">
                  No matching contacts
                </p>
              </Show>
            </div>
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
      </Modal.Body>
      <Modal.Actions testId="signing-modal-footer">
        <For each={view.buttons}>
          {button => (
            <Button
              variant={BUTTON_VARIANT[button.variant]}
              block
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
      </Modal.Actions>
    </Modal>
  );
}
