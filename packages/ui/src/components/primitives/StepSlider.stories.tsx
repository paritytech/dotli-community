// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { StepSlider, type StepSliderProps } from './StepSlider.js';

const STOPS = [
  { label: 'Low', testId: 'stop-low' },
  { label: 'Mid', testId: 'stop-mid' },
  { label: 'High', testId: 'stop-high' },
  { label: 'Max', testId: 'stop-max' },
];

const meta = {
  title: 'Primitives/StepSlider',
  parameters: { chrome: true },
  component: StepSlider,
  args: { label: 'Level', stops: STOPS, value: 1, onCommit: fn() },
} satisfies Meta<typeof StepSlider>;

export default meta;
type Story = StoryObj<typeof meta>;

// The owner takes each commit, as the permissions panel does once its change is pending.
const Owned = (args: StepSliderProps) => {
  const [value, setValue] = createSignal(untrack(() => args.value));
  return (
    <div style={{ width: '320px' }}>
      <StepSlider
        {...args}
        value={value()}
        onCommit={index => {
          setValue(index);
          args.onCommit(index);
        }}
      />
    </div>
  );
};

function slider(canvas: { getByRole: (role: string) => HTMLElement }): HTMLElement {
  return canvas.getByRole('slider');
}

function pointer(target: HTMLElement, type: string, fraction: number): void {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, { pointerId: 1, button: 0, clientX: rect.left + rect.width * fraction, bubbles: true }),
  );
}

/** As a keyboard user, each step key commits the stop it lands on, End at the end commits nothing and Enter commits again. */
export const Keyboard: Story = {
  render: Owned,
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given the slider is on Mid and focused', async () => {
      await expect(slider(canvas)).toHaveAttribute('aria-valuenow', '1');
      await expect(slider(canvas)).toHaveAttribute('aria-label', 'Level');
      slider(canvas).focus();
    });
    await step('When I press ArrowRight, then End twice', async () => {
      await userEvent.keyboard('{ArrowRight}');
      await userEvent.keyboard('{End}');
      await waitFor(() => expect(slider(canvas)).toHaveAttribute('aria-valuenow', '3'));
      await userEvent.keyboard('{End}');
    });
    await step('Then High and Max were committed, and the second End committed nothing', async () => {
      await expect(args.onCommit).toHaveBeenCalledTimes(2);
      await expect(args.onCommit).toHaveBeenNthCalledWith(1, 2);
      await expect(args.onCommit).toHaveBeenNthCalledWith(2, 3);
    });
    await step('When I press Enter', async () => {
      await userEvent.keyboard('{Enter}');
    });
    await step('Then Max is committed again', async () => {
      await expect(args.onCommit).toHaveBeenCalledTimes(3);
      await expect(args.onCommit).toHaveBeenNthCalledWith(3, 3);
      await expect(slider(canvas)).toHaveAttribute('aria-valuenow', '3');
    });
  },
};

/** As a user, pressing a stop's label commits it, the stop the slider is on included. */
export const LabelPress: Story = {
  render: Owned,
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press Mid, the stop the slider is on, then Low', async () => {
      await expect(canvas.getByTestId('stop-mid')).toHaveAttribute('data-current');
      await userEvent.click(canvas.getByTestId('stop-mid'));
      await userEvent.click(canvas.getByTestId('stop-low'));
    });
    await step('Then both were committed', async () => {
      await expect(args.onCommit).toHaveBeenNthCalledWith(1, 1);
      await expect(args.onCommit).toHaveBeenNthCalledWith(2, 0);
      await expect(canvas.getByTestId('stop-low')).toHaveAttribute('data-current');
    });
  },
};

