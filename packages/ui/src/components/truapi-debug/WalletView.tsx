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
import { KeyValue, KeyValueList } from './shared/KeyValueList.js';
import s from './WalletView.module.css';

export function WalletView(props: { active: boolean }): JSX.Element {
  return (
    <div class={s['view']} data-testid="td-wallet" hidden={!props.active}>
      <Show when={props.active}>
        <Wallet />
      </Show>
    </div>
  );
}

function Wallet(): JSX.Element {
  const state = useStore(walletModeStore);
  return (
    <>
      <Show when={state().failure}>
        {failure => (
          <p class={s['failure']} data-testid="td-wallet-failure" role="alert">
            {failure()}
          </p>
        )}
      </Show>
      <Show when={state().mode === 'local'} fallback={<ImportForm />}>
        <LocalWallet />
      </Show>
    </>
  );
}

function ImportForm(): JSX.Element {
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
    <form class={s['form']} onSubmit={submit}>
      <label class={s['label']} for="td-wallet-phrase">
        Polkadot App recovery phrase
      </label>
      <textarea
        id="td-wallet-phrase"
        class={s['phrase']}
        data-testid="td-wallet-phrase"
        rows={3}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        value={phrase()}
        onInput={event => {
          setPhrase(event.currentTarget.value);
        }}
      />
      <Show when={error()}>
        {message => (
          <p class={s['error']} data-testid="td-wallet-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Button type="submit" testId="td-wallet-use-local" disabled={saving()}>
        Use locally
      </Button>
    </form>
  );
}

function LocalWallet(): JSX.Element {
  const auth = useStore(authStore);
  const [leaving, setLeaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const session = (): { identityAccountId?: string; liteUsername?: string } | undefined => {
    const state = auth();
    return state.tag === 'Connected' ? state.session : undefined;
  };

  const leave = (): void => {
    setError(null);
    setLeaving(true);
    switchToPolkadotApp().catch((failure: unknown) => {
      reportLocalWalletFailure(failure, 'forget');
      setLeaving(false);
      setError('Could not switch back. Try again.');
    });
  };

  return (
    <section class={s['local']}>
      <KeyValueList>
        <KeyValue name="Identity account">
          <code data-testid="td-wallet-account">{session()?.identityAccountId ?? 'Activating'}</code>
        </KeyValue>
        <KeyValue name="Username">
          <code data-testid="td-wallet-username">{session()?.liteUsername ?? 'None'}</code>
        </KeyValue>
      </KeyValueList>
      <Show when={error()}>
        {message => (
          <p class={s['error']} data-testid="td-wallet-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Button testId="td-wallet-use-app" disabled={leaving()} onClick={leave}>
        Use Polkadot App
      </Button>
    </section>
  );
}
