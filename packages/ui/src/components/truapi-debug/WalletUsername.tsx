// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The local wallet's lite username: what People holds for the identity account, and for an account without one, an
// availability check and a claim through the network's identity backend.

import { createSignal, onCleanup, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getActiveServicesConfig } from '@dotli/config';
import { adoptLiteUsername, readNetworkLiteUsername } from '../../local-wallet-identity.js';
import {
  checkUsernameAvailability,
  claimLiteUsername,
  LITE_USERNAME_BASE,
  type ClaimStage,
  type UsernameAvailability,
} from '../../local-wallet-username.js';
import { Button } from './shared/Button.js';
import { Code } from './shared/Code.js';
import { ErrorText } from './shared/ErrorText.js';
import { Inline } from './shared/Inline.js';
import { KeyValue, KeyValueList } from './shared/KeyValueList.js';
import { Note } from './shared/Note.js';
import { Stack } from './shared/Stack.js';
import { TextInput } from './shared/TextInput.js';

type Verified = { state: 'checking' } | { state: 'read'; name: string | null } | { state: 'failed'; message: string };

const STAGE_TEXT: Record<ClaimStage, string> = {
  authenticating: 'Authenticating with the identity backend…',
  submitting: 'Submitting the claim…',
  confirming: 'Submitted. Waiting for People to record it; keep this page open.',
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WalletUsername(props: { entropy: Uint8Array; identityAccountId: string }): JSX.Element {
  const entropy = untrack(() => props.entropy);
  const identityAccountId = untrack(() => props.identityAccountId);
  const network = getActiveServicesConfig();
  const [verified, setVerified] = createSignal<Verified>({ state: 'checking' });
  const [base, setBase] = createSignal('');
  const [availability, setAvailability] = createSignal<UsernameAvailability | null>(null);
  const [busy, setBusy] = createSignal<'check' | ClaimStage | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const verify = (): void => {
    setVerified({ state: 'checking' });
    readNetworkLiteUsername(identityAccountId).then(
      name => {
        if (!disposed) {
          setVerified({ state: 'read', name });
        }
      },
      (failure: unknown) => {
        if (!disposed) {
          setVerified({ state: 'failed', message: message(failure) });
        }
      },
    );
  };
  onSettled(verify);

  const valid = (): boolean => LITE_USERNAME_BASE.test(base());

  const check = (): void => {
    const name = base();
    setError(null);
    setAvailability(null);
    setBusy('check');
    checkUsernameAvailability(entropy, identityAccountId, name)
      .then(
        result => {
          if (!disposed && base() === name) {
            setAvailability(result);
          }
        },
        (failure: unknown) => {
          if (!disposed) {
            setError(message(failure));
          }
        },
      )
      .finally(() => {
        if (!disposed) {
          setBusy(null);
        }
      });
  };

  const claim = (): void => {
    setError(null);
    claimLiteUsername(entropy, identityAccountId, base(), stage => {
      if (!disposed) {
        setBusy(stage);
      }
    })
      .then(async name => {
        await adoptLiteUsername(entropy, identityAccountId, name);
        if (!disposed) {
          setVerified({ state: 'read', name });
        }
      })
      .catch((failure: unknown) => {
        if (!disposed) {
          setError(message(failure));
        }
      })
      .finally(() => {
        if (!disposed) {
          setBusy(null);
        }
      });
  };

  const readError = (): string | null => {
    const state = verified();
    return state.state === 'failed' ? state.message : null;
  };
  const unnamed = (): boolean => {
    const state = verified();
    return state.state === 'read' && state.name === null;
  };
  const availabilityText = (value: UsernameAvailability): string =>
    value.status === 'available'
      ? `Available${value.digits.length === 0 ? '' : ` · e.g. ${base()}.${String(value.digits[0])}`}`
      : `Not available: ${value.reason}`;

  const verifiedText = (): string => {
    const state = verified();
    switch (state.state) {
      case 'checking':
        return 'Checking People…';
      case 'failed':
        return 'Could not read People';
      case 'read':
        return state.name === null ? `None on ${network.label}` : `${state.name} · verified on People`;
    }
  };

  return (
    <Stack narrow>
      <KeyValueList>
        <KeyValue name="Username">
          <Code testId="td-wallet-username-verified">{verifiedText()}</Code>
        </KeyValue>
      </KeyValueList>
      <Show when={readError()}>{text => <ErrorText testId="td-wallet-username-read-error">{text()}</ErrorText>}</Show>
      <Show when={unnamed()}>
        <TextInput
          id="td-wallet-username-base"
          testId="td-wallet-username-base"
          label="Username to claim"
          value={base()}
          suffix=".##"
          verbatim
          disabled={busy() !== null}
          onInput={value => {
            setBase(value.trim().toLowerCase());
            setAvailability(null);
          }}
        />
        <Note testId="td-wallet-username-hint">
          6 to 29 lowercase letters. {network.label} adds two digits, so the name becomes base.## on {network.label}.
        </Note>
        <Show when={availability()}>
          {result => <Code testId="td-wallet-username-availability">{availabilityText(result())}</Code>}
        </Show>
        <Show when={busy()}>
          {stage => (
            <Note testId="td-wallet-username-stage">
              {stage() === 'check' ? 'Checking availability…' : STAGE_TEXT[stage() as ClaimStage]}
            </Note>
          )}
        </Show>
        <Inline>
          <Button testId="td-wallet-username-check" disabled={busy() !== null || !valid()} onClick={check}>
            Check
          </Button>
          <Button
            testId="td-wallet-username-claim"
            disabled={busy() !== null || availability()?.status !== 'available'}
            title="Register this name for the identity account on People"
            onClick={claim}
          >
            Claim
          </Button>
        </Inline>
      </Show>
      <Show when={error()}>{text => <ErrorText testId="td-wallet-username-error">{text()}</ErrorText>}</Show>
      <Inline>
        <Button testId="td-wallet-username-refresh" disabled={verified().state === 'checking'} onClick={verify}>
          Check People again
        </Button>
      </Inline>
    </Stack>
  );
}
