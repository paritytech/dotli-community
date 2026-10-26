// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { SegmentedControl, type SegmentOption } from '@dotli/ui';
import { MonitorIcon, MoonIcon, SunIcon } from '@dotli/ui/icons';
import type { ThemePref } from '../../runtime/state/theme.js';

export type AppearanceProps = {
  theme: Accessor<ThemePref>;
  /** An option was picked. It applies at once, outside the settings draft. */
  onTheme: (theme: ThemePref) => void;
};

/** The product's theme as three large segments. `<html data-theme>` belongs to the page, never this component. */
export function AppearancePicker(props: AppearanceProps): JSX.Element {
  // The glyphs are made per picker, since one node would move between pickers.
  const options: readonly SegmentOption<ThemePref>[] = [
    { value: 'light', label: 'Light', icon: <SunIcon />, testId: 'theme-option-light' },
    { value: 'dark', label: 'Dark', icon: <MoonIcon />, testId: 'theme-option-dark' },
    { value: 'system', label: 'System', icon: <MonitorIcon />, testId: 'theme-option-system' },
  ];
  return (
    <SegmentedControl
      label="Theme"
      options={options}
      value={props.theme()}
      onChange={props.onTheme}
      size="lg"
      block
      testId="theme-options"
    />
  );
}
