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
      <button class={s['btn']} type="submit" data-testid="td-wallet-use-local" disabled={saving()}>
        Use locally
      </button>
    </form>
  );
}

function LocalWallet(): JSX.Element {
  const auth = useStore(authStore);
  const [leaving, setLeaving] = createSignal(false);
  const session = (): { identityAccountId?: string; liteUsername?: string } | undefined => {
    const state = auth();
    return state.tag === 'Connected' ? state.session : undefined;
  };

  const leave = (): void => {
    setLeaving(true);
    switchToPolkadotApp().catch((failure: unknown) => {
      reportLocalWalletFailure(failure, 'forget');
      setLeaving(false);
    });
  };

  return (
    <section class={s['local']}>
      <dl class={s['fields']}>
        <dt class={s['name']}>Identity account</dt>
        <dd class={s['value']}>
          <code data-testid="td-wallet-account">{session()?.identityAccountId ?? 'Activating'}</code>
        </dd>
        <dt class={s['name']}>Username</dt>
        <dd class={s['value']}>
          <code data-testid="td-wallet-username">{session()?.liteUsername ?? 'None'}</code>
        </dd>
      </dl>
      <button class={s['btn']} type="button" data-testid="td-wallet-use-app" disabled={leaving()} onClick={leave}>
        Use Polkadot App
      </button>
    </section>
  );
}