/** As a pointer user, a drag shows the stop under the pointer and commits only where I release it. */
export const DragCommitsOnRelease: Story = {
  render: Owned,
  play: async ({ args, canvas, step }) => {
    const track = slider(canvas);
    await step('When I press at the start and drag to the end', () => {
      pointer(track, 'pointerdown', 0);
      pointer(track, 'pointermove', 0.5);
      pointer(track, 'pointermove', 1);
    });
    await step('Then the slider shows Max, its label is current and nothing is committed yet', async () => {
      await waitFor(() => expect(track).toHaveAttribute('aria-valuenow', '3'));
      await expect(canvas.getByTestId('stop-max')).toHaveAttribute('data-current');
      await expect(args.onCommit).not.toHaveBeenCalled();
    });
    await step('When I release', () => {
      pointer(track, 'pointerup', 1);
    });
    await step('Then Max alone is committed', async () => {
      await expect(args.onCommit).toHaveBeenCalledTimes(1);
      await expect(args.onCommit).toHaveBeenCalledWith(3);
    });
  },
};

/** As a pointer user releasing on the stop I started from, that stop is committed again. */
export const ReleaseOnSameStop: Story = {
  render: Owned,
  play: async ({ args, canvas, step }) => {
    const track = slider(canvas);
    await step('When I press and release on Mid', () => {
      pointer(track, 'pointerdown', 1 / 3);
      pointer(track, 'pointerup', 1 / 3);
    });
    await step('Then Mid is committed', async () => {
      await expect(args.onCommit).toHaveBeenCalledTimes(1);
      await expect(args.onCommit).toHaveBeenCalledWith(1);
    });
  },
};

/** As a phone user whose drag the browser takes over, nothing is committed and the slider goes back. */
export const PointerCancelCommitsNothing: Story = {
  render: Owned,
  play: async ({ args, canvas, step }) => {
    const track = slider(canvas);
    await step('When I drag to the end and the browser cancels the pointer', () => {
      pointer(track, 'pointerdown', 0.4);
      pointer(track, 'pointermove', 1);
      pointer(track, 'pointercancel', 1);
    });
    await step('Then nothing is committed and the slider is back on Mid', async () => {
      await waitFor(() => expect(track).toHaveAttribute('aria-valuenow', '1'));
      await expect(args.onCommit).not.toHaveBeenCalled();
    });
  },
};

/** As a screen reader user, the slider reads the value text its owner gives each stop. */
export const ValueText: Story = {
  args: { valueText: index => `${STOPS[index]?.label ?? ''}, modified` },
  play: async ({ canvas, step }) => {
    await step('Then the value text names the stop and its note', async () => {
      await expect(slider(canvas)).toHaveAttribute('aria-valuetext', 'Mid, modified');
    });
  },
};

/** As a pointer user, the held thumb follows the pointer between stops while the nearest stop is the one shown. */
export const DragFollowsPointer: Story = {
  render: Owned,
  play: async ({ args, canvas, step }) => {
    const track = slider(canvas);
    const thumb = (): number => canvas.getByTestId('step-slider-thumb').getBoundingClientRect().left;
    await step('When I hold the pointer a third of the way between Mid and High', () => {
      pointer(track, 'pointerdown', 0.4);
      pointer(track, 'pointermove', 0.5 - 1 / 12);
    });
    await step('Then Mid is current while the thumb is off its stop', async () => {
      await waitFor(() => expect(canvas.getByTestId('stop-mid')).toHaveAttribute('data-current'));
      const rect = track.getBoundingClientRect();
      const midThumb = rect.left + 8 + (rect.width - 16) / 3 - 8;
      await waitFor(() => expect(Math.abs(thumb() - midThumb)).toBeGreaterThan(2));
      await expect(thumb()).toBeGreaterThan(midThumb);
    });
    await step('When I release', () => {
      pointer(track, 'pointerup', 0.5 - 1 / 12);
    });
    await step('Then the nearest stop alone is committed', async () => {
      await expect(args.onCommit).toHaveBeenCalledTimes(1);
      await expect(args.onCommit).toHaveBeenCalledWith(1);
    });
  },
};

/** As a screen reader or sighted user, a marked slider says its value is a stop only approximately. */
export const Marked: Story = {
  args: { marked: true },
  play: async ({ canvas, step }) => {
    await step('Then the track carries the marked attribute', async () => {
      await expect(slider(canvas)).toHaveAttribute('data-marked');
    });
  },
};

export const NotMarked: Story = {
  play: async ({ canvas, step }) => {
    await step('Then the track does not carry the marked attribute', async () => {
      await expect(slider(canvas)).not.toHaveAttribute('data-marked');
    });
  },
};
