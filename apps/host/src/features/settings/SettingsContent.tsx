// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, For, Show, untrack, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Backend, Network, Settings } from '@dotli/config';
import { ReloadIcon, TerminalIcon, TrashIcon } from '@dotli/ui/icons';
import {
  Button,
  Chip,
  Hint,
  Row,
  SectionLabel,
  SegmentedControl,
  type SegmentOption,
  Spinner,
  Stack,
  Surface,
  SurfaceFoot,
  SurfaceHead,
  Switch,
  usePopover,
  Well,
} from '@dotli/ui';
import { AppearancePicker } from './Appearance.js';
import { NetworkChoices } from './NetworkChoices.js';
import { TransportChoices } from './TransportChoices.js';
import type { ThemePreference } from './themeState.js';
import { isResetRunning, type ApplySettings, type SavedSettings, type SettingsResetStatus } from './settings.js';
import s from './SettingsContent.module.css';

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
  theme: Accessor<ThemePreference>;
  onTheme: (theme: ThemePreference) => void;
  onApply: ApplySettings;
  /** The page's settings reset, which disables both buttons while it runs. */
  reset: Accessor<SettingsResetStatus>;
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

  const dirty = createMemo(() => {
    const draft = cache();
    return (
      backend() !== persisted.backend ||
      network() !== persisted.network ||
      CACHES.some(([key]) => draft[key] !== persisted.cache[key])
    );
  });

  function clearAll(): void {
    // Wipes every origin whatever the cache toggles say, then re-seeds localStorage with the baseline.
    void props.onApply(persisted, persisted, { forceFullWipe: true });
  }

  function apply(): void {
    void props.onApply({ backend: backend(), network: network(), cache: cache() }, persisted);
  }

  const networks = saved.enabledNetworks;
  const severalNetworks = networks.length > 1;
  // General only picks the theme, which applies at once, so its foot shows only for a draft from another category or
  // a save that runs. A save keeps the foot, hint row included, in place until the page reloads.
  const showFoot = (): boolean => category() !== 'general' || dirty() || props.reset() === 'applying';

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
            {/* The chrome stays dark, so a pick shows nothing here and says what it themes. */}
            <Hint testId="theme-hint">Apps that support it follow this theme</Hint>
          </Stack>
        </Show>
        <Show when={category() === 'network'}>
          <Show when={severalNetworks}>
            <Stack>
              <SectionLabel text="Network" />
              <NetworkChoices networks={networks} value={network()} onChoose={setNetwork} />
            </Stack>
          </Show>
          <Stack>
            {/* Alone in the category, the transport list needs no label that repeats its name. */}
            <Show when={severalNetworks}>
              <SectionLabel text="Network transport" />
            </Show>
            <TransportChoices
              value={backend()}
              sharedWorkerAvailable={saved.sharedWorkerAvailable}
              onChoose={setBackend}
            />
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
                variant="danger"
                onClick={clearAll}
                title="Wipe every cache, database, and worker across all origins. The app will reload from a clean baseline."
                disabled={isResetRunning(props.reset())}
                loading={props.reset() === 'clearing'}
                aria-label={props.reset() === 'clearing' ? 'Clearing…' : undefined}
              >
                <TrashIcon class={s['icon']} />
                Clear all caches
              </Button>
            </div>
          </Stack>
          <Show when={!props.debugMode()}>
            <Stack>
              <SectionLabel text="Debug" />
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
            </Stack>
          </Show>
        </Show>
      </div>
      <Show when={showFoot()}>
        <SurfaceFoot
          hint={
            <Hint icon={ReloadIcon} testId="mode-apply-warning">
              Transport and cache changes reload the page
            </Hint>
          }
        >
          <div class={s['apply']} data-testid="mode-apply-row">
            <Button
              variant="primary"
              block={popover.sheet()}
              onClick={apply}
              disabled={!dirty() || isResetRunning(props.reset())}
              loading={props.reset() === 'applying'}
              aria-label={props.reset() === 'applying' ? 'Applying…' : undefined}
            >
              Save and apply
            </Button>
          </div>
        </SurfaceFoot>
      </Show>
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
    <div id="mode-popover-content" data-sheet={popover.sheet() ? '' : undefined}>
      {/* Not keyed, so later writes of the saved settings do not remount the panel mid-edit. */}
      <Show
        when={props.settings()}
        fallback={
          <div class={s['loading']} role="status" aria-label="Reading settings" data-testid="settings-loading">
            <Spinner />
          </div>
        }
      >
        {saved => <SettingsPanel {...props} saved={saved()} />}
      </Show>
    </div>
  );
}
