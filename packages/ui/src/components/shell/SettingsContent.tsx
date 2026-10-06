// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { BACKEND_LABELS, type Backend, NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';

import { applyAndReset, type ModeDraft } from '../../settings-actions.js';
import { settingsStore, type SettingsState } from '../../state/settings.js';
import { Button } from '../primitives/Button.js';
import { Chip } from '../primitives/Chip.js';
import { Choice } from '../primitives/Choice.js';
import { SectionLabel, Stack } from '../primitives/SectionLabel.js';
import { Hint, ReloadIcon, Surface, SurfaceFoot, SurfaceHead } from '../primitives/Surface.js';
import { Switch } from '../primitives/Switch.js';
import { Row, Well } from '../primitives/Well.js';
import { useStore } from '../use-store.js';
import { Diagnostics } from './Diagnostics.js';
import { ReceivingContent } from './ReceivingContent.js';
import { usePopover } from '../floating/Popover.js';
import s from './SettingsContent.module.css';

interface Transport {
  value: Backend;
  description: string;
  recommended: boolean;
}

const TRANSPORTS: readonly Transport[] = [
  { value: 'smoldot-direct', description: 'Verified in your browser, separate for each tab', recommended: true },
  { value: 'smoldot-shared-worker', description: 'Verified in your browser, shared across tabs', recommended: false },
  { value: 'rpc-gateway', description: 'Fetched from trusted servers. Fastest, but less private', recommended: false },
];

type CacheKey = 'skipCidCache' | 'skipArchiveCache' | 'skipWorkerCache';

/**
 * The cache switches, each turning its cache off with its `skip` flag. Worker
 * cache off makes the protocol iframe purge its IDB state (smoldot chain DB
 * and polkadot-api caches) before initialisation, so every cold start boots
 * from scratch: a deterministic baseline for a slower start.
 */
const CACHES: readonly [CacheKey, string][] = [
  ['skipCidCache', 'dotNS cache'],
  ['skipArchiveCache', 'Archive cache'],
  ['skipWorkerCache', 'Worker cache'],
];

