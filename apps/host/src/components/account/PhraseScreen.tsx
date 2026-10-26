// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show, untrack } from 'solid-js';
import { AlertTriangleIcon } from '@dotli/ui/icons';
import { Callout } from '@dotli/ui';
import { answerParts, Title, type HeadingLevel, type SignInParts } from './sign-in/SignInViews.js';
import s from './PhraseScreen.module.css';

const INVALID_PHRASE = 'Not a valid recovery phrase';
const SAVE_FAILED = 'The wallet could not be saved. Try again.';
const TITLE = 'Sign in with a recovery phrase';

export interface PhraseScreenProps {
  isValid: (phrase: string) => boolean;
  /** Rejects when the wallet could not be saved, which the caller already reported. */
  onImport: (phrase: string) => Promise<void>;
  onBack: () => void;
  backLabel: string;
  /** Prefixes the test id of the form and of each of its parts. */
  testId: string;
  level?: HeadingLevel | undefined;
}

/** Takes a phrase and signs in with it, here and in every app on the domain. */
export function PhraseScreen(props: PhraseScreenProps): SignInParts {
  const [phrase, setPhrase] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const inputId = (): string => `${props.testId}-input`;
  const errorId = (): string => `${props.testId}-error`;
  // The buttons are built once, with the names the form starts with.
  const buttons = untrack(() => ({ testId: props.testId, backLabel: props.backLabel }));

  const submit = (): void => {
    if (!props.isValid(phrase())) {
      setError(INVALID_PHRASE);
      return;
    }
    setError(null);
    setSaving(true);
    // A success leaves the page or the window. A failure was reported by the caller, so here it is only said.
    void props.onImport(phrase()).catch(() => {
      setSaving(false);
      setError(SAVE_FAILED);
    });
  };

  return {
    title: TITLE,
    content: (
      <div class={s['phrase']} data-testid={props.testId}>
        <Show when={props.level !== 'layout'}>
          <Title id={`${props.testId}-title`} testId={`${props.testId}-title`}>
            {TITLE}
          </Title>
        </Show>
        <p class={s['subtitle']}>
          Paste the recovery phrase from Polkadot App to use the same account in this browser, with no phone.
        </p>
        <Callout icon={AlertTriangleIcon} testId={`${props.testId}-warning`}>
          This is not secure. The phrase leaves your phone and stays in this browser, where anything that gets into the
          browser can take it. Use it only for an account you can afford to lose.
        </Callout>
        <label class={s['label']} for={inputId()}>
          Polkadot App recovery phrase
        </label>
        <textarea
          id={inputId()}
          class={s['input']}
          data-testid={inputId()}
          rows={3}
          autocomplete="off"
          spellcheck={false}
          aria-invalid={error() === null ? undefined : 'true'}
          aria-describedby={error() === null ? undefined : errorId()}
          value={phrase()}
          onInput={event => {
            setPhrase(event.currentTarget.value);
            setError(null);
          }}
        />
        <Show when={error()}>
          {message => (
            <p id={errorId()} class={s['error']} data-testid={errorId()} role="alert">
              {message()}
            </p>
          )}
        </Show>
      </div>
    ),
    ...answerParts([
      {
        label: 'Sign in',
        primary: true,
        onPress: submit,
        get disabled() {
          return saving();
        },
        testId: `${buttons.testId}-submit`,
      },
      {
        label: buttons.backLabel,
        dismisses: true,
        onPress: () => {
          props.onBack();
        },
        get disabled() {
          return saving();
        },
        testId: `${buttons.testId}-back`,
      },
    ]),
  };
}
