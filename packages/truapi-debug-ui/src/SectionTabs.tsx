// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { PANEL_SECTIONS, type PanelSection } from './model/createSectionStorage.js';
import { Tabs, type TabOption } from './shared/Tabs.js';
import s from './SectionTabs.module.css';

export const SECTION_TABS_ID = 'td-section-tab';
export const SECTION_PANEL_ID = 'td-section-panel';

const SECTION_LABELS: Record<PanelSection, string> = {
  truapi: 'TrUAPI',
  resolution: 'Resolution',
  archive: 'Archive',
  diagnostics: 'Diagnostics',
  wallet: 'Wallet',
};

const SECTIONS: readonly TabOption<PanelSection>[] = PANEL_SECTIONS.map(section => ({
  value: section,
  label: SECTION_LABELS[section],
}));

/** In the header, so they stay in reach while the panel is collapsed. A collapsed panel selects none. */
export function SectionTabs(props: {
  section: PanelSection | null;
  onSelect: (section: PanelSection) => void;
}): JSX.Element {
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