function TrashIcon(): JSX.Element {
  return (
    <svg
      class={s['icon']}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

/**
 * The popover's content for one opening. It starts from the saved settings
 * and keeps network, transport, cache and runtime changes in a draft until
 * Save and apply. Receiving controls take effect immediately. The next
 * opening starts afresh, so a closed popover drops its settings draft.
 */
function SettingsPanel(props: { saved: SettingsState }): JSX.Element {
  const popover = usePopover();
  const saved = untrack(() => props.saved);
  const persisted: ModeDraft = {
    chain: saved.backend,
    network: saved.network,
    cache: saved.cache,
    polkaVmAppsEnabled: saved.polkaVmAppsEnabled,
  };
  const [chain, setChain] = createSignal<Backend>(persisted.chain);
  const [network, setNetwork] = createSignal<Network>(persisted.network);
  const [cache, setCache] = createSignal(persisted.cache);
  const [polkaVmAppsEnabled, setPolkaVmAppsEnabled] = createSignal(persisted.polkaVmAppsEnabled);
  const [applying, setApplying] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);
  const [resetError, setResetError] = createSignal('');

  const dirty = createMemo(() => {
    const draft = cache();
    return (
      chain() !== persisted.chain ||
      network() !== persisted.network ||
      CACHES.some(([key]) => draft[key] !== persisted.cache[key]) ||
      polkaVmAppsEnabled() !== persisted.polkaVmAppsEnabled
    );
  });

  const clearAll = (): void => {
    if (untrack(clearing) || untrack(applying)) {
      return;
    }
    setClearing(true);
    setResetError('');
    // Reset all origins regardless of cache toggles, retaining receiving
    // revocation tombstones until remote deletion is acknowledged.
    void applyAndReset(persisted, persisted, { forceFullWipe: true }).catch(() => {
      setClearing(false);
      setResetError(
        'Could not clear all caches. Background receiving revocation must be saved before reset. Try again.',
      );
    });
  };

  const apply = (): void => {
    if (!untrack(dirty) || untrack(applying) || untrack(clearing)) {
      return;
    }
    setApplying(true);
    setResetError('');
    void applyAndReset(
      {
        chain: untrack(chain),
        network: untrack(network),
        cache: untrack(cache),
        polkaVmAppsEnabled: untrack(polkaVmAppsEnabled),
      },
      persisted,
    ).catch(() => {
      setApplying(false);
      setResetError(
        'Could not apply settings. Background receiving revocation must be saved before changing networks. Try again.',
      );
    });
  };

  const networks = saved.enabledNetworks;
  const unavailable = (value: Backend): boolean => value === 'smoldot-shared-worker' && !saved.sharedWorkerAvailable;

  return (
    <Surface width="xl">
      <SurfaceHead title="Settings" />
      <div class={s['columns']} data-testid="mode-popover-columns">
        <div class={s['column']}>
          <Show when={networks.length > 1}>
            <Stack>
              <SectionLabel text="Network" />
              <Stack role="radiogroup" aria-label="Network">
                <For each={networks}>
                  {value => (
                    <Choice
                      title={NETWORK_NAME_TO_SERVICES_CONFIG[value].label}
                      description={NETWORK_NAME_TO_SERVICES_CONFIG[value].description}
                      selected={network() === value}
                      radio={{
                        name: 'dotli-network',
                        value,
                        onChoose: () => {
                          setNetwork(value);
                        },
                      }}
                    />
                  )}
                </For>
              </Stack>
            </Stack>
          </Show>
          <Stack>
            <SectionLabel text="Network transport" />
            <Stack role="radiogroup" aria-label="Network transport">
              <For each={TRANSPORTS}>
                {transport => (
                  <Choice
                    title={BACKEND_LABELS[transport.value]}
                    description={
                      unavailable(transport.value)
                        ? 'Unavailable in this browser or private window'
                        : transport.description
                    }
                    chip={transport.recommended ? <Chip tone="ok">Recommended</Chip> : undefined}
                    selected={chain() === transport.value}
                    radio={{
                      name: 'dotli-backend',
                      value: transport.value,
                      disabled: unavailable(transport.value),
                      onChoose: () => {
                        setChain(transport.value);
                      },
                    }}
                  />
                )}
              </For>
            </Stack>
          </Stack>
          <Stack>
            <SectionLabel text="Cache" />
            <Well layout="controls" testId="mode-cache">
              <For each={CACHES}>
                {([key, label]) => (
                  <Row label={label}>
                    <Switch
                      label={label}
                      checked={!cache()[key]}
                      onChange={enabled => {
                        setCache(c => ({ ...c, [key]: !enabled }));
                      }}
                    />
                  </Row>
                )}
              </For>
            </Well>
            {/* Manual "clear everything" escape hatch, through the same
                full-reset pipeline as Save and apply, so users don't have to
                toggle a setting back and forth just to wipe state. */}
            <div data-testid="mode-clear-all-row">
              <Button
                block
                onClick={clearAll}
                title="Clear caches and reset app data across all origins. Receiving revocation records remain until remote deletion is acknowledged. The app will reload."
                disabled={clearing() || applying()}
              >
                <TrashIcon />
                {clearing() ? 'Clearing…' : 'Clear all caches'}
              </Button>
            </div>
          </Stack>
          <Stack>
            <SectionLabel text="Experimental" />
            <Well layout="controls" testId="mode-experimental">
              <Row label="PolkaVM apps">
                <Switch label="PolkaVM apps" checked={polkaVmAppsEnabled()} onChange={setPolkaVmAppsEnabled} />
              </Row>
            </Well>
          </Stack>
          <ReceivingContent />
        </div>
        <Diagnostics backend={persisted.chain} />
      </div>
      <SurfaceFoot
        hint={
          <Hint icon={<ReloadIcon />} testId="mode-apply-warning">
            Transport and cache changes reload the app
          </Hint>
        }
      >
        <div class={s['apply']} data-testid="mode-apply-row">
          <Button
            variant="primary"
            block={popover.sheet()}
            onClick={apply}
            disabled={!dirty() || applying() || clearing()}
          >
            {applying() ? 'Resetting…' : 'Save and apply'}
          </Button>
        </div>
        <Show when={resetError()}>
          <p class={s['error']} role="alert" data-testid="mode-reset-error">
            {resetError()}
          </p>
        </Show>
      </SurfaceFoot>
    </Surface>
  );
}

/**
 * The settings popover's body (SettingsPopover), its own chunk: the panel,
 * from the saved settings, once the store is seeded. Each opening mounts it
 * afresh (the Popover remounts its content per opening), so its draft starts
 * from what is saved; later writes to the store do not remount it mid-edit.
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
