// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Wallet tab's read-only usage and allowances of the local wallet: current chain state only. It never derives
// consumption or action costs from these values. Each Refresh reads afresh.

import { createSignal, Match, onCleanup, Switch, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  formatAuthorization,
  formatChainTime,
  formatInteger,
  formatTokenBalance,
  type AllowanceResult,
  type WalletAllowanceSnapshot,
} from '@dotli/truapi-debug';
import { readWalletAllowances } from '../../../wallet-allowances.js';
import type { LocalWalletBoot } from '../../../wallet-boot.js';
import { Button } from '../shared/Button.js';
import { Code } from '../shared/Code.js';
import { ErrorText } from '../shared/ErrorText.js';
import { KeyValue, KeyValueList, ListHeading } from '../shared/KeyValueList.js';
import { Note } from '../shared/Note.js';
import { Stack } from '../shared/Stack.js';

type AllowanceRead =
  | { status: 'loading' }
  | { status: 'failed'; reason: string }
  | { status: 'landing' }
  | { status: 'loaded'; snapshot: WalletAllowanceSnapshot };

const NOT_SHOWN =
  'Statement publishing slots and the PGAS and Bulletin claim pools are not shown: their chain entries are keyed by ' +
  'ring-VRF aliases that only the wallet core can derive.';

function Row(props: { name: string; testId?: string; value: string }): JSX.Element {
  return (
    <KeyValue name={props.name}>
      <Code testId={props.testId}>{props.value}</Code>
    </KeyValue>
  );
}

/** One chain-read section: its values and the finalized block they were read at, or why it is unknown. */
function Section<T>(props: {
  title: string;
  chain: string;
  testId: string;
  result: AllowanceResult<T>;
  children: (value: T) => JSX.Element;
}): JSX.Element {
  const result = untrack(() => props.result);
  return (
    <section data-testid={props.testId}>
      <ListHeading>{props.title}</ListHeading>
      {result.status === 'unavailable' ? (
        <ErrorText testId={`${props.testId}-unavailable`}>{`Unavailable: ${result.reason}`}</ErrorText>
      ) : (
        <KeyValueList>
          {props.children(result.value)}
          <Row
            name="Source"
            value={`${props.chain} · finalized block ${formatInteger(result.observation.blockNumber)} · ${formatChainTime(result.observation.chainTimestamp)}`}
          />
          <Row name="Block hash" value={result.observation.blockHash} />
          <Row name="Runtime spec version" value={formatInteger(result.observation.specVersion)} />
        </KeyValueList>
      )}
    </section>
  );
}

function AllowanceSnapshot(props: { snapshot: WalletAllowanceSnapshot }): JSX.Element {
  const snapshot = untrack(() => props.snapshot);
  return (
    <div data-testid="td-wallet-allowance-snapshot">
      <KeyValueList>
        <Row name="Product" value={snapshot.productId} />
        <Row name="Network" value={snapshot.networkSuffix} />
      </KeyValueList>
      <Section
        title="PGAS · product account Index(0)"
        chain="Asset Hub"
        testId="td-wallet-allowance-pgas"
        result={snapshot.pgasBalance}
      >
        {pgas => (
          <>
            <Row name="Account" value={pgas.accountId} />
            <Row
              name="Total balance"
              testId="td-wallet-allowance-pgas-balance"
              value={formatTokenBalance(pgas.balance, pgas.decimals, pgas.symbol)}
            />
            <Row name="Asset ID" value={pgas.assetId} />
            <Row name="Token symbol" value={pgas.symbol ?? 'Unavailable'} />
            <Row
              name="Token decimals"
              value={pgas.decimals === null ? 'Unavailable — base units only' : formatInteger(pgas.decimals)}
            />
          </>
        )}
      </Section>
      <Section
        title="Bulletin storage authorization"
        chain="Bulletin"
        testId="td-wallet-allowance-bulletin"
        result={snapshot.bulletinQuota}
      >
        {quota => (
          <>
            <Row name="Storage account" value={quota.accountId} />
            <Row
              name="Authorization"
              testId="td-wallet-allowance-bulletin-status"
              value={formatAuthorization(quota.status)}
            />
            {quota.status === 'missing' ? null : (
              <>
                <Row
                  name="Bytes"
                  testId="td-wallet-allowance-bulletin-bytes"
                  value={`${formatInteger(quota.bytesUsed)} used / ${formatInteger(quota.bytesLimit)} limit · ${formatInteger(quota.bytesRemaining)} remaining`}
                />
                <Row
                  name="Submissions"
                  value={`${formatInteger(quota.transactionsUsed)} used / ${formatInteger(quota.transactionsLimit)} limit · ${formatInteger(quota.transactionsRemaining)} remaining`}
                />
                <Row name="Expires at" value={`Bulletin block ${formatInteger(quota.expiresAtBlock)}`} />
              </>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

/** Reads the page product's allowances on mount and on Refresh. The landing page has no product to inspect. */
export function AllowanceSection(props: { wallet: LocalWalletBoot; identityAccountId: string }): JSX.Element {
  const [read, setRead] = createSignal<AllowanceRead>({ status: 'loading' });
  // Only the latest read lands, so a slow one cannot overwrite a Refresh.
  let generation = 0;
  onCleanup(() => {
    generation += 1;
  });

  const load = (): void => {
    generation += 1;
    const current = generation;
    untrack(() => readWalletAllowances(props.wallet, props.identityAccountId)).then(
      snapshot => {
        if (current === generation) {
          setRead(snapshot === null ? { status: 'landing' } : { status: 'loaded', snapshot });
        }
      },
      (err: unknown) => {
        if (current === generation) {
          setRead({ status: 'failed', reason: err instanceof Error ? err.message : String(err) });
        }
      },
    );
  };
  load();
  const refresh = (): void => {
    setRead({ status: 'loading' });
    load();
  };

  const failure = (): string | undefined => {
    const current = read();
    return current.status === 'failed' ? current.reason : undefined;
  };
  const loaded = (): WalletAllowanceSnapshot | undefined => {
    const current = read();
    return current.status === 'loaded' ? current.snapshot : undefined;
  };

  return (
    <section data-testid="td-wallet-allowances">
      <ListHeading>Usage & allowances</ListHeading>
      <Stack>
        <Note>
          The PGAS balance covers only the page product’s default account, Index(0), and is not a promise of
          spendability. The Bulletin authorization covers its separate storage account. {NOT_SHOWN}
        </Note>
        <Switch>
          <Match when={failure()}>
            {reason => <ErrorText testId="td-wallet-allowances-error">{reason()}</ErrorText>}
          </Match>
          <Match when={loaded()}>{snapshot => <AllowanceSnapshot snapshot={snapshot()} />}</Match>
          <Match when={read().status === 'landing'}>
            <Note testId="td-wallet-allowances-no-product">
              No product is open on this page. PGAS balances and Bulletin storage authorizations belong to a product’s
              accounts; open a product to inspect them.
            </Note>
          </Match>
          <Match when={read().status === 'loading'}>
            <Note testId="td-wallet-allowances-loading">Reading finalized chain state…</Note>
          </Match>
        </Switch>
        <Button
          testId="td-wallet-allowances-refresh"
          hidden={read().status === 'landing'}
          title="Read the allowances again at the latest finalized blocks"
          onClick={refresh}
        >
          Refresh
        </Button>
      </Stack>
    </section>
  );
}
