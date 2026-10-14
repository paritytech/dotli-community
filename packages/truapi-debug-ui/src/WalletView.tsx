// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Switches every app on this domain between Polkadot App and a local wallet. Each switch reloads the page.

import { createSignal, onCleanup, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/ui';
import type { DebugPanelHost, HostAuth } from './host.js';
import { Button } from './shared/Button.js';
import { Callout } from './shared/Callout.js';
import { Code } from './shared/Code.js';
import { ErrorText } from './shared/ErrorText.js';
import { Inline } from './shared/Inline.js';
import { KeyValue, KeyValueList } from './shared/KeyValueList.js';
import { Note } from './shared/Note.js';
import { Pane } from './shared/Pane.js';
import { Stack } from './shared/Stack.js';
import { TextArea } from './shared/TextArea.js';

/** Aborted as the form leaves the tab, so a switch that answers late changes nothing. */
function whileShown(): AbortSignal {
  const shown = new AbortController();
  onCleanup(() => {
    shown.abort();
  });
  return shown.signal;
}

/** What the tab reads of the host and asks of it. */
export type WalletHost = Pick<DebugPanelHost, 'auth' | 'walletMode' | 'walletSwitch' | 'phraseToEntropy'>;

export function WalletView(props: { active: boolean; host: WalletHost }): JSX.Element {
  return (
    <Pane testId="td-wallet" label="Wallet" hidden={!props.active} padded>
      <Show when={props.active}>
        <Wallet host={props.host} />
      </Show>
    </Pane>
  );
}

function Wallet(props: { host: WalletHost }): JSX.Element {
  const state = useStore(untrack(() => props.host.walletMode));
  return (
    <Stack gap="md">
      <Show when={state().failure}>{failure => <ErrorText testId="td-wallet-failure">{failure()}</ErrorText>}</Show>
      <Show when={state().mode === 'local'} fallback={<ImportForm submitLabel="Use locally" host={props.host} />}>
        <LocalWallet host={props.host} />
      </Show>
    </Stack>
  );
}

/** Takes a phrase and switches every app to it. While replacing a local wallet, Cancel keeps the current one. */
function ImportForm(props: { submitLabel: string; host: WalletHost; onCancel?: () => void }): JSX.Element {
  const [phrase, setPhrase] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const shown = whileShown();

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    const entropy = props.host.phraseToEntropy(phrase());
    if (entropy === null) {
      setError('Not a valid recovery phrase');
      return;
    }
    setError(null);
    setSaving(true);
    void props.host.walletSwitch.useLocalWallet(entropy).then(outcome => {
      if (outcome === 'failed' && !shown.aborted) {
        setSaving(false);
        setError('The wallet could not be saved. Try again.');
      }
    });
  };

  return (
    <Stack narrow onSubmit={submit}>
      <Note testId="td-wallet-about">
        Copy the recovery phrase from Polkadot App and paste it here to use the same account in this browser, with no
        phone. Every app on this domain then signs with it locally.
      </Note>
      <Callout testId="td-wallet-warning" tone="warn">
        This is not secure. The phrase leaves your phone and stays in this browser, where anything that gets into the
        browser can take it. Use it only for an account you can afford to lose.
      </Callout>
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

function LocalWallet(props: { host: WalletHost }): JSX.Element {
  const auth = useStore(untrack(() => props.host.auth));
  const [replacing, setReplacing] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const shown = whileShown();
  const session = (): HostAuth['session'] => {
    const state = auth();
    return state.tag === 'Connected' ? state.session : undefined;
  };

  const forget = (): void => {
    setError(null);
    setLeaving(true);
    void props.host.walletSwitch.usePolkadotApp().then(outcome => {
      if (outcome === 'failed' && !shown.aborted) {
        setLeaving(false);
        setError('Could not switch back. Try again.');
      }
    });
  };

  return (
    <Show
      when={!replacing()}
      fallback={
        <ImportForm
          submitLabel="Replace"
          host={props.host}
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
