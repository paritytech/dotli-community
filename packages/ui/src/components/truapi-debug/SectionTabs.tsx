// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { Tabs, type TabOption } from './shared/Tabs.js';
import s from './SectionTabs.module.css';

/** The panel's top-level tabs. Only `truapi` shows the captured events. */
export type PanelSection = 'truapi' | 'resolution' | 'archive' | 'diagnostics' | 'wallet';

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
      testId="td-sections"
      tabTestId="td-section"
      class={s['sections']}
    />
  );
}
