// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Chip, StepSlider } from '@dotli/ui';
import type { PermissionStatus } from '../../runtime/permissions.js';
import { PRESETS, presetOf, type Preset } from './presets.js';
import s from './PresetPicker.module.css';

const STOPS = PRESETS.map(preset => ({ label: preset.label, testId: `permissions-preset-stop-${preset.id}` }));

export interface PresetPickerProps {
  /** The statuses the panel shows, in menu order. */
  statuses: readonly PermissionStatus[];
  /** A preset was committed, the one shown included. */
  onPick: (preset: Preset) => void;
}

/** The preset slider, the shown preset's name, its Modified badge and its line. */
export function PresetPicker(props: PresetPickerProps): JSX.Element {
  const shown = createMemo(() => presetOf(props.statuses));
  const index = (): number => PRESETS.indexOf(shown().preset);
  const valueText = (at: number): string => {
    const label = PRESETS[at]?.label ?? '';
    return at === index() && shown().modified ? `${label}, modified` : label;
  };
  return (
    <div
      class={s['picker']}
      data-testid="permissions-presets"
      data-preset={shown().preset.id}
      data-modified={shown().modified ? '' : undefined}
    >
      <StepSlider
        label="Permission preset"
        stops={STOPS}
        value={index()}
        valueText={valueText}
        onCommit={at => {
          const preset = PRESETS[at];
          if (preset !== undefined) {
            props.onPick(preset);
          }
        }}
        testId="permissions-preset-slider"
      />
      <div class={s['name']}>
        <span data-testid="permissions-preset-name">{shown().preset.label}</span>
        <Show when={shown().modified}>
          <Chip testId="permissions-preset-modified">Modified</Chip>
        </Show>
      </div>
      <p class={s['line']} data-testid="permissions-preset-line">
        {shown().preset.line}
      </p>
    </div>
  );
}
