// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { dynamic, type JSX } from '@solidjs/web';
import { ReloadIcon } from '../../icons.js';
import { Button, type ButtonVariant } from '../../components/primitives/Button.js';
import { Callout, Well } from '../../components/primitives/Well.js';
import { Field } from '../../components/primitives/Field.js';
import { Modal } from '../../components/floating/Modal.js';
import { useStore } from '../../components/use-store.js';
import {
  modalsStore,
  settleModal,
  type ModalButton,
  type ModalButtonVariant,
  type ModalEntry,
  type ModalView,
} from '../../page/state/modals.js';
import { closeAnswer, scrimAnswer } from './prompt-answer.js';
import s from './PromptDialog.module.css';

const BUTTON_VARIANT: Record<ModalButtonVariant, ButtonVariant> = {
  danger: 'danger',
  cancel: 'secondary',
  secondary: 'secondary',
  primary: 'primary',
};

/** The root of the dialog's ids when its caller names none. */
const DEFAULT_TEST_ID = 'prompt-dialog';

// A reject keeps the cancel id: it is the same answer, drawn destructive.
const BUTTON_TEST_ROLE: Record<ModalButtonVariant, string> = {
  danger: 'cancel',
  cancel: 'cancel',
  secondary: 'secondary',
  primary: 'primary',
};

/** A queued app prompt (permission, password, preimage, signing) drawn as a Modal. */
export function PromptDialog(props: { entry: ModalEntry }): JSX.Element {
  // eslint-disable-next-line solid/reactivity -- keyed entry, read once
  const { id, view: first } = props.entry;
  // An answered dialog may hand its place to another view under the same id, which this follows without
  // remounting. A dialog that left the store keeps its last view while it closes.
  const current = useStore(modalsStore, entries => entries.find(e => e.id === id)?.view);
  const view = createMemo<ModalView<string>>(prev => current() ?? prev ?? first);
  const root = first.testId ?? DEFAULT_TEST_ID;
  const titleId = `overlay-modal-title-${String(id)}`;
  const [password, setPassword] = createSignal('');
  const Body = dynamic(() => view().body);
  let input: HTMLInputElement | undefined;
  let frame: HTMLDivElement | undefined;
  let shown = first;
  // A new step starts without the last one's typed value. The pressed button is gone, so focus moves to the surface
  // rather than a button, where a second click or a repeated Enter would answer the new step at once.
  createEffect(view, next => {
    if (next === shown) {
      return;
    }
    shown = next;
    setPassword('');
    const target = frame?.querySelector('[data-modal-surface]');
    if (target instanceof HTMLElement) {
      target.focus();
    }
  });

  const needsPassword = (button: ModalButton<string>): boolean =>
    view().input !== undefined && button.variant === 'primary';

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

  const answer = (result: string | undefined): void => {
    if (result !== undefined) {
      settleModal(id, result);
    }
  };

  const submitWithEnter = (): void => {
    const primary = view().buttons.find(b => b.variant === 'primary');
    if (primary !== undefined) {
      choose(primary);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(_, reason) => {
        answer(reason === 'close' ? closeAnswer(view()) : scrimAnswer(view()));
      }}
      title={view().title}
      labelledBy={titleId}
      initialFocus={() => input}
      testId={root}
      frameRef={el => {
        frame = el;
      }}
      closable={view().closable}
    >
      <Modal.Head titleId={titleId} title={view().title} icon={view().icon} iconTestId={`${root}-icon`} />
      <Modal.Body>
        <Show when={view().fields.length > 0}>
          <Well layout="list">
            <For each={view().fields}>
              {field => (
                <Field
                  label={field.label}
                  value={field.value}
                  mono={field.mono === true}
                  warning={field.warning === true}
                  testId={`${root}-field`}
                  labelTestId={`${root}-field-label`}
                  valueTestId={`${root}-field-value`}
                />
              )}
            </For>
          </Well>
        </Show>
        <Show when={view().notice}>
          {notice => (
            // The one notice says the app reloads, hence the board's reload arrow.
            <Callout icon={ReloadIcon} testId={`${root}-notice`}>
              {notice()}
            </Callout>
          )}
        </Show>
        <Show when={view().input}>
          {spec => (
            <>
              <Show when={spec().hint}>
                {hint => (
                  <p class={s['caption']} data-testid={`${root}-hint`}>
                    {hint()}
                  </p>
                )}
              </Show>
              <Show when={spec().error}>
                {error => (
                  <p class={s['error']} data-testid={`${root}-error`} role="alert">
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
                data-testid={`${root}-input`}
                aria-labelledby={titleId}
                placeholder={spec().placeholder}
                value={password()}
                autocomplete="off"
                spellcheck="false"
                onInput={event => setPassword(event.currentTarget.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    // Submitting returns focus to the opener during this keydown, so the key's own activation
                    // would press it and ask again.
                    event.preventDefault();
                    submitWithEnter();
                  }
                }}
              />
            </>
          )}
        </Show>
        <Show when={view().body}>
          <Body />
        </Show>
      </Modal.Body>
      <Modal.Actions testId={`${root}-footer`}>
        <For each={view().buttons}>
          {button => (
            <Button
              variant={BUTTON_VARIANT[button.variant]}
              block
              testId={`${root}-btn-${BUTTON_TEST_ROLE[button.variant]}`}
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
