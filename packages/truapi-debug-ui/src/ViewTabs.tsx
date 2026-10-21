// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { Bar } from './shared/Bar.js';
import { Tabs, type TabOption } from './shared/Tabs.js';

export const VIEW_TABS_ID = 'td-view-tab';
export const VIEW_PANEL_ID = 'td-view-panel';

/** How the TrUAPI tab shows the captured events. */
export type PanelView = 'list' | 'timeline';

const VIEWS: readonly TabOption<PanelView>[] = [
  { value: 'list', label: 'List' },
  { value: 'timeline', label: 'Timeline' },
];

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
