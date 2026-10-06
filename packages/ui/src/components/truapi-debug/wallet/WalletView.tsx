// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Wallet tab of the TrUAPI debug panel, in debug builds with the experimental
// wallet only. Draws what its controller (`./controller.ts`) publishes; the
// controller outlives tab swaps and owns every safety rule. Activity stays in
// the List and Timeline views.

import { For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { AllowanceSnapshot } from './AllowanceSnapshot.js';
import type { ProductUi, WalletController } from './controller.js';
import { Field } from './Field.js';
import s from './WalletView.module.css';

/** The Wallet tab panel. The host topbar's account badge controls it too. */
export const WALLET_VIEW_ID = 'td-wallet-view';
export const WALLET_TAB_ID = 'td-tab-wallet';

const OTHER_APP_NOTICE =
  'This browser keeps the test wallet separately for each app (Safari does this), and another app already has one. ' +
  'Use test wallet here would start a different wallet: import the same recovery phrase under Recovery instead, or use Chrome or Brave to share one wallet across apps.';
const SAFETY =
  'Without a recovery phrase backup, deleting this wallet or clearing site data permanently loses access. ' +
  'Scripts on this and other trusted host origins can access your shared wallet keys despite storage encryption. Real transactions remain possible.';
const IMPORT_SCOPE =
  'English BIP-39: 12, 15, 18, 21 or 24 words. No passphrase or custom derivation path. ' +
  'Uses native Polkadot host/Substrate account derivation, not Bitcoin/Ethereum seed derivation. ' +
  'Restores keys, not permissions. The username is looked up automatically after import. Keep the phrase private; anyone with it controls the wallet.';

function cx(...names: (string | undefined)[]): string {
  return names.filter(name => name !== undefined).join(' ');
}

function ProductDetails(props: { controller: WalletController }): JSX.Element {
  const c = untrack(() => props.controller);
  const shown = (): ProductUi => c.ui().product;
  const empty = (): string => {
    const p = shown();
    return p.kind === 'empty' ? p.text : '';
  };
  const product = (): Extract<ProductUi, { kind: 'product' }> | undefined => {
    const p = shown();
    return p.kind === 'product' ? p : undefined;
  };
  return (
    <section class={s['product']} data-testid="td-wallet-product">
      <Show when={shown().kind === 'empty' || shown().kind === 'product'}>
        <h3>Current product</h3>
      </Show>
      <Show when={shown().kind === 'empty'}>
        <p>{empty()}</p>
      </Show>
      <Show when={shown().kind === 'unavailable'}>
        <p>Current product information is unavailable from the native host. No account or allowance is inferred.</p>
      </Show>
      <Show when={product()}>
        {p => (
          <>
            <Field label="Product" value={p().product.name} />
            <Field label="Product ID" value={p().product.id} />
            <Field label="Origin" value={p().product.origin} />
            <Field label="Product account public key" value={p().product.accountPublicKey ?? 'Unavailable'} />
            <Show when={p().product.accountError !== undefined}>
              <p>{p().product.accountError}</p>
            </Show>
            <Field label="Derivation" value={p().product.derivation} />
            <h3>Product permissions</h3>
            <For each={p().product.permissions}>
              {permission => <Field label={permission.label} value={permission.status} />}
            </For>
            <Show when={p().product.permissions.length === 0}>
              <p>No persisted permissions are exposed for this product.</p>
            </Show>
            <p>
              Permission changes are reviewed by the host when a product requests access. The Wallet tab does not grant
              permissions implicitly.
            </p>
            <h3>Explicit allocation controls</h3>
            <p>
              These are last observed request outcomes, not balances or spending history. Consult Usage &amp; allowances
              for live chain state. Amount is host-determined; fees are not exposed. Nothing is replenished
              automatically.
            </p>
            <For each={p().rows} keyed={row => row.resource.id}>
              {row => (
                <div class={s['resource']} data-testid="td-wallet-resource">
                  <Field label="Resource" value={row().resource.label} />
                  <p>{row().outcome}</p>
                  <button
                    class={s['btn']}
                    type="button"
                    data-resource={row().resource.id}
                    disabled={row().disabled}
                    onClick={() => {
                      c.requestResource(row().resource);
                    }}
                  >
                    {row().action}
                  </button>
                </div>
              )}
            </For>
          </>
        )}
      </Show>
    </section>
  );
}

function Allowances(props: { controller: WalletController }): JSX.Element {
  const c = untrack(() => props.controller);
  const ui = c.ui;
  return (
    <section class={s['allowances']} aria-labelledby="td-wallet-allowances-title">
      <h3 id="td-wallet-allowances-title">Usage &amp; allowances</h3>
      <p>
        Read-only current snapshot, not activity history. Refreshing never allocates or renews resources. Action costs
        and spending attribution are not available.
      </p>
      <div class={s['actions']}>
        <button
          class={s['btn']}
          type="button"
          aria-label="Refresh usage and allowances"
          disabled={ui().allowanceRefreshDisabled}
          onClick={() => {
            c.refreshAllowances();
          }}
        >
          Refresh
        </button>
      </div>
      <p class={s['status']} role="status">
        {ui().allowanceStatus}
      </p>
      <div
        class={s['allowanceResults']}
        data-testid="td-wallet-allowance-results"
        aria-busy={ui().allowanceBusy ? 'true' : 'false'}
      >
        <Show when={ui().allowanceSnapshot} keyed>
          {snapshot => <AllowanceSnapshot snapshot={snapshot} />}
        </Show>
      </div>
    </section>
  );
}

function Recovery(props: { controller: WalletController }): JSX.Element {
  const c = untrack(() => props.controller);
  const ui = c.ui;
  return (
    <details
      class={s['recovery']}
      data-testid="td-wallet-recovery"
      ref={el => {
        c.refs.recovery = el;
      }}
      onToggle={() => {
        c.recoveryToggled();
      }}
    >
      <summary>Recovery</summary>
      <div class={s['recoveryContent']}>
        <p>{SAFETY}</p>
        <button
          class={s['btn']}
          type="button"
          disabled={ui().revealDisabled}
          onClick={() => {
            c.reveal();
          }}
        >
          Reveal recovery phrase
        </button>
        <textarea
          class={s['phrase']}
          data-testid="td-wallet-phrase"
          readonly
          rows="5"
          hidden={ui().phraseHidden}
          aria-label="Test wallet recovery phrase"
          autocomplete="off"
          spellcheck="false"
          ref={el => {
            c.refs.phrase = el;
          }}
        />
        <button
          class={s['btn']}
          type="button"
          hidden={ui().phraseHidden}
          onClick={() => {
            c.hide();
          }}
        >
          Hide recovery phrase
        </button>
        <label>
          Import test recovery phrase
          <textarea
            class={s['phrase']}
            data-testid="td-wallet-import-phrase"
            rows="4"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            aria-label="Recovery phrase to import"
            disabled={ui().importDisabled}
            ref={el => {
              c.refs.importPhrase = el;
            }}
          />
        </label>
        <p>{IMPORT_SCOPE}</p>
        <button
          class={s['btn']}
          type="button"
          disabled={ui().importDisabled}
          onClick={() => {
            c.importPhrase();
          }}
        >
          Import / replace test wallet
        </button>
        <button
          class={cx(s['btn'], s['delete'])}
          type="button"
          disabled={ui().removeDisabled}
          onClick={() => {
            c.remove();
          }}
        >
          Delete test wallet
        </button>
      </div>
    </details>
  );
}

export function WalletView(props: { controller: WalletController }): JSX.Element {
  const c = untrack(() => props.controller);
  const ui = c.ui;
  return (
    <section
      id={WALLET_VIEW_ID}
      class={s['view']}
      data-testid="td-wallet-view"
      role="tabpanel"
      aria-labelledby={WALLET_TAB_ID}
      tabindex="0"
      hidden={!ui().opened}
      aria-busy={ui().busy ? 'true' : undefined}
      ref={el => {
        c.refs.content = el;
      }}
    >
      <div class={s['overview']}>
        <p class={s['status']}>{ui().status}</p>
        <p>{ui().network}</p>
        <div class={s['actions']}>
          <button
            class={cx(s['btn'], s['primary'])}
            type="button"
            hidden={ui().activateHidden}
            disabled={ui().activateDisabled}
            onClick={() => {
              c.activate();
            }}
          >
            {ui().activateText}
          </button>
          <button
            class={s['btn']}
            type="button"
            hidden={ui().disconnectHidden}
            disabled={ui().disconnectDisabled}
            onClick={() => {
              c.disconnect();
            }}
          >
            Switch back to Mobile
          </button>
        </div>
        <p class={s['hint']} data-testid="td-wallet-other-app" role="status" hidden={ui().otherAppHidden}>
          {OTHER_APP_NOTICE}
        </p>
        <p
          class={s['username']}
          data-testid="td-wallet-username"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          hidden={ui().nameHidden}
          data-state={ui().nameState}
          data-stage={ui().nameStage}
        >
          <strong data-testid="td-wallet-username-title">{ui().nameTitle}</strong>
          <span hidden={ui().nameDetail === ''}>{ui().nameDetail}</span>
          <span class={s['knownName']} hidden={ui().knownName === ''}>
            {ui().knownName}
          </span>
        </p>
        <span class={s['elapsed']} data-testid="td-wallet-elapsed" hidden={ui().elapsedHidden}>
          {ui().elapsed}
        </span>
        <details
          class={cx(s['details'], s['error'])}
          data-testid="td-wallet-technical"
          hidden={ui().technicalError === ''}
          ref={el => {
            c.refs.technical = el;
          }}
        >
          <summary>Technical details</summary>
          <p>{ui().technicalError}</p>
        </details>
        <label hidden={ui().usernameHidden}>
          Username
          <input
            type="text"
            class={cx(s['input'], s['usernameInput'])}
            data-testid="td-wallet-username-input"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            aria-label="Base Lite username to claim"
            aria-describedby="td-wallet-username-hint"
            disabled={ui().usernameDisabled}
            onInput={() => {
              c.usernameInput();
            }}
            ref={el => {
              c.refs.username = el;
            }}
          />
        </label>
        <div class={s['actions']} hidden={ui().usernameActionsHidden}>
          <button
            class={cx(s['btn'], s['primary'])}
            data-testid="td-wallet-claim"
            type="button"
            hidden={ui().claimHidden}
            disabled={ui().claimDisabled}
            onClick={() => {
              c.claim();
            }}
          >
            {ui().claimText}
          </button>
          <button
            class={s['btn']}
            type="button"
            hidden={ui().refreshHidden}
            disabled={ui().refreshDisabled}
            onClick={() => {
              c.checkUsername();
            }}
          >
            {ui().refreshText}
          </button>
        </div>
        <p id="td-wallet-username-hint" class={s['hint']} hidden={ui().usernameHintHidden}>
          Choose a base name; the network adds a suffix.
        </p>
        <p class={s['warning']}>Test wallet only. Never use valuable funds or your main wallet.</p>
        <details class={s['details']}>
          <summary>Account details</summary>
          <p>{ui().identity}</p>
        </details>
        <ProductDetails controller={c} />
      </div>
      <Allowances controller={c} />
      <Recovery controller={c} />
      <p class={s['message']} role="alert" hidden={ui().messageHidden}>
        {ui().message}
      </p>
    </section>
  );
}
