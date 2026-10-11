// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { PanelSection } from '@dotli/truapi-debug';
import { Tabs, type TabOption } from './shared/Tabs.js';
import s from './SectionTabs.module.css';

const CORE_SECTIONS: readonly TabOption<PanelSection>[] = [
  { value: 'truapi', label: 'TrUAPI' },
  { value: 'resolution', label: 'Resolution' },
  { value: 'archive', label: 'Archive' },
  { value: 'diagnostics', label: 'Diagnostics' },
];
const SECTIONS: readonly TabOption<PanelSection>[] = [...CORE_SECTIONS, { value: 'wallet', label: 'Wallet' }];

/** In the header, so they stay in reach while the panel is collapsed. */
export function SectionTabs(props: {
  section: PanelSection;
  localWalletEnabled: boolean;
  onSelect: (section: PanelSection) => void;
}): JSX.Element {
  return (
    <Tabs
      tabs={props.localWalletEnabled ? SECTIONS : CORE_SECTIONS}
      selected={props.section}
      onSelect={props.onSelect}
      variant="primary"
      testId="td-sections"
      tabTestId="td-section"
      class={s['sections']}
    />
  );
}
