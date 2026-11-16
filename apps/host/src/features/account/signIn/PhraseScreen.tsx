// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { AlertTriangleIcon, type IconProps } from '@dotli/ui/icons';
import { Callout } from '@dotli/ui';
import { answerParts, ErrorWell, Title, type HeadingLevel, type SignInParts } from './SignInViews.js';
import s from './PhraseScreen.module.css';

const INVALID_PHRASE = 'Not a valid recovery phrase';
const SAVE_FAILED = 'The wallet could not be saved. Try again.';
const TITLE = 'Sign in with a recovery phrase';

export type PhraseScreenProps = {
  isValid: (phrase: string) => boolean;
  /** Rejects when the wallet could not be saved, which the caller already reported. */
  onImport: (phrase: string) => Promise<void>;
  onBack: () => void;
  backLabel: string;
  /** Prefixes the test id of the form and of each of its parts. */
  testId: string;
  level?: HeadingLevel | undefined;
};

/** The warning's mark, in the warning tone. */
function WarnIcon(props: IconProps): JSX.Element {
  return <AlertTriangleIcon class={[props.class, s['warnIcon']]} size={props.size} testId={props.testId} />;
}

/** Takes a phrase and signs in with it, here and in every app on the domain. */
export function PhraseScreen(props: PhraseScreenProps): SignInParts {
  const [phrase, setPhrase] = createSignal('');
  // A phrase that is not valid is the field's fault. A failed save is the form's, so it is said apart from the field.
  const [error, setError] = createSignal<string | null>(null);
  const [saveFailed, setSaveFailed] = createSignal(false);
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
    setSaveFailed(false);
    setSaving(true);
    // A success leaves the page or the window. A failure was reported by the caller, so here it is only said.
    void props.onImport(phrase()).catch(() => {
      setSaving(false);
      setSaveFailed(true);
    });
  };

  return {
    title: TITLE,
    content: (
      <div class={s['phrase']} data-level={props.level ?? 1} data-testid={props.testId}>
        <div class={s['intro']}>
          <Show when={props.level !== 'layout'}>
            <Title id={`${props.testId}-title`} testId={`${props.testId}-title`}>
              {TITLE}
            </Title>
          </Show>
          <p class={s['subtitle']}>
            Paste the recovery phrase from Polkadot App to use the same account in this browser, with no phone.
          </p>
        </div>
        <Callout icon={WarnIcon} testId={`${props.testId}-warning`}>
          This is not secure. The phrase leaves your phone and stays in this browser, where anything that gets into the
          browser can take it. Use it only for an account you can afford to lose.
        </Callout>
        <div class={s['field']}>
          <label class={s['label']} for={inputId()}>
            Polkadot App recovery phrase
          </label>
          <textarea
            id={inputId()}
            class={s['input']}
            data-testid={inputId()}
            rows={3}
            placeholder="12 or 24 words, separated by spaces"
            autocomplete="off"
            spellcheck={false}
            aria-invalid={error() === null ? undefined : 'true'}
            aria-describedby={error() === null ? undefined : errorId()}
            value={phrase()}
            onInput={event => {
              setPhrase(event.currentTarget.value);
              setError(null);
              setSaveFailed(false);
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
        <Show when={saveFailed()}>
          <ErrorWell testId={`${props.testId}-save-failed`}>{SAVE_FAILED}</ErrorWell>
        </Show>
      </div>
    ),
    ...answerParts([
      {
        label: 'Sign in',
        primary: true,
        onPress: submit,
        get loading() {
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
