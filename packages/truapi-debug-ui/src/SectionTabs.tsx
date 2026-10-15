// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { PanelSection } from './model/section-storage.js';
import { Tabs, type TabOption } from './shared/Tabs.js';
import s from './SectionTabs.module.css';

export const SECTION_TABS_ID = 'td-section-tab';
export const SECTION_PANEL_ID = 'td-section-panel';

const SECTIONS: readonly TabOption<PanelSection>[] = [
  { value: 'truapi', label: 'TrUAPI' },
  { value: 'resolution', label: 'Resolution' },
  { value: 'archive', label: 'Archive' },
  { value: 'diagnostics', label: 'Diagnostics' },
  { value: 'wallet', label: 'Wallet' },
];

/** In the header, so they stay in reach while the panel is collapsed. */
export function SectionTabs(props: { section: PanelSection; onSelect: (section: PanelSection) => void }): JSX.Element {
  return (
    <Tabs
      tabs={SECTIONS}
      selected={props.section}
      onSelect={props.onSelect}
      variant="primary"
      label="Panel sections"
      idPrefix={SECTION_TABS_ID}
      panelId={SECTION_PANEL_ID}
      testId="td-sections"
      tabTestId="td-section"
      class={s['sections']}
    />
  );
}
