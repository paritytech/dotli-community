// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { BACKEND_LABELS, type Backend, NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';

import { applyAndReset, dotliVersion, isTruapiDebugEnabled, type ModeDraft } from '../../settings-actions.js';
import { settingsStore, type SettingsState } from '../../state/settings.js';
import { Button } from '../primitives/Button.js';
import { Chip } from '../primitives/Chip.js';
import { Choice } from '../primitives/Choice.js';
import { SectionLabel, Stack } from '../primitives/SectionLabel.js';
import { Hint, ReloadIcon, Surface, SurfaceFoot, SurfaceHead } from '../primitives/Surface.js';
import { Switch } from '../primitives/Switch.js';
import { Row, Well } from '../primitives/Well.js';
import { useStore } from '../use-store.js';
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

function TerminalIcon(): JSX.Element {
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
      <path d="m4 17 6-6-6-6m8 14h8" />
    </svg>
  );
}

/** Reload the tab with the debug panel open, which holds the diagnostics. */
function openInDebugMode(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('debug', 'true');
  window.location.assign(url.toString());
}

/**
 * The popover's content for one opening. It starts from the saved settings
 * and keeps the changes in a draft: nothing is saved or reloaded until Save
 * and apply, and the next opening starts afresh, so a closed popover drops
 * its draft.
 */
function SettingsPanel(props: { saved: SettingsState }): JSX.Element {
  const popover = usePopover();
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
      CACHES.some(([key]) => draft[key] !== persisted.cache[key])
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
    <Surface width="lg" class={s['panel']}>
      <SurfaceHead
        title="Settings"
        aside={
          <Chip tone="mono" testId="mode-version">
            v{dotliVersion()}
          </Chip>
        }
      />
      <div class={s['sections']} data-testid="mode-popover-sections">
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
              title="Wipe every cache, database, and worker across all origins. The app will reload from a clean baseline."
              disabled={clearing()}
            >
              <TrashIcon />
              {clearing() ? 'Clearing…' : 'Clear all caches'}
            </Button>
          </div>
        </Stack>
        <Show when={!isTruapiDebugEnabled()}>
          <div data-testid="mode-debug-row">
            <Button block onClick={openInDebugMode} title="Reload this tab with the debug panel and its diagnostics">
              <TerminalIcon />
              Open in debug mode
            </Button>
          </div>
        </Show>
      </div>
      <SurfaceFoot
        hint={
          <Hint icon={<ReloadIcon />} testId="mode-apply-warning">
            Transport and cache changes reload the app
          </Hint>
        }
      >
        <div class={s['apply']} data-testid="mode-apply-row">
          <Button variant="primary" block={popover.sheet()} onClick={apply} disabled={!dirty() || applying()}>
            {applying() ? 'Resetting…' : 'Save and apply'}
          </Button>
        </div>
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
