// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Switches every app on this domain between Polkadot App and a local wallet. Each switch reloads the page.

import { createSignal, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { phraseToEntropy } from '../../recovery-phrase.js';
import { authStore } from '../../state/auth.js';
import { walletModeStore } from '../../state/wallet-mode.js';
import { reportLocalWalletFailure } from '../../wallet-boot.js';
import { switchToLocalWallet, switchToPolkadotApp } from '../../wallet-switch.js';
import { useStore } from '../use-store.js';
import { Button } from './shared/Button.js';
import { Code } from './shared/Code.js';
import { ErrorText } from './shared/ErrorText.js';
import { Inline } from './shared/Inline.js';
import { KeyValue, KeyValueList } from './shared/KeyValueList.js';
import { Pane } from './shared/Pane.js';
import { Stack } from './shared/Stack.js';
import { TextArea } from './shared/TextArea.js';

export function WalletView(props: { active: boolean }): JSX.Element {
  return (
    <Pane testId="td-wallet" hidden={!props.active} padded>
      <Show when={props.active}>
        <Wallet />
      </Show>
    </Pane>
  );
}

function Wallet(): JSX.Element {
  const state = useStore(walletModeStore);
  return (
    <Stack gap="md">
      <Show when={state().failure}>{failure => <ErrorText testId="td-wallet-failure">{failure()}</ErrorText>}</Show>
      <Show when={state().mode === 'local'} fallback={<ImportForm submitLabel="Use locally" />}>
        <LocalWallet />
      </Show>
    </Stack>
  );
}

/** Takes a phrase and switches every app to it. While replacing a local wallet, Cancel keeps the current one. */
function ImportForm(props: { submitLabel: string; onCancel?: () => void }): JSX.Element {
  const [phrase, setPhrase] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    const entropy = phraseToEntropy(phrase());
    if (entropy === null) {
      setError('Not a valid recovery phrase');
      return;
    }
    setError(null);
    setSaving(true);
    switchToLocalWallet(entropy).catch((failure: unknown) => {
      reportLocalWalletFailure(failure, 'save');
      setSaving(false);
      setError('The wallet could not be saved. Try again.');
    });
  };

  return (
    <Stack narrow onSubmit={submit}>
      <TextArea
        id="td-wallet-phrase"
        testId="td-wallet-phrase"
        label="Polkadot App recovery phrase"
        value={phrase()}
        verbatim
        onInput={setPhrase}
      />
      <Show when={error()}>{message => <ErrorText testId="td-wallet-error">{message()}</ErrorText>}</Show>
      <Inline>
        <Button type="submit" testId="td-wallet-use-local" disabled={saving()}>
          {props.submitLabel}
        </Button>
        <Show when={props.onCancel}>
          {cancel => (
            <Button testId="td-wallet-cancel" disabled={saving()} onClick={cancel()}>
              Cancel
            </Button>
          )}
        </Show>
      </Inline>
    </Stack>
  );
}

function LocalWallet(): JSX.Element {
  const auth = useStore(authStore);
  const [replacing, setReplacing] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const session = (): { identityAccountId?: string; liteUsername?: string } | undefined => {
    const state = auth();
    return state.tag === 'Connected' ? state.session : undefined;
  };

  const forget = (): void => {
    setError(null);
    setLeaving(true);
    switchToPolkadotApp().catch((failure: unknown) => {
      reportLocalWalletFailure(failure, 'forget');
      setLeaving(false);
      setError('Could not switch back. Try again.');
    });
  };

  return (
    <Show
      when={!replacing()}
      fallback={
        <ImportForm
          submitLabel="Replace"
          onCancel={() => {
            setReplacing(false);
          }}
        />
      }
    >
      <Stack narrow>
        <KeyValueList>
          <KeyValue name="Identity account">
            <Code testId="td-wallet-account">{session()?.identityAccountId ?? 'Activating'}</Code>
          </KeyValue>
          <KeyValue name="Username">
            <Code testId="td-wallet-username">{session()?.liteUsername ?? 'None'}</Code>
          </KeyValue>
        </KeyValueList>
        <Show when={error()}>{message => <ErrorText testId="td-wallet-error">{message()}</ErrorText>}</Show>
        <Inline>
          <Button
            testId="td-wallet-replace"
            disabled={leaving()}
            title="Use another recovery phrase instead"
            onClick={() => {
              setError(null);
              setReplacing(true);
            }}
          >
            Replace
          </Button>
          <Button
            testId="td-wallet-forget"
            disabled={leaving()}
            title="Forget this wallet and go back to Polkadot App"
            onClick={forget}
          >
            Forget
          </Button>
        </Inline>
      </Stack>
    </Show>
  );
}
