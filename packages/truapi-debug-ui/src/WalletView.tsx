// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Switches every app on this domain between Polkadot App and a local wallet. The page takes the recovery phrase in its
// own sign-in, so the panel only asks for it.

import { Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/stores-solid';
import type { DebugPanelHost, HostAuth } from './host.js';
import { formatHexHeadAndTail } from './model/formatHexHeadAndTail.js';
import { Button } from './shared/Button.js';
import { Callout } from './shared/Callout.js';
import { Code } from './shared/Code.js';
import { CopyValue } from './shared/CopyValue.js';
import { Inline } from './shared/Inline.js';
import { KeyValue, KeyValueList, ListHeading } from './shared/KeyValueList.js';
import { Note } from './shared/Note.js';
import { Pane } from './shared/Pane.js';
import { Stack } from './shared/Stack.js';
import s from './WalletView.module.css';

/** What the tab reads of the host and asks of it. */
export type WalletHost = Pick<DebugPanelHost, 'auth' | 'walletMode' | 'walletSwitch'>;

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
    <Stack gap="md" narrow stretch>
      <Show when={state().failure}>
        {failure => (
          <Callout testId="td-wallet-failure" tone="danger" alert>
            {failure()}
          </Callout>
        )}
      </Show>
      <Show when={state().mode === 'local'} fallback={<ImportPrompt host={props.host} />}>
        <LocalWallet host={props.host} />
      </Show>
    </Stack>
  );
}

/** Opens the page's phrase view, where the phrase is typed and every app is switched to it. */
function ImportPrompt(props: { host: WalletHost }): JSX.Element {
  return (
    <Stack gap="md" narrow stretch>
      <div>
        <ListHeading>Signing with Polkadot App</ListHeading>
        <Note testId="td-wallet-about">
          Copy the recovery phrase from Polkadot App and paste it into the sign-in that opens to use the same account in
          this browser, with no phone. Every app on this domain then signs with it locally.
        </Note>
      </div>
      <Callout testId="td-wallet-warning" tone="warn">
        This is not secure. The phrase leaves your phone and stays in this browser, where anything that gets into the
        browser can take it. Use it only for an account you can afford to lose.
      </Callout>
      <Inline>
        <Button
          testId="td-wallet-import"
          class={s['action']}
          onClick={() => {
            props.host.walletSwitch.importPhrase();
          }}
        >
          Use a recovery phrase
        </Button>
      </Inline>
    </Stack>
  );
}

function LocalWallet(props: { host: WalletHost }): JSX.Element {
  const auth = useStore(untrack(() => props.host.auth));
  function getSession(): HostAuth['session'] {
    const state = auth();
    return state.tag === 'Connected' ? state.session : undefined;
  }

  return (
    <Stack gap="md" narrow stretch>
      <div>
        <ListHeading>Signing with a local wallet</ListHeading>
        <Note testId="td-wallet-active">
          A local wallet is active. Every app on this domain signs with it in this browser, with no phone.
        </Note>
      </div>
      <KeyValueList>
        <KeyValue name="Identity account">
          <Show
            when={getSession()?.identityAccountId}
            fallback={<Placeholder testId="td-wallet-account">Activating…</Placeholder>}
          >
            {account => (
              <CopyValue
                label="Identity account"
                value={account()}
                text={formatHexHeadAndTail(account())}
                testId="td-wallet-account"
              />
            )}
          </Show>
        </KeyValue>
        <KeyValue name="Username">
          <Show
            when={getSession()?.liteUsername}
            fallback={<Placeholder testId="td-wallet-username">None</Placeholder>}
          >
            {username => <Code testId="td-wallet-username">{username()}</Code>}
          </Show>
        </KeyValue>
      </KeyValueList>
      <Inline>
        <Button
          testId="td-wallet-replace"
          title="Use another recovery phrase instead"
          class={s['action']}
          onClick={() => {
            props.host.walletSwitch.importPhrase();
          }}
        >
          Use another phrase
        </Button>
      </Inline>
      {/* Apart from the other actions, since it ends the wallet rather than changing it. */}
      <div class={s['signOut']}>
        <Note testId="td-wallet-sign-out-note">
          Signing out ends this wallet and any Polkadot App session. The next sign-in pairs with Polkadot App.
        </Note>
        <Inline>
          <Button
            testId="td-wallet-forget"
            tone="danger"
            class={s['action']}
            onClick={() => {
              props.host.walletSwitch.usePolkadotApp();
            }}
          >
            Sign out and use Polkadot App
          </Button>
        </Inline>
      </div>
    </Stack>
  );
}

/** A value not known yet or not set. */
function Placeholder(props: { testId: string; children: string }): JSX.Element {
  return (
    <span class={s['placeholder']} data-testid={props.testId}>
      {props.children}
    </span>
  );
}
