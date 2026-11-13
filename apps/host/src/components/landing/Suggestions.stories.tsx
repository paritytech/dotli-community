// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { Suggestions } from './Suggestions.js';

const LABELS = ['ant', 'apple', 'avocado'];

type FrameProps = {
  active: string | null;
  onPick: (label: string) => void;
};

/** The list below a name input, inside a positioned frame as the page places it. */
function Frame(props: FrameProps): JSX.Element {
  return (
    <div style={{ position: 'relative', width: '480px' }}>
      <input type="text" aria-label="Name" data-testid="story-name-input" />
      <Suggestions labels={() => LABELS} suffix={() => '.dot'} active={() => props.active} onPick={props.onPick} />
    </div>
  );
}

const meta = {
  title: 'Host/Landing/Suggestions',
  component: Frame,
  args: { active: 'apple', onPick: fn() },
  // Its ids are the page's, so each story keeps its own frame.
  tags: ['!autodocs'],
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor, I see three suggested names, and the one the arrow keys point at is selected. */
export const ActiveSelected: Story = {
  play: async ({ canvas, step }) => {
    await step('Then three names show and only apple is selected', async () => {
      await expect(await canvas.findAllByRole('option')).toHaveLength(3);
      const selected = canvas.getAllByRole('option', { selected: true });
      await expect(selected.map(o => o.dataset['label'])).toEqual(['apple']);
    });
  },
};

/** As a visitor typing a name, I click a suggested name and it is picked while the input keeps focus. */
export const ClickPicks: Story = {
  args: { active: null },
  play: async ({ args, canvas, step }) => {
    const input = canvas.getByTestId('story-name-input');
    await step('Given the name input has focus', () => {
      input.focus();
    });
    await step('When I click avocado', async () => {
      const option = (await canvas.findAllByTestId('landing-suggestion')).find(o => o.dataset['label'] === 'avocado');
      if (option === undefined) {
        throw new Error('No avocado option in the suggestions');
      }
      await (await trustedInput()).click(option);
    });
    await step('Then avocado is picked and the input still has focus', async () => {
      await expect(args.onPick).toHaveBeenCalledWith('avocado');
      await expect(input).toHaveFocus();
    });
  },
};
