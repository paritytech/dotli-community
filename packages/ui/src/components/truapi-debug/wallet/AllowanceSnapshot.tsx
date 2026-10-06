// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Wallet view's read-only allowance snapshot: current state only. It never
// derives consumption or action costs from these values. A snapshot is drawn
// once; a refresh mounts a new one.

import { For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type {
  AllowanceClaims,
  AllowanceObservation,
  AllowanceSection,
  WalletAllowanceSnapshot,
} from '@parity/truapi-host/web';
import { Field } from './Field.js';
import { authorization, integer, timestamp, tokenBalance } from './format.js';
import s from './AllowanceSnapshot.module.css';

function Source(props: { observation: AllowanceObservation; chain: string }): JSX.Element {
  return (
    <details class={`${s['details'] ?? ''} ${s['source'] ?? ''}`}>
      <summary>
        {`${props.chain} · finalized block ${integer(props.observation.blockNumber)} · ${timestamp(props.observation.chainTimestamp)}`}
      </summary>
      <Field label="Block hash" value={props.observation.blockHash} />
      <Field label="Genesis hash" value={props.observation.genesisHash} />
      <Field label="Runtime spec version" value={integer(props.observation.specVersion)} />
    </details>
  );
}

function Section<T>(props: {
  title: string;
  data: AllowanceSection<T>;
  chain: string;
  children: (value: T) => JSX.Element;
}): JSX.Element {
  const data = untrack(() => props.data);
  return (
    <div class={s['section']}>
      <h5>{props.title}</h5>
      {data.status === 'unavailable' ? (
        <p class={s['error']}>{`Unavailable: ${data.reason}`}</p>
      ) : (
        <>
          {props.children(data.value)}
          <Source observation={data.observation} chain={props.chain} />
        </>
      )}
    </div>
  );
}

function Claims(props: { value: AllowanceClaims; occupancy: boolean }): JSX.Element {
  const occupancy = untrack(() => props.occupancy);
  return (
    <>
      <Field label="Current period" value={integer(props.value.period)} />
      <Field label="Period resets" value={timestamp(props.value.resetsAt)} />
      <Show when={props.value.pools.length === 0}>
        <p>No tier pools were reported. Capacity is not inferred.</p>
      </Show>
      <For each={props.value.pools}>
        {pool => (
          <div class={s['pool']}>
            <h6>{pool.collection === 'People' ? 'Full · People' : 'Lite · LitePeople'}</h6>
            <Field label="Membership" value={pool.membership === 'verified' ? 'Verified' : 'Not found'} />
            <Field label="Allocation policy" value={pool.selected ? 'Selected pool' : 'Not selected'} />
            <Field
              label={occupancy ? 'Publishing slots' : 'Period claims'}
              value={`${integer(pool.used)} ${occupancy ? 'occupied' : 'used'} / ${integer(pool.limit)} limit · ${integer(pool.remaining)} remaining`}
            />
            <Show when={pool.membership === 'not-found'}>
              <p class={s['hint']}>
                Membership was not found; this tier is not an available allowance for this identity.
              </p>
            </Show>
            <Show
              when={pool.slots.length !== 0}
              fallback={<p>{occupancy ? 'No occupied slots reported.' : 'No occupied claim slots reported.'}</p>}
            >
              <details class={s['details']}>
                <summary>{occupancy ? 'Occupied slots and recipients' : 'Occupied claim slots'}</summary>
                <ul class={s['slots']}>
                  <For each={pool.slots}>
                    {slot => (
                      <li>
                        <Field label="Slot" value={integer(slot.index)} />
                        <Field label="Recipient account" value={slot.accountId ?? 'Unknown — recipient not exposed'} />
                        <Field
                          label="Product attribution"
                          value={slot.productId ?? 'Unknown — no verified product mapping'}
                        />
                        <Show when={slot.label !== undefined}>
                          <Field label="Host description" value={slot.label ?? ''} />
                        </Show>
                        <Show when={slot.since !== undefined}>
                          <Field label="Since" value={timestamp(slot.since ?? 0)} />
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
          </div>
        )}
      </For>
    </>
  );
}

function Group(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section class={s['group']}>
      <h4>{props.title}</h4>
      {props.children}
    </section>
  );
}

export function AllowanceSnapshot(props: { snapshot: WalletAllowanceSnapshot }): JSX.Element {
  const snapshot = untrack(() => props.snapshot);
  const noProduct = snapshot.productIds.length === 0;
  return (
    <div class={s['snapshot']} data-testid="td-wallet-allowance-snapshot">
      <Field label="Identity" value={snapshot.identityAccountId} />
      <Field label="Network" value={snapshot.networkSuffix} />
      <p class={s['hint']}>
        {noProduct
          ? 'No active product. Wallet-wide publishing slots and claim capacities are shown; product balances and quotas need an active product. Other wallets and non-default product accounts are outside this view.'
          : 'Wallet-wide publishing slots and claim capacities are shown. PGAS balances cover only the current product’s default account, Index(0). Bulletin quotas cover its separate storage account. Other products and derivations are outside this view.'}
      </p>
      <For each={snapshot.productIds}>{productId => <Field label="Inspected product" value={productId} />}</For>

      <Group title="Statement publishing">
        <p class={s['hint']}>
          Occupied publishing slots and recipients, not statement counts or consumed bytes. Eligible tier pools are
          shown separately; unknown recipients are not attributed to this product.
        </p>
        <Section title="Wallet-wide slot occupancy" data={snapshot.statementStore} chain="People">
          {value => (
            <>
              <Claims value={value} occupancy={true} />
              <Field label="Grace period" value={`${integer(value.graceSeconds)} seconds`} />
              <Field label="Replacement cooldown" value={`${integer(value.replacementCooldownSeconds)} seconds`} />
            </>
          )}
        </Section>
      </Group>

      <Group title="PGAS">
        <Section title="Current product balance · Index(0)" data={snapshot.pgasBalances} chain="Asset Hub">
          {value => (
            <>
              <Field label="Asset ID" value={value.assetId} />
              <Field label="Token symbol" value={value.symbol ?? 'Unavailable'} />
              <Field
                label="Token decimals"
                value={value.decimals === null ? 'Unavailable — base units only' : integer(value.decimals)}
              />
              <Show when={value.accounts.length === 0}>
                <p>
                  {noProduct
                    ? 'No active product account to inspect.'
                    : 'No product account balance was returned. Balance is unknown.'}
                </p>
              </Show>
              <For each={value.accounts}>
                {account => (
                  <div class={s['pool']}>
                    <Field label="Product" value={account.productId} />
                    <Field label="Account" value={account.accountId} />
                    <Field label="Derivation" value={`Index(${String(account.derivationIndex)})`} />
                    <Field
                      label="Total balance"
                      value={
                        account.balance === null
                          ? 'Unavailable'
                          : tokenBalance(account.balance, value.decimals, value.symbol)
                      }
                    />
                    <Show when={account.error !== undefined}>
                      <p class={s['error']}>{account.error}</p>
                    </Show>
                  </div>
                )}
              </For>
              <p class={s['hint']}>
                Total balance is not a promise of spendability and does not identify fees, spending or funding history.
              </p>
            </>
          )}
        </Section>
        <Section title="Wallet-wide claim capacity" data={snapshot.pgasClaims} chain="Asset Hub">
          {value => (
            <>
              <Field label="Claim asset ID" value={value.assetId} />
              <Field label="Amount per claim" value={`${integer(value.claimAmount)} base units`} />
              <p class={s['hint']}>
                Claim capacities are separate from the product balance. Only the policy-selected pool is used for
                allocation; tier capacities are not added together.
              </p>
              <Claims value={value} occupancy={false} />
              <Source observation={value.membershipObservation} chain="People membership" />
            </>
          )}
        </Section>
      </Group>

      <Group title="Bulletin storage">
        <Section title="Wallet-wide claim capacity" data={snapshot.bulletinClaims} chain="People">
          {value => (
            <>
              <p class={s['hint']}>
                Claims authorize storage; they are not stored bytes. Only the policy-selected pool is used for
                allocation; tier capacities are not added together.
              </p>
              <Claims value={value} occupancy={false} />
            </>
          )}
        </Section>
        <Section title="Current product storage account authorization" data={snapshot.bulletinQuotas} chain="Bulletin">
          {value => (
            <>
              <Show when={value.accounts.length === 0}>
                <p>
                  {noProduct
                    ? 'No active product account to inspect.'
                    : 'No product authorization was returned. Quota is unknown.'}
                </p>
              </Show>
              <For each={value.accounts}>
                {account => (
                  <div class={s['pool']}>
                    <Field label="Product" value={account.productId} />
                    <Field label="Account" value={account.accountId} />
                    <Field label="Authorization" value={authorization(account.status)} />
                    <Show when={account.status === 'active' || account.status === 'expired'}>
                      <Field
                        label="Bytes"
                        value={`${integer(account.bytesUsed)} used / ${integer(account.bytesLimit)} limit · ${integer(account.bytesRemaining)} remaining bytes`}
                      />
                      <Field
                        label="Submissions"
                        value={`${integer(account.transactionsUsed)} used / ${integer(account.transactionsLimit)} limit · ${integer(account.transactionsRemaining)} remaining submissions`}
                      />
                      <Field
                        label="Expiry"
                        value={
                          account.expiresAtBlock === undefined
                            ? 'Unavailable'
                            : `Bulletin block ${integer(account.expiresAtBlock)}`
                        }
                      />
                    </Show>
                    <Show when={account.error !== undefined}>
                      <p class={s['error']}>{account.error}</p>
                    </Show>
                  </div>
                )}
              </For>
            </>
          )}
        </Section>
      </Group>
    </div>
  );
}
