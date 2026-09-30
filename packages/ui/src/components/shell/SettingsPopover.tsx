// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Show, untrack } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { BACKEND_LABELS, type Backend, NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';

import { applyAndReset, type ModeDraft } from '../../settings-actions.js';
import { settingsStore, type SettingsState } from '../../state/settings.js';
import { topbarStore } from '../../state/topbar.js';
import { useStore } from '../use-store.js';
import { Diagnostics } from './Diagnostics.js';
import { createPopover } from './popover.js';
import { CacheToggle, RadioRow, SectionHeader } from './SettingsRows.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';

const SETTINGS_ICON_PATH =
  'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z';

/**
 * Where the popover becomes a full-screen sheet: the breakpoint of
 * `.mode-popover` in styles/topbar.css.
 */
const SHEET_QUERY = '(max-width: 560px)';

const CHAIN_CHOICES: [Backend, string][] = [
  ['smoldot-direct', 'Verified in your browser, separate per tab (recommended)'],
  ['smoldot-shared-worker', 'Verified in your browser, shared across tabs'],
  ['rpc-gateway', 'Fetched from trusted servers, fastest but less private'],
];

/**
 * The mobile-only sheet header. On phones the popover becomes a full-screen
 * sheet (CSS), which has no tappable backdrop to dismiss it, so it needs an
 * explicit title and close control. Hidden on desktop, where the backdrop
 * still handles dismissal. It sits outside the panel so the sheet can be
 * closed even while the settings are not seeded yet.
 */
function SheetHeader(props: { close: () => void }): JSX.Element {
  return (
    <div class="mode-popover-sheet-header">
      <span class="mode-popover-sheet-title">Settings</span>
      <button
        onClick={() => {
          props.close();
        }}
        class="mode-popover-sheet-close"
        aria-label="Close settings"
      >
        ✕
      </button>
    </div>
  );
}

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
          Apply and the footer span both columns at the bottom. Collapses to
          a single column on narrow viewports (CSS). */}
      <div class="mode-popover-columns">
        <div class="mode-popover-col">
          {networks.length > 1 && (
            <>
              <SectionHeader text="Network" />
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
          <SectionHeader
            text="Network Transport"
            modifier={networks.length > 1 ? 'mode-popover-section--spaced' : undefined}
          />
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
          <SectionHeader text="Cache" modifier="mode-popover-section--bottom" />
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
          <div class="mode-cache-row mode-clear-all-row">
            <button
              onClick={clearAll}
              class="mode-clear-btn"
              title="Wipe every cache, database, and worker across all origins. The app will reload from a clean baseline."
              disabled={clearing()}
            >
              {clearing() ? 'Clearing…' : 'Clear all caches'}
            </button>
          </div>
        </div>
        <div class="mode-popover-col">
          <SectionHeader text="Diagnostics" />
          <Diagnostics backend={persisted.chain} />
        </div>
      </div>
      {/* The footer wraps the divider, Save & Apply, and the warning as one
          unit so it can pin to the bottom of the full-screen sheet on mobile
          (CSS), keeping the primary action reachable. */}
      <div class="mode-apply-footer">
        <div class="mode-popover-divider" />
        <div class="mode-cache-row mode-apply-row">
          <button
            onClick={apply}
            class={`mode-clear-btn${dirty() ? ' mode-apply-dirty' : ''}`}
            disabled={!dirty() || applying()}
          >
            {applying() ? 'Resetting…' : 'Save & Apply'}
          </button>
        </div>
        {/* Applying reloads the app. Backend and network changes keep
            caches warm; only caches the user turns off get cleared. Shown
            only while the draft is dirty so the idle popover isn't noisy. */}
        <p class={`mode-apply-warning${dirty() ? ' visible' : ''}`}>
          Applying reloads the app. Caches you turn off are cleared.
        </p>
      </div>
    </>
  );
}

/** The settings gear, on the button and the More menu row. */
function GearIcon(props: { size: number }): JSX.Element {
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d={SETTINGS_ICON_PATH} />
    </svg>
  );
}

