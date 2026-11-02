// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { StepSlider, type StepSliderProps } from './StepSlider.js';

type Params = {
  /** The slider's track. */
  target: HTMLElement;
  /** The pointer event's type, such as `pointerdown`. */
  type: string;
  /** Where the pointer is across the track, 0 at its start and 1 at its end. */
  fraction: number;
};

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

/** As a keyboard user, each step key commits the stop it lands on, End at the end commits nothing and Enter commits again. */
export const Keyboard: Story = {
  render: renderOwned,
  play: async ({ args, canvas, userEvent, mount, step }) => {
    await step('When the slider renders on Mid', async () => {
      await mount();
    });
    await step('Then the slider named Level is on Mid', async () => {
      await expect(getSlider(canvas)).toHaveAttribute('aria-valuenow', '1');
      await expect(getSlider(canvas)).toHaveAttribute('aria-label', 'Level');
    });
    await step('When I focus it and press ArrowRight, then End', async () => {
      getSlider(canvas).focus();
      await userEvent.keyboard('{ArrowRight}');
      await userEvent.keyboard('{End}');
    });
    await step('Then it is on Max', async () => {
      await waitFor(() => expect(getSlider(canvas)).toHaveAttribute('aria-valuenow', '3'));
    });
    await step('When I press End again', async () => {
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
      await expect(getSlider(canvas)).toHaveAttribute('aria-valuenow', '3');
    });
  },
};

/** As a user, pressing a stop's label commits it, the stop the slider is on included. */
export const LabelPress: Story = {
  render: renderOwned,
  play: async ({ args, canvas, userEvent, mount, step }) => {
    await step('When the slider renders on Mid', async () => {
      await mount();
    });
    await step('Then the slider is on Mid', async () => {
      await expect(canvas.getByTestId('stop-mid')).toHaveAttribute('data-current');
    });
    await step('When I press Mid, the stop the slider is on, then Low', async () => {
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
  render: renderOwned,
  play: async ({ args, canvas, step }) => {
    const track = getSlider(canvas);
    await step('When I press at the start and drag to the end', () => {
      dispatchPointer({ target: track, type: 'pointerdown', fraction: 0 });
      dispatchPointer({ target: track, type: 'pointermove', fraction: 0.5 });
      dispatchPointer({ target: track, type: 'pointermove', fraction: 1 });
    });
    await step('Then the slider shows Max, its label is current and nothing is committed yet', async () => {
      await waitFor(() => expect(track).toHaveAttribute('aria-valuenow', '3'));
      await expect(canvas.getByTestId('stop-max')).toHaveAttribute('data-current');
      await expect(args.onCommit).not.toHaveBeenCalled();
    });
    await step('When I release', () => {
      dispatchPointer({ target: track, type: 'pointerup', fraction: 1 });
    });
    await step('Then Max alone is committed', async () => {
      await expect(args.onCommit).toHaveBeenCalledTimes(1);
      await expect(args.onCommit).toHaveBeenCalledWith(3);
    });
  },
};

/** As a pointer user releasing on the stop I started from, that stop is committed again. */
export const ReleaseOnSameStop: Story = {
  render: renderOwned,
  play: async ({ args, canvas, step }) => {
    const track = getSlider(canvas);
    await step('When I press and release on Mid', () => {
      dispatchPointer({ target: track, type: 'pointerdown', fraction: 1 / 3 });
      dispatchPointer({ target: track, type: 'pointerup', fraction: 1 / 3 });
    });
    await step('Then Mid is committed', async () => {
      await expect(args.onCommit).toHaveBeenCalledTimes(1);
      await expect(args.onCommit).toHaveBeenCalledWith(1);
    });
  },
};

/** As a phone user whose drag the browser takes over, nothing is committed and the slider goes back. */
export const PointerCancelCommitsNothing: Story = {
  render: renderOwned,
  play: async ({ args, canvas, step }) => {
    const track = getSlider(canvas);
    await step('When I drag to the end and the browser cancels the pointer', () => {
      dispatchPointer({ target: track, type: 'pointerdown', fraction: 0.4 });
      dispatchPointer({ target: track, type: 'pointermove', fraction: 1 });
      dispatchPointer({ target: track, type: 'pointercancel', fraction: 1 });
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
  play: async ({ canvas, mount, step }) => {
    await step('When the slider renders with value text', async () => {
      await mount();
    });
    await step('Then the value text names the stop and its note', async () => {
      await expect(getSlider(canvas)).toHaveAttribute('aria-valuetext', 'Mid, modified');
    });
  },
};

/** As a pointer user, the held thumb follows the pointer between stops while the nearest stop is the one shown. */
export const DragFollowsPointer: Story = {
  render: renderOwned,
  play: async ({ args, canvas, step }) => {
    const track = getSlider(canvas);
    // The thumb is the last element of the stop layer, the track's last child.
    function readThumbCenter(): number {
      const rect = track.lastElementChild?.lastElementChild?.getBoundingClientRect();
      return rect === undefined ? Number.NaN : rect.left + rect.width / 2;
    }
    const held = 0.5 - 1 / 12;
    let pointerX = 0;
    await step('When I hold the pointer between Mid and High, nearer Mid', () => {
      dispatchPointer({ target: track, type: 'pointerdown', fraction: 0.4 });
      dispatchPointer({ target: track, type: 'pointermove', fraction: held });
      const rect = track.getBoundingClientRect();
      pointerX = rect.left + rect.width * held;
    });
    await step('Then Mid is current while the thumb sits under the pointer', async () => {
      await waitFor(() => expect(canvas.getByTestId('stop-mid')).toHaveAttribute('data-current'));
      await waitFor(() => expect(Math.abs(readThumbCenter() - pointerX)).toBeLessThanOrEqual(1));
    });
    await step('When I release', () => {
      dispatchPointer({ target: track, type: 'pointerup', fraction: 0.5 - 1 / 12 });
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
  play: async ({ canvas, mount, step }) => {
    await step('When a marked slider renders', async () => {
      await mount();
    });
    await step('Then the track carries the marked attribute', async () => {
      await expect(getSlider(canvas)).toHaveAttribute('data-marked');
    });
  },
};

export const NotMarked: Story = {
  play: async ({ canvas, mount, step }) => {
    await step('When an unmarked slider renders', async () => {
      await mount();
    });
    await step('Then the track does not carry the marked attribute', async () => {
      await expect(getSlider(canvas)).not.toHaveAttribute('data-marked');
    });
  },
};

// The owner takes each commit.
function renderOwned(args: StepSliderProps) {
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
}

function getSlider(canvas: { getByRole: (role: string) => HTMLElement }): HTMLElement {
  return canvas.getByRole('slider');
}

function dispatchPointer({ target, type, fraction }: Params): void {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, { pointerId: 1, button: 0, clientX: rect.left + rect.width * fraction, bubbles: true }),
  );
}
