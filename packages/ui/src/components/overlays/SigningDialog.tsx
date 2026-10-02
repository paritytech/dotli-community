// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Renders one queued ModalView with the signing-modal markup shared by the
// permission, preimage, confirmation and password dialogs.

import { createSignal, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { settleModal, type ModalButton, type ModalButtonVariant, type ModalEntry } from '../../state/modals.js';
import { Dialog } from './Dialog.js';

const BUTTON_CLASS: Record<ModalButtonVariant, string> = {
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
  const [query, setQuery] = createSignal('');
  const [selected, setSelected] = createSignal(new Set(view.selection?.selected));
  const matches = (choice: { label: string; detail: string }): boolean =>
    `${choice.label} ${choice.detail}`.toLowerCase().includes(query().trim().toLowerCase());
  let input: HTMLInputElement | undefined;
  let firstChoice: HTMLButtonElement | undefined;

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

  const submitWithEnter = (): void => {
    const primary = view.buttons.find(b => b.variant === 'primary');
    if (primary !== undefined) {
      choose(primary);
    }
  };

  return (
    <Dialog
      titleId={titleId}
      initialFocus={() => input ?? firstChoice}
      onDismiss={dismiss}
      dialogClass={view.choices === undefined ? 'signing-modal' : 'signing-modal contacts-modal'}
    >
      <Show when={view.icon}>
        {icon => (
          // eslint-disable-next-line solid/no-innerhtml -- trusted SVG markup from ModalView.icon, not user input
          <div class="permission-modal-icon" innerHTML={icon()} />
        )}
      </Show>
      <h2 id={titleId}>{view.title}</h2>
      <div class="signing-fields">
        <For each={view.fields}>
          {field => (
            <div
              class={['signing-field', { 'signing-field-warning': field.warning === true }]}
              role={field.warning === true ? 'alert' : undefined}
            >
              <div class="signing-field-label">{field.label}</div>
              <div class={['signing-field-value', { mono: field.mono === true }]}>{field.value}</div>
            </div>
          )}
        </For>
        <Show when={view.notice}>{notice => <div class="permission-modal-notice">{notice()}</div>}</Show>
        <Show when={view.selection}>
          {selection => (
            <>
              <input
                ref={element => {
                  input = element;
                }}
                type="search"
                class="contacts-picker-search"
                placeholder="Search contacts"
                aria-label="Search contacts"
                onInput={event => setQuery(event.currentTarget.value)}
              />
              <p class="contacts-picker-status" role="status">
                {selected().size === 0
                  ? 'No contacts selected. Use selection to remove everyone.'
                  : `${String(selected().size)} selected${selected().size === selection().limit ? ' (selection limit)' : ''}`}
              </p>
            </>
          )}
        </Show>
        <Show when={view.choices}>
          {choices => (
            <div class="contacts-picker-list">
              <For each={choices()}>
                {choice => (
                  <Show
                    when={view.selection}
                    fallback={
                      <button
                        ref={element => {
                          firstChoice ??= element;
                        }}
                        type="button"
                        class="signing-btn-secondary contacts-picker-choice"
                        onClick={() => {
                          settleModal(id, choice.result);
                        }}
                      >
                        <span class="contacts-picker-text">
                          <span>{choice.label}</span>
                          <span class="contacts-picker-identity">{choice.detail}</span>
                        </span>
                      </button>
                    }
                  >
                    {selection => (
                      <label class="signing-btn-secondary contacts-picker-choice" hidden={!matches(choice)}>
                        <input
                          type="checkbox"
                          checked={selected().has(choice.result)}
                          disabled={!selected().has(choice.result) && selected().size >= selection().limit}
                          onChange={event => {
                            const next = new Set(selected());
                            if (event.currentTarget.checked) {
                              next.add(choice.result);
                            } else {
                              next.delete(choice.result);
                            }
                            setSelected(next);
                          }}
                        />
                        <span class="contacts-picker-text">
                          <span>{choice.label}</span>
                          <span class="contacts-picker-identity">{choice.detail}</span>
                        </span>
                      </label>
                    )}
                  </Show>
                )}
              </For>
              <Show when={view.selection !== undefined && !choices().some(matches)}>
                <p role="status">No matching contacts</p>
              </Show>
            </div>
          )}
        </Show>
        <Show when={view.input}>
          {spec => (
            <>
              <Show when={spec().hint}>{hint => <div class="signing-field-value">{hint()}</div>}</Show>
              <Show when={spec().error}>
                {error => (
                  <div class="password-prompt-error" role="alert">
                    {error()}
                  </div>
                )}
              </Show>
              <input
                ref={el => {
                  input = el;
                }}
                type="password"
                class="password-prompt-input"
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
      <div class="signing-modal-footer">
        <For each={view.buttons}>
          {button => (
            <button
              type="button"
              class={BUTTON_CLASS[button.variant]}
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