/**
 * The settings button (`#mode-button`), its popover (`#mode-popover`) and
 * the popover's backdrop, both rendered into the body, an item of the
 * topbar's action group island (see src/islands/), rendered with the host
 * page and hydrated.
 *
 * The popover shows the saved settings: the network and transport choices,
 * the cache switches, "Clear all caches" and the diagnostics. Changes stay a
 * draft until Save & Apply, which saves them and reloads
 * (settings-actions.ts). The button carries `.gateway-mode` while the
 * session is not verified (trusted providers).
 *
 * The saved settings come only from settingsStore, which the host seeds at
 * boot, possibly after this island mounted: until then the button shows no
 * mark and the popover only its sheet header, and an opening under way when
 * the store is seeded fills in then. The island never reads @dotli/config
 * itself, because reading can rewrite a setting (getBackend drops a shared
 * worker choice the browser cannot run), and the boot's URL settings step
 * must see the saved value first.
 *
 * On a wide screen it is a non-modal popover (createPopover's `popover`
 * mode): Tab loops inside it, and a press outside (the backdrop included),
 * focus moved out, Escape and a blocking modal close it. On a narrow screen, where CSS makes it a
 * full-screen sheet, it is a modal dialog (`dialog` mode, `aria-modal`):
 * Tab stays inside, the page does not scroll, and Escape, the sheet's close
 * button and a blocking modal close it. The width is read at each opening,
 * against the stylesheet's breakpoint. Unless the user moved focus
 * elsewhere, closing hands it back to the button or, while the topbar has
 * collapsed it, to the More button.
 * The popover's content stays after a close, for the fade-out, and is
 * rendered afresh on the next opening. The More menu's Settings row opens
 * it while the topbar has collapsed the button.
 */
export function SettingsPopover(): JSX.Element {
  let button: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  /** Whether the current (or last) opening is the modal sheet. */
  const [sheet, setSheet] = createSignal(false);
  const surface = createPopover({
    // Asked as it opens, after the click below set `sheet`.
    mode: () => (untrack(sheet) ? 'dialog' : 'popover'),
    trigger: () => button,
    surface: () => popover,
  });
  /** Counts the openings: each renders the content afresh. */
  const [opening, setOpening] = createSignal(0);
  const settings = useStore(settingsStore);

  const close = (): void => {
    surface.setOpen(false);
  };
  const onButtonClick = (): void => {
    if (!untrack(surface.open)) {
      setOpening(n => n + 1);
      setSheet(window.matchMedia(SHEET_QUERY).matches);
    }
    surface.toggle();
  };
  // openSettings(): each request opens the panel, as a click on a closed
  // button would.
  createEffect(
    useStore(topbarStore, state => state.settingsRequests),
    (requests, previous) => {
      if (previous !== undefined && requests > previous && !untrack(surface.open)) {
        onButtonClick();
      }
    },
  );

  return (
    <>
      <TopbarItem
        name="settings"
        label="Settings"
        icon={() => <GearIcon size={14} />}
        priority={TOPBAR_PRIORITY.settings}
        activate={onButtonClick}
      >
        <button
          ref={el => {
            button = el;
          }}
          onClick={onButtonClick}
          id="mode-button"
          class={settings()?.verified === false ? 'topbar-btn gateway-mode' : 'topbar-btn'}
          title="Settings"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={surface.open() ? 'true' : 'false'}
          aria-controls="mode-popover"
        >
          <GearIcon size={12} />
        </button>
      </TopbarItem>
      <Portal>
        {/* Blocks clicks under the popover and dismisses it when clicked. */}
        <div
          onClick={close}
          class={`mode-popover-backdrop${surface.open() ? ' open' : ''}`}
          id="mode-popover-backdrop"
        />
        <div
          ref={el => {
            popover = el;
          }}
          class={`mode-popover${surface.open() ? ' open' : ''}`}
          id="mode-popover"
          role="dialog"
          aria-label="Settings"
          aria-modal={surface.open() && sheet() ? 'true' : undefined}
          tabindex="-1"
        >
          <div class="mode-popover-content" id="mode-popover-content">
            {/* Rendered from the first opening on, settings or not, so the
                sheet always has its close button. */}
            <Show when={opening() > 0}>
              <SheetHeader close={close} />
            </Show>
            {/* Keyed on the opening, and taking it as a parameter (Show calls
                only a child that declares one), so each opening mounts a
                fresh panel. Until the store is seeded the key is 0, which
                renders nothing; the seeding then mounts the panel of an
                opening already under way. */}
            <Show when={settings() === null ? 0 : opening()} keyed>
              {(_opening: number) => {
                const saved = untrack(settings);
                return saved === null ? null : <SettingsPanel saved={saved} />;
              }}
            </Show>
          </div>
        </div>
      </Portal>
    </>
  );
}
