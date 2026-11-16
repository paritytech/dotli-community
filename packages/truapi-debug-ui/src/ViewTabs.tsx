// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ListCounts } from './model/formatListCounts.js';
import { Bar } from './shared/Bar.js';
import { Tabs, type TabOption } from './shared/Tabs.js';
import s from './ViewTabs.module.css';

/** How the TrUAPI tab shows the captured events. */
export type PanelView = 'list' | 'timeline';

export const VIEW_TABS_ID = 'td-view-tab';
export const VIEW_PANEL_ID = 'td-view-panel';

/** Every view, in display order. */
const PANEL_VIEWS: readonly PanelView[] = ['list', 'timeline'];

const VIEW_LABELS: Record<PanelView, string> = {
  list: 'List',
  timeline: 'Timeline',
};

const VIEWS: readonly TabOption<PanelView>[] = PANEL_VIEWS.map(view => ({ value: view, label: VIEW_LABELS[view] }));

/** The view tabs, with the list's counts at the bar's end. */
export function ViewTabs(props: {
  view: PanelView;
  counts: ListCounts;
  hidden: boolean;
  onSelect: (view: PanelView) => void;
}): JSX.Element {
  return (
    <Bar testId="td-view-bar" hidden={props.hidden}>
      <Tabs
        tabs={VIEWS}
        selected={props.view}
        onSelect={props.onSelect}
        variant="secondary"
        label="Event views"
        idPrefix={VIEW_TABS_ID}
        panelId={VIEW_PANEL_ID}
        testId="td-tabs"
        tabTestId="td-tab"
        class={s['tabs']}
      />
      <span class={s['counts']} data-testid="td-counts">
        {props.counts.total}
        <Show when={props.counts.dropped}>
          {dropped => (
            <>
              {' '}
              <span class={s['dropped']}>{dropped()}</span>
            </>
          )}
        </Show>
        <Show when={props.counts.shown}>{shown => ` ${shown()}`}</Show>
      </span>
    </Bar>
  );
}
