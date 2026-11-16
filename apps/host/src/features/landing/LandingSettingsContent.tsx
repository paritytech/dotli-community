// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show, untrack, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Backend, Network } from '@dotli/config';
import { ReloadIcon, TrashIcon } from '@dotli/ui/icons';
import {
  Button,
  Chip,
  Hint,
  SectionLabel,
  SegmentedControl,
  type SegmentOption,
  Stack,
  Surface,
  SurfaceFoot,
  SurfaceHead,
  usePopover,
} from '@dotli/ui';
import { NetworkChoices } from '../settings/index.js';
import { TransportChoices } from '../settings/index.js';
import { isResetRunning, type ApplySettings, type SavedSettings, type SettingsResetStatus } from '../settings/index.js';
import s from './LandingSettingsContent.module.css';

type Category = 'network' | 'provider' | 'advanced';

const CATEGORIES: readonly SegmentOption<Category>[] = [
  { value: 'network', label: 'Network', testId: 'landing-settings-category-network' },
  { value: 'provider', label: 'Provider', testId: 'landing-settings-category-provider' },
  { value: 'advanced', label: 'Advanced', testId: 'landing-settings-category-advanced' },
];

export type LandingSettingsContentProps = {
  /** Null until the page has read them. */
  settings: Accessor<SavedSettings | null>;
  /** dotli's version, beside the heading. */
  version: string;
  onApply: ApplySettings;
  /** The page's settings reset, which disables both buttons while it runs. */
  reset: Accessor<SettingsResetStatus>;
  /** Empties the name list and reloads the page. It never settles once the reload starts. */
  onClearCache: () => Promise<void>;
};

/**
 * The landing settings popover's body, its own chunk.
 * The Popover remounts it per opening, so each draft starts from what is saved.
 */
export function LandingSettingsContent(props: LandingSettingsContentProps): JSX.Element {
  const popover = usePopover();
  return (
    <div class={s['content']} data-sheet={popover.sheet() ? '' : undefined}>
      {/* Not keyed, so later writes of the saved settings do not remount the panel mid-edit. */}
      <Show when={props.settings()}>{saved => <LandingSettingsPanel {...props} saved={saved()} />}</Show>
    </div>
  );
}

/**
 * One opening's panel, on its first category each time. Network shows only on a deployment with more than one network.
 * The network and transport choices stay a draft across categories until Save and apply, and closing drops the draft.
 */
function LandingSettingsPanel(props: LandingSettingsContentProps & { saved: SavedSettings }): JSX.Element {
  const popover = usePopover();
  const saved = untrack(() => props.saved);
  const [network, setNetwork] = createSignal<Network>(saved.network);
  const [backend, setBackend] = createSignal<Backend>(saved.backend);
  const categories = saved.enabledNetworks.length > 1 ? CATEGORIES : CATEGORIES.filter(c => c.value !== 'network');
  const [category, setCategory] = createSignal<Category>(categories[0]?.value ?? 'provider');
  const [clearing, setClearing] = createSignal(false);

  function clearCache(): void {
    setClearing(true);
    void props.onClearCache();
  }

  function apply(): void {
    void props.onApply(
      { backend: backend(), network: network(), cache: saved.cache },
      { backend: saved.backend, network: saved.network, cache: saved.cache },
    );
  }

  return (
    <Surface width="lg" padded>
      <SurfaceHead
        title="Settings"
        aside={
          <Chip tone="mono" testId="landing-settings-version">
            v{props.version}
          </Chip>
        }
      />
      <div class={s['sections']}>
        <SegmentedControl<Category>
          label="Settings category"
          options={categories}
          value={category()}
          onChange={setCategory}
          block
          testId="landing-settings-categories"
        />
        <Show when={category() === 'network'}>
          <NetworkChoices networks={saved.enabledNetworks} value={network()} onChoose={setNetwork} />
        </Show>
        <Show when={category() === 'provider'}>
          <TransportChoices
            value={backend()}
            sharedWorkerAvailable={saved.sharedWorkerAvailable}
            onChoose={setBackend}
          />
        </Show>
        <Show when={category() === 'advanced'}>
          <Stack>
            <SectionLabel text="Cache" />
            <div data-testid="landing-settings-clear-row">
              <Button
                block
                onClick={clearCache}
                title="Forget the app names suggested under the name input and reload. The page reads them from the network again."
                disabled={clearing() || isResetRunning(props.reset())}
              >
                <TrashIcon class={s['icon']} />
                {clearing() ? 'Clearing…' : 'Clear cache'}
              </Button>
            </div>
          </Stack>
        </Show>
      </div>
      <SurfaceFoot
        hint={
          <Hint icon={ReloadIcon} testId="landing-settings-apply-warning">
            Network and transport changes reload the page
          </Hint>
        }
      >
        <div class={s['apply']} data-testid="landing-settings-apply-row">
          <Button
            variant="primary"
            block={popover.sheet()}
            onClick={apply}
            disabled={
              (network() === saved.network && backend() === saved.backend) ||
              clearing() ||
              isResetRunning(props.reset())
            }
          >
            {isResetRunning(props.reset()) ? 'Resetting…' : 'Save and apply'}
          </Button>
        </div>
      </SurfaceFoot>
    </Surface>
  );
}
