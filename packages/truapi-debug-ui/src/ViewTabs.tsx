// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { Bar } from './shared/Bar.js';
import { Tabs, type TabOption } from './shared/Tabs.js';

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

export function ViewTabs(props: {
  view: PanelView;
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
      />
    </Bar>
  );
}
