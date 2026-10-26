// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Switches every app on this domain between Polkadot App and a local wallet. The page takes the recovery phrase in its
// own sign-in, so the panel only asks for it.

import { Show, untrack } from 'solid-js';
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
    <Stack gap="md">
      <Show when={state().failure}>{failure => <ErrorText testId="td-wallet-failure">{failure()}</ErrorText>}</Show>
      <Show when={state().mode === 'local'} fallback={<ImportPrompt host={props.host} />}>
        <LocalWallet host={props.host} />
      </Show>
    </Stack>
  );
}

/** Opens the page's phrase view, where the phrase is typed and every app is switched to it. */
function ImportPrompt(props: { host: WalletHost }): JSX.Element {
  return (
    <Stack narrow>
      <Note testId="td-wallet-about">
        Copy the recovery phrase from Polkadot App and paste it into the sign-in that opens to use the same account in
        this browser, with no phone. Every app on this domain then signs with it locally.
      </Note>
      <Callout testId="td-wallet-warning" tone="warn">
        This is not secure. The phrase leaves your phone and stays in this browser, where anything that gets into the
        browser can take it. Use it only for an account you can afford to lose.
      </Callout>
      <Inline>
        <Button
          testId="td-wallet-import"
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
  const session = (): HostAuth['session'] => {
    const state = auth();
    return state.tag === 'Connected' ? state.session : undefined;
  };

  return (
    <Stack narrow>
      <KeyValueList>
        <KeyValue name="Identity account">
          <Code testId="td-wallet-account">{session()?.identityAccountId ?? 'Activating'}</Code>
        </KeyValue>
        <KeyValue name="Username">
          <Code testId="td-wallet-username">{session()?.liteUsername ?? 'None'}</Code>
        </KeyValue>
      </KeyValueList>
      <Inline>
        <Button
          testId="td-wallet-replace"
          title="Use another recovery phrase instead"
          onClick={() => {
            props.host.walletSwitch.importPhrase();
          }}
        >
          Replace
        </Button>
        <Button
          testId="td-wallet-forget"
          title="Sign out, ending this wallet and any Polkadot App session, so the next sign-in pairs with Polkadot App"
          onClick={() => {
            props.host.walletSwitch.usePolkadotApp();
          }}
        >
          Use Polkadot App
        </Button>
      </Inline>
    </Stack>
  );
}
