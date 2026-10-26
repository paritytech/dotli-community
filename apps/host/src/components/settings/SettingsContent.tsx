// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, For, Show, untrack, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  BACKEND_LABELS,
  type Backend,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  type Network,
  type Settings,
} from '@dotli/config';
import { ReloadIcon, TerminalIcon, TrashIcon } from '@dotli/ui/icons';
import {
  Button,
  Chip,
  Choice,
  Hint,
  Row,
  SectionLabel,
  SegmentedControl,
  type SegmentOption,
  Stack,
  Surface,
  SurfaceFoot,
  SurfaceHead,
  Switch,
  usePopover,
  Well,
} from '@dotli/ui';
import { AppearancePicker } from './Appearance.js';
import type { ThemePref } from '../../runtime/state/theme.js';
import type { ApplySettings, SavedSettings } from './settings.js';
import s from './SettingsContent.module.css';

type Transport = {
  value: Backend;
  description: string;
  recommended: boolean;
};

const TRANSPORTS: readonly Transport[] = [
  { value: 'smoldot-direct', description: 'Verified in your browser, separate for each tab', recommended: true },
  { value: 'smoldot-shared-worker', description: 'Verified in your browser, shared across tabs', recommended: false },
  { value: 'rpc-gateway', description: 'Fetched from trusted servers. Fastest, but less private', recommended: false },
];

type Category = 'general' | 'network' | 'advanced';

const CATEGORIES: readonly SegmentOption<Category>[] = [
  { value: 'general', label: 'General', testId: 'settings-category-general' },
  { value: 'network', label: 'Network', testId: 'settings-category-network' },
  { value: 'advanced', label: 'Advanced', testId: 'settings-category-advanced' },
];

type CacheKey = 'skipCidCache' | 'skipArchiveCache' | 'skipWorkerCache';

/**
 * Each switch turns its cache off through its `skip` flag. Worker cache off purges the protocol iframe's IDB
 * state before init, so every cold start boots from scratch.
 */
const CACHES: readonly [CacheKey, string][] = [
  ['skipCidCache', 'dotNS cache'],
  ['skipArchiveCache', 'Archive cache'],
  ['skipWorkerCache', 'Worker cache'],
];

export type SettingsContentProps = {
  /** Null until the page has read them. */
  settings: Accessor<SavedSettings | null>;
  /** dotli's version, beside the heading. */
  version: string;
  theme: Accessor<ThemePref>;
  onTheme: (theme: ThemePref) => void;
  onApply: ApplySettings;
  /** The debug panel is on in this tab, so Advanced offers no way to turn it on. */
  debugMode: Accessor<boolean>;
  /** Reloads the tab with the debug panel. */
  onDebugMode: () => void;
};

/**
 * One opening's panel, on General each time. Network and cache changes stay a draft across categories until Save and
 * apply, and closing drops the draft. The theme applies at once.
 */
function SettingsPanel(props: SettingsContentProps & { saved: SavedSettings }): JSX.Element {
  const popover = usePopover();
  const saved = untrack(() => props.saved);
  const persisted: Settings = { backend: saved.backend, network: saved.network, cache: saved.cache };
  const [backend, setBackend] = createSignal<Backend>(persisted.backend);
  const [network, setNetwork] = createSignal<Network>(persisted.network);
  const [cache, setCache] = createSignal(persisted.cache);
  const [category, setCategory] = createSignal<Category>('general');
  const [applying, setApplying] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);

  const dirty = createMemo(() => {
    const draft = cache();
    return (
      backend() !== persisted.backend ||
      network() !== persisted.network ||
      CACHES.some(([key]) => draft[key] !== persisted.cache[key])
    );
  });

  const clearAll = (): void => {
    if (untrack(clearing)) {
      return;
    }
    setClearing(true);
    // Wipes every origin whatever the cache toggles say, then re-seeds localStorage with the baseline.
    void props.onApply(persisted, persisted, { forceFullWipe: true });
  };

  const apply = (): void => {
    if (!untrack(dirty) || untrack(applying)) {
      return;
    }
    setApplying(true);
    void props.onApply(
      {
        backend: untrack(backend),
        network: untrack(network),
        cache: untrack(cache),
      },
      persisted,
    );
  };

  const networks = saved.enabledNetworks;
  const unavailable = (value: Backend): boolean => value === 'smoldot-shared-worker' && !saved.sharedWorkerAvailable;

  return (
    <Surface width="lg" padded>
      <SurfaceHead
        title="Settings"
        aside={
          <Chip tone="mono" testId="mode-version">
            v{props.version}
          </Chip>
        }
      />
      <div class={s['sections']} data-testid="mode-popover-sections">
        <SegmentedControl<Category>
          label="Settings category"
          options={CATEGORIES}
          value={category()}
          onChange={setCategory}
          block
          testId="settings-categories"
        />
        <Show when={category() === 'general'}>
          <Stack>
            <SectionLabel text="Appearance" />
            <AppearancePicker theme={props.theme} onTheme={props.onTheme} />
          </Stack>
        </Show>
        <Show when={category() === 'network'}>
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
                    selected={backend() === transport.value}
                    radio={{
                      name: 'dotli-backend',
                      value: transport.value,
                      disabled: unavailable(transport.value),
                      onChoose: () => {
                        setBackend(transport.value);
                      },
                    }}
                  />
                )}
              </For>
            </Stack>
          </Stack>
        </Show>
        <Show when={category() === 'advanced'}>
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
            {/* So users need not toggle a setting back and forth just to wipe state. */}
            <div data-testid="mode-clear-all-row">
              <Button
                block
                onClick={clearAll}
                title="Wipe every cache, database, and worker across all origins. The app will reload from a clean baseline."
                disabled={clearing()}
              >
                <TrashIcon class={s['icon']} />
                {clearing() ? 'Clearing…' : 'Clear all caches'}
              </Button>
            </div>
          </Stack>
          <Show when={!props.debugMode()}>
            <div data-testid="mode-debug-row">
              <Button
                block
                onClick={props.onDebugMode}
                title="Reload this tab with the debug panel and its diagnostics"
              >
                <TerminalIcon class={s['icon']} />
                Open in debug mode
              </Button>
            </div>
          </Show>
        </Show>
      </div>
      <SurfaceFoot
        hint={
          <Hint icon={ReloadIcon} testId="mode-apply-warning">
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
 * The settings popover's body, its own chunk.
 * The Popover remounts it per opening, so each draft starts from what is saved.
 */
export function SettingsContent(props: SettingsContentProps): JSX.Element {
  const popover = usePopover();
  return (
    <div class={s['content']} id="mode-popover-content" data-sheet={popover.sheet() ? '' : undefined}>
      {/* Not keyed, so later writes of the saved settings do not remount the panel mid-edit. */}
      <Show when={props.settings()}>{saved => <SettingsPanel {...props} saved={saved()} />}</Show>
    </div>
  );
}
