// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, within } from 'storybook/test';
import { CHAIN_ROLES, type ChainRole } from '@dotli/config';
import type { ChainMark } from './chainHealth.js';
import { pickChainGlyph } from './chainGlyph.js';
import { ChainHealthMark } from './ChainHealthMark.js';

const MARKS: readonly { name: string; mark: ChainMark }[] = [
  { name: 'Healthy', mark: { kind: 'healthy' } },
  { name: 'Short', mark: { kind: 'short', share: 0.7, band: 'plain' } },
  { name: 'Short, amber', mark: { kind: 'short', share: 0.4, band: 'warn' } },
  { name: 'Short, red', mark: { kind: 'short', share: 0.15, band: 'err' } },
  { name: 'Not producing blocks', mark: { kind: 'outage' } },
  { name: 'Connecting', mark: { kind: 'connecting' } },
  { name: 'Unavailable', mark: { kind: 'unavailable' } },
  { name: 'Not in use', mark: { kind: 'unused' } },
];

const GLYPHS: readonly (ChainRole | null)[] = [...CHAIN_ROLES, null];

/** Every mark state as a row, with every chain's glyph in it. */
function Gallery(): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: '12px', padding: '12px', background: 'var(--chrome-glass)' }}>
      <For each={MARKS}>
        {row => (
          <div role="group" aria-label={row.name} style={{ display: 'flex', 'align-items': 'center', gap: '12px' }}>
            <For each={GLYPHS}>{role => <ChainHealthMark mark={row.mark} glyph={pickChainGlyph(role)} />}</For>
            <span style={{ 'font-size': 'var(--fs-caption)' }}>{row.name}</span>
          </div>
        )}
      </For>
    </div>
  );
}

/** One mark that steps through every state, so each change can be watched as it morphs. */
function Stepper(): JSX.Element {
  const [index, setIndex] = createSignal(0);
  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '12px',
        padding: '12px',
        background: 'var(--chrome-glass)',
      }}
    >
      <Show when={MARKS[index() % MARKS.length]}>
        {row => (
          <>
            <ChainHealthMark mark={row().mark} glyph={pickChainGlyph('relay')} />
            <button type="button" onClick={() => setIndex(index() + 1)}>
              Next state
            </button>
            <span style={{ 'font-size': 'var(--fs-caption)' }}>{row().name}</span>
          </>
        )}
      </Show>
    </div>
  );
}

const meta = {
  title: 'Entities/Chains/ChainHealthMark',
  component: Gallery,
  parameters: { chrome: true },
} satisfies Meta<typeof Gallery>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a screen reader user, I skip every chain's mark, and each mark draws the state it is given. */
export const AllStates: Story = {
  play: async ({ canvas, step }) => {
    await step('Then every glyph wears each state, hidden from assistive technology', async () => {
      for (const row of MARKS) {
        const marks = within(canvas.getByRole('group', { name: row.name })).getAllByTestId('chains-mark');
        await expect(marks).toHaveLength(GLYPHS.length);
        for (const mark of marks) {
          await expect(mark).toHaveAttribute('aria-hidden', 'true');
          await expect(mark).toHaveAttribute('data-kind', row.mark.kind);
          if (row.mark.kind === 'short') {
            await expect(mark.querySelector('[data-band]')).toHaveAttribute('data-band', row.mark.band);
          }
        }
      }
    });
  },
};

/** As a user watching a chain, I see one mark move through every state, and it stays the same drawing as it changes. */
export const Morph: Story = {
  render: () => <Stepper />,
  play: async ({ canvas, userEvent, step }) => {
    // Given one mark in the first state, and the layers it draws
    const mark = canvas.getByTestId('chains-mark');
    const layers = [...mark.children];
    for (const row of MARKS.slice(1)) {
      await step(`When the state changes to ${row.name}`, async () => {
        await userEvent.click(canvas.getByRole('button', { name: 'Next state' }));
      });
      await step(`Then the same mark draws ${row.name} with the same layers`, async () => {
        await expect(canvas.getByTestId('chains-mark')).toBe(mark);
        await expect(mark).toHaveAttribute('data-kind', row.mark.kind);
        await expect([...mark.children]).toEqual(layers);
      });
    }
  },
};
