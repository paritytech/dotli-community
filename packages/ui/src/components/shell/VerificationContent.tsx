// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ShieldState } from '../../verification-shield.js';
import { pillShield, urlPillStore } from '../../state/url-pill.js';
import { Chip } from '../primitives/Chip.js';
import { Choice } from '../primitives/Choice.js';
import { Surface, SurfaceHead } from '../primitives/Surface.js';
import { useStore } from '../use-store.js';
import { usePopover } from './Popover.js';
import { GLYPH_PATHS, TOOLTIP_TITLE } from './verification-glyphs.js';
import s from './VerificationContent.module.css';

const SOURCES: readonly { state: ShieldState; title: string; description: string }[] = [
  {
    state: 'verified',
    title: 'Verified',
    description: 'Checked in your browser by the light client. The more secure option.',
  },
  {
    state: 'trusted',
    title: 'Trusted',
    description: 'Served by an external RPC provider. Faster, but you rely on its answers.',
  },
];

/**
 * The verification explainer's body (VerificationShield), its own chunk: how
 * each way of loading a site reads, as static choices, the pill's current one
 * ringed (`data-selected`) with a "This site" chip.
 */
export function VerificationContent(): JSX.Element {
  const popover = usePopover();
  const state = useStore(urlPillStore, pill => pillShield(pill) ?? null);
  return (
    <Surface width="md" bare sheet={popover.sheet()}>
      <SurfaceHead title={TOOLTIP_TITLE} testId="verification-tooltip-title" />
      <For each={SOURCES}>
        {source => (
          <Choice
            title={source.title}
            description={source.description}
            selected={state() === source.state}
            chip={
              <Show when={state() === source.state}>
                <Chip>This site</Chip>
              </Show>
            }
            icon={
              <svg
                class={[s['icon'], s[source.state]]}
                data-testid="verification-tooltip-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                // @ts-expect-error -- not in Solid's SVG types; kept from the pre-Solid markup
                focusable="false"
              >
                <For each={GLYPH_PATHS[source.state]}>{d => <path d={d} />}</For>
              </svg>
            }
            testId={`verification-tooltip-row-${source.state}`}
          />
        )}
      </For>
    </Surface>
  );
}
