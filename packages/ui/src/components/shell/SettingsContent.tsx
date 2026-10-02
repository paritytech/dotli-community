// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { BACKEND_LABELS, type Backend, NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';

import { applyAndReset, type ModeDraft } from '../../settings-actions.js';
import { settingsStore, type SettingsState } from '../../state/settings.js';
import { useStore } from '../use-store.js';
import { Diagnostics } from './Diagnostics.js';
import { usePopover } from './Popover.js';
import { CacheToggle, ClearButton, RadioRow, SettingsRow, SettingsSection } from './SettingsRows.js';
import s from './SettingsContent.module.css';

const CHAIN_CHOICES: [Backend, string][] = [
  ['smoldot-direct', 'Verified in your browser, separate per tab (recommended)'],
  ['smoldot-shared-worker', 'Verified in your browser, shared across tabs'],
  ['rpc-gateway', 'Fetched from trusted servers, fastest but less private'],
];

/**
 * The popover's content for one opening. It starts from the saved settings
 * and keeps the changes in a draft: nothing is saved or reloaded until Save
 * & Apply, and the next opening starts afresh, so a closed popover drops
 * its draft.
 */
function SettingsPanel(props: { saved: SettingsState }): JSX.Element {
  const saved = untrack(() => props.saved);
  const persisted: ModeDraft = {
    chain: saved.backend,
    network: saved.network,
    cache: saved.cache,
  };
  const [chain, setChain] = createSignal<Backend>(persisted.chain);
  const [network, setNetwork] = createSignal<Network>(persisted.network);
  const [cache, setCache] = createSignal(persisted.cache);
  const [applying, setApplying] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);

  const dirty = createMemo(() => {
    const draft = cache();
    return (
      chain() !== persisted.chain ||
      network() !== persisted.network ||
      draft.skipCidCache !== persisted.cache.skipCidCache ||
      draft.skipArchiveCache !== persisted.cache.skipArchiveCache ||
      draft.skipWorkerCache !== persisted.cache.skipWorkerCache
    );
  });

  const clearAll = (): void => {
    if (untrack(clearing)) {
      return;
    }
    setClearing(true);
    // Force the full-reset pipeline: wipe every origin regardless of the
    // current cache toggles, then re-seed localStorage with the baseline.
    void applyAndReset(persisted, persisted, { forceFullWipe: true });
  };

  const apply = (): void => {
    if (!untrack(dirty) || untrack(applying)) {
      return;
    }
    setApplying(true);
    void applyAndReset(
      {
        chain: untrack(chain),
        network: untrack(network),
        cache: untrack(cache),
      },
      persisted,
    );
  };

  const networks = saved.enabledNetworks;
  const unavailable = (value: Backend): boolean => value === 'smoldot-shared-worker' && !saved.sharedWorkerAvailable;

  return (
    <>
      {/* Two-column grid. Left: backend / cache. Right: diagnostics. Save &
          Apply and the footer span both columns at the bottom. One column in
          a sheet (CSS). */}
      <div class={s['columns']} data-testid="mode-popover-columns">
        <div class={s['col']}>
          {networks.length > 1 && (
            <>
              <SettingsSection text="Network" />
              <div role="radiogroup" aria-label="Network">
                <For each={networks}>
                  {value => (
                    <RadioRow
                      name="dotli-network"
                      value={value}
                      label={NETWORK_NAME_TO_SERVICES_CONFIG[value].label}
                      description={NETWORK_NAME_TO_SERVICES_CONFIG[value].description}
                      selected={network() === value}
                      choose={() => {
                        setNetwork(value);
                      }}
                    />
                  )}
                </For>
              </div>
            </>
          )}
          {/* Only separate from the Network section when there is one.
              With a single enabled network this header leads the column and
              must line up with Diagnostics opposite. */}
          <SettingsSection text="Network Transport" spacing={networks.length > 1 ? 'spaced' : undefined} />
          <div role="radiogroup" aria-label="Network Transport">
            <For each={CHAIN_CHOICES}>
              {([value, description]) => (
                <RadioRow
                  name="dotli-backend"
                  value={value}
                  label={BACKEND_LABELS[value]}
                  description={unavailable(value) ? 'Unavailable in this browser or private window' : description}
                  selected={chain() === value}
                  disabled={unavailable(value)}
                  choose={() => {
                    setChain(value);
                  }}
                />
              )}
            </For>
          </div>
          <SettingsSection text="Cache" spacing="bottom" />
          <CacheToggle
            label="dotNS cache"
            checked={!persisted.cache.skipCidCache}
            update={enabled => {
              setCache(c => ({ ...c, skipCidCache: !enabled }));
            }}
          />
          <CacheToggle
            label="Archive cache"
            checked={!persisted.cache.skipArchiveCache}
            update={enabled => {
              setCache(c => ({ ...c, skipArchiveCache: !enabled }));
            }}
          />
          {/* Worker cache: when off, the protocol iframe purges its IDB
              state (smoldot chain DB and polkadot-api caches) before
              initialisation, so every cold start boots from scratch. Trades
              startup time for a deterministic baseline. */}
          <CacheToggle
            label="Worker cache"
            checked={!persisted.cache.skipWorkerCache}
            update={enabled => {
              setCache(c => ({ ...c, skipWorkerCache: !enabled }));
            }}
          />
          {/* Manual "clear everything" escape hatch, through the same
              full-reset pipeline as Save & Apply, so users don't have to
              toggle a setting back and forth just to wipe state. */}
          <SettingsRow class={s['clearAllRow']} testId="mode-clear-all-row">
            <ClearButton
              onClick={clearAll}
              title="Wipe every cache, database, and worker across all origins. The app will reload from a clean baseline."
              disabled={clearing()}
            >
              {clearing() ? 'Clearing…' : 'Clear all caches'}
            </ClearButton>
          </SettingsRow>
        </div>
        <div class={s['col']}>
          <SettingsSection text="Diagnostics" />
          <Diagnostics backend={persisted.chain} />
        </div>
      </div>
      {/* The footer wraps the divider, Save & Apply, and the warning as one
          unit so it can pin to the bottom of the full-screen sheet on mobile
          (CSS), keeping the primary action reachable. */}
      <div class={s['footer']}>
        <div class={s['divider']} />
        <SettingsRow class={s['applyRow']} testId="mode-apply-row">
          <ClearButton onClick={apply} primary={dirty()} disabled={!dirty() || applying()}>
            {applying() ? 'Resetting…' : 'Save & Apply'}
          </ClearButton>
        </SettingsRow>
        {/* Applying reloads the app. Backend and network changes keep
            caches warm; only caches the user turns off get cleared. Shown
            only while the draft is dirty so the idle popover isn't noisy. */}
        <p class={s['warning']} data-testid="mode-apply-warning" data-visible={dirty() ? '' : undefined}>
          Applying reloads the app. Caches you turn off are cleared.
        </p>
      </div>
    </>
  );
}

/**
 * The settings popover's body (SettingsPopover), its own chunk: the panel,
 * from the saved settings, once the store is seeded. Each opening mounts it
 * afresh (the Popover remounts its content per opening), so its draft starts
 * from what is saved; later writes to the store do not remount it mid-edit.
 * In a sheet (`data-sheet`) the columns stack and the footer pins to the
 * sheet's bottom edge.
 */
export function SettingsContent(): JSX.Element {
  const popover = usePopover();
  const settings = useStore(settingsStore);
  return (
    <div class={s['content']} id="mode-popover-content" data-sheet={popover.sheet() ? '' : undefined}>
      {/* Not keyed: the panel mounts once the store is seeded, and reads the
          saved settings once (untracked). */}
      <Show when={settings()}>{saved => <SettingsPanel saved={saved()} />}</Show>
    </div>
  );
}
