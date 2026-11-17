// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { AlertTriangleIcon } from '@dotli/ui/icons';
import { Chip, Spinner, StepSlider } from '@dotli/ui';
import type { PermissionStatus } from '../policy/permissionPolicy.js';
import { PRESETS, presetOf, TRUSTED, type Preset } from './presets.js';
import s from './PresetPicker.module.css';

const STOPS = PRESETS.map(preset => ({ label: preset.label, testId: `permissions-preset-stop-${preset.id}` }));

export type PresetPickerProps = {
  /** The statuses the panel shows, in menu order. */
  statuses: readonly PermissionStatus[];
  /** A change made in the panel is pending. */
  pending: boolean;
  /** A preset was committed, the one shown included. */
  onPick: (preset: Preset) => void;
};

/** The shown preset's name, its Modified badge, a pending spinner and its line, above the preset slider. */
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
      // The spinner is hidden from assistive tech, so the picker says it is busy while a change is pending.
      aria-busy={props.pending ? 'true' : undefined}
    >
      <div class={s['readout']}>
        <div class={s['name']}>
          <span class={s['title']} data-testid="permissions-preset-name">
            {shown().preset.label}
          </span>
          <Show when={shown().modified}>
            <Chip testId="permissions-preset-modified">Modified</Chip>
          </Show>
          <Show when={props.pending}>
            <Spinner class={s['spinner']} testId="permissions-preset-pending" />
          </Show>
        </div>
        <p class={s['line']} data-testid="permissions-preset-line">
          {/* Trusted grants without asking, so its line carries a warning. */}
          <Show when={shown().preset === TRUSTED}>
            <AlertTriangleIcon class={s['warn']} testId="permissions-preset-warn" />
          </Show>
          {shown().preset.line}
        </p>
      </div>
      <StepSlider
        label="Permission preset"
        stops={STOPS}
        value={index()}
        valueText={valueText}
        marked={shown().modified}
        onCommit={at => {
          const preset = PRESETS[at];
          if (preset !== undefined) {
            props.onPick(preset);
          }
        }}
        testId="permissions-preset-slider"
      />
    </div>
  );
}
