// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { Button } from '../primitives/Button.js';
import { Popover } from './Popover.js';

const onOpenChange = fn().mockName('onOpenChange');
const onElse = fn().mockName('onElse');
// The surface is portalled into the body, outside the story's canvas.
const body = within(document.body);

const Failing = lazy(() => Promise.reject(new Error('chunk')));

/** Contents for the focus stories, each the case a surface's Tab order must get right in a real browser. */
const CONTENTS = {
  buttons: () => (
    <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
      <Button testId="inside-a">A</Button>
      <Button testId="inside-b">B</Button>
    </div>
  ),
  failing: () => <Failing />,
  // Disabled controls and a link without href take no focus, and Tab reaches only the checked radio of a group.
  radios: () => (
    <div style={{ padding: '12px', display: 'flex', gap: '8px', 'align-items': 'center' }}>
      <Button disabled testId="inside-disabled">
        Off
      </Button>
      <a data-testid="inside-no-href">No link</a>
      <Button testId="inside-a">A</Button>
      <label>
        <input type="radio" name="story-radios" checked data-testid="radio-on" /> On
      </label>
      <label>
        <input type="radio" name="story-radios" data-testid="radio-off" /> Off
      </label>
    </div>
  ),
  // Buttons out of the Tab order around the two stops, as a segmented control's unpressed options are.
  'tab-order': () => (
    <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
      <button type="button" tabindex="-1" data-testid="a-ask">
        Ask
      </button>
      <button type="button" tabindex="0" data-testid="a-allow">
        Allow
      </button>
      <button type="button" tabindex="0" data-testid="b-ask">
        Ask
      </button>
      <button type="button" tabindex="-1" data-testid="b-allow">
        Allow
      </button>
    </div>
  ),
  // Controls CSS hides at both ends, as the sheet close button is on a desktop.
  hidden: () => (
    <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
      <button type="button" style={{ display: 'none' }}>
        Hidden first
      </button>
      <Button testId="inside-a">A</Button>
      <Button testId="inside-b">B</Button>
      <button type="button" style={{ display: 'none' }}>
        Hidden last
      </button>
    </div>
  ),
  text: () => <p style={{ padding: '12px', margin: '0' }}>Nothing to press here.</p>,
  link: () => (
    <p style={{ padding: '12px', margin: '0' }}>
      <a href="#story-link" data-testid="inside-link">
        Read more
      </a>
    </p>
  ),
  'link-first': () => (
    <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
      <a href="#story-link" data-testid="inside-link">
        Read more
      </a>
      <select aria-label="Network" data-testid="inside-select">
        <option>Paseo</option>
      </select>
    </div>
  ),
} satisfies Record<string, () => JSX.Element>;

function Harness(props: { content?: keyof typeof CONTENTS; handOver?: boolean }) {
  const [trigger, setTrigger] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const [held, setHeld] = createSignal(true);
  const content = (): JSX.Element => CONTENTS[props.content ?? 'buttons']();
  return (
    <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
      {/* With `handOver` the popover lets the button go, as AuthButton does when the session drops. */}
      {props.handOver === true ? (
        <Button
          testId="let-go"
          onClick={() => {
            setHeld(false);
          }}
        >
          Let go
        </Button>
      ) : null}
      <Button
        ref={setTrigger}
        testId="trigger"
        onClick={() => {
          if (!held()) {
            onElse();
          }
        }}
      >
        Open
      </Button>
      <Popover
        id="story-popover"
        title="Example"
        trigger={held() ? trigger() : undefined}
        onOpenChange={onOpenChange}
        testId="story-popover-surface"
      >
        {content()}
      </Popover>
    </div>
  );
}

const meta = {
  title: 'Floating/Popover',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  tags: ['!autodocs'],
  beforeEach: () => {
    onOpenChange.mockClear();
    onElse.mockClear();
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

const press = async (testId: string) => {
  await (await trustedInput()).click(body.getByTestId(testId));
};

/** As a dotli user, I press a button to open its anchored dialog with focus on the first control, and Escape closes it. */
export const Open: Story = {
  play: async ({ step }) => {
    await step('Given the button it holds announces the dialog it controls', async () => {
      const trigger = body.getByTestId('trigger');
      await waitFor(() => expect(trigger).toHaveAttribute('popovertarget', 'story-popover'));
      await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(trigger).toHaveAttribute('aria-controls', 'story-popover');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
    await step('When I press the button', () => press('trigger'));
    await step('Then the anchored dialog is open, focus on its first control', async () => {
      const surface = body.getByTestId('story-popover-surface');
      await waitFor(() => expect(surface).toHaveAttribute('data-open'));
      await expect(surface).toHaveAttribute('role', 'dialog');
      await expect(surface).toHaveAccessibleName('Example');
      await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'true');
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
    await step('When I press Escape', async () => {
      await (await trustedInput()).keyboard('{Escape}');
    });
    await step('Then it closed and the button says so', async () => {
      await waitFor(() => expect(body.getByTestId('story-popover-surface')).not.toHaveAttribute('data-open'));
      await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'false');
    });
  },
};

/** As a phone user, I press the button and a bottom sheet opens with focus on its first control, and no anchored layer. */
export const PhoneSheet: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('When I press the button on a phone', () => press('trigger'));
    await step('Then a bottom sheet titled Example opens, and no anchored layer', async () => {
      await waitFor(() => expect(body.getByTestId('popover-sheet-title')).toHaveTextContent('Example'));
      const sheet = document.getElementById('story-popover');
      await expect(sheet).toHaveAttribute('data-open');
      await expect(document.querySelectorAll(':popover-open')).toHaveLength(0);
      await expect(onOpenChange.mock.calls).toEqual([[true]]);
    });
    await step('And focus is on its first control', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
  },
};

/** As a phone user, I close the sheet with its button or Escape and focus returns to the trigger. */
export const PhoneClosesReturnFocus: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    const settled = async (calls: boolean[][]) => {
      await waitFor(() => expect(onOpenChange.mock.calls).toEqual(calls));
      await waitFor(() => expect(document.getElementById('story-popover')).not.toHaveAttribute('data-open'));
      await waitFor(() => expect(body.getByTestId('trigger')).toHaveFocus());
      // The sheet's content leaves once its slide out has played, the last step of the close.
      await waitFor(() => expect(body.queryByTestId('inside-a')).toBeNull(), { timeout: 2000 });
      await expect(body.getByTestId('trigger')).toHaveFocus();
    };
    await step('Given the sheet is open', () => press('trigger'));
    await step('When I press its close button', () => press('popover-sheet-close'));
    await step('Then it closed once and the trigger has focus', () => settled([[true], [false]]));
    await step('Given the sheet is open again', () => press('trigger'));
    await step('When I press Escape', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
      await (await trustedInput()).keyboard('{Escape}');
    });
    await step('Then it closed once more and the trigger has focus', () => settled([[true], [false], [true], [false]]));
  },
};

/** As a dotli user, I press a button the popover let go and its own click runs and nothing opens. */
export const ReleasedTriggerOpensNothing: Story = {
  args: { handOver: true },
  play: async ({ step }) => {
    const trigger = () => body.getByTestId('trigger');
    await step('Given the popover holds the button as its trigger', async () => {
      await waitFor(() => expect(trigger()).toHaveAttribute('popovertarget', 'story-popover'));
    });
    await step('When the popover lets it go', async () => {
      await press('let-go');
      await waitFor(() => expect(trigger()).not.toHaveAttribute('popovertarget'));
    });
    await step('And I press the button', () => press('trigger'));
    await step('Then its own click ran and nothing opened', async () => {
      await expect(onElse).toHaveBeenCalledOnce();
      await expect(onOpenChange).not.toHaveBeenCalled();
      await expect(document.getElementById('story-popover')?.hasAttribute('data-open') ?? false).toBe(false);
    });
    await step('And the button lost the invoker, and kept its ARIA', async () => {
      await expect(trigger()).not.toHaveAttribute('popovertarget');
      await expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(trigger()).toHaveAttribute('aria-controls', 'story-popover');
      await expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    });
  },
};

/** As a dotli user, I open a popover whose content cannot load and it closes again, including when I reopen it at once. */
export const LazyContentFails: Story = {
  args: { content: 'failing' },
  play: async ({ step }) => {
    await step('When I open the popover whose content cannot load', () => press('trigger'));
    await step('Then it opened, and closed again', async () => {
      await waitFor(() => expect(onOpenChange.mock.calls).toEqual([[true], [false]]));
      await waitFor(() => expect(document.getElementById('story-popover')).not.toHaveAttribute('data-open'));
      await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'false');
    });
    await step('When I open it again at once, while the failed content is still fading out', () => press('trigger'));
    await step('Then the content loaded afresh, failed again and closed again', async () => {
      await waitFor(() => expect(onOpenChange.mock.calls).toEqual([[true], [false], [true], [false]]));
      await waitFor(() => expect(document.getElementById('story-popover')).not.toHaveAttribute('data-open'));
    });
  },
};

const surfaceOpen = async () => {
  await press('trigger');
  await waitFor(() => expect(body.getByTestId('story-popover-surface')).toHaveAttribute('data-open'));
};
const tab = async (shift = false) => {
  await (await trustedInput()).keyboard(shift ? '{Shift>}{Tab}{/Shift}' : '{Tab}');
};

/** As a keyboard user, I open a popover that starts with a link and focus lands on the first control, past the link. */
export const FirstControlTakesFocus: Story = {
  args: { content: 'link-first' },
  play: async ({ step }) => {
    await step('When I open a popover that starts with a link', surfaceOpen);
    await step('Then focus is on its first control, past the link', async () => {
      await waitFor(() => expect(body.getByTestId('inside-select')).toHaveFocus());
    });
  },
};

/** As a keyboard user, I tab through a popover and focus skips disabled controls and unchecked radios and wraps at both ends. */
export const TabSkipsUncheckedRadiosAndDisabled: Story = {
  args: { content: 'radios' },
  play: async ({ step }) => {
    await step('When I open the popover', surfaceOpen);
    await step('Then focus skipped the disabled button and the link without href', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
    await step('When I press Shift+Tab on the first stop', () => tab(true));
    await step('Then focus wrapped to the checked radio, the last stop', async () => {
      await expect(body.getByTestId('radio-on')).toHaveFocus();
    });
    await step('When I press Tab on it', () => tab());
    await step('Then focus wrapped to the first stop, past the unchecked radio', async () => {
      await expect(body.getByTestId('inside-a')).toHaveFocus();
    });
  },
};

/** As a keyboard user, I tab from a control out of the tab order and focus wraps to the right end of the popover. */
export const TabWrapsPastControlsOutOfTabOrder: Story = {
  args: { content: 'tab-order' },
  play: async ({ step }) => {
    await step('When I open the popover', surfaceOpen);
    await step('Then focus is on the first stop', async () => {
      await waitFor(() => expect(body.getByTestId('a-allow')).toHaveFocus());
    });
    await step('When I press Tab between the stops, then the browser moves on inside', async () => {
      await tab();
      await expect(body.getByTestId('b-ask')).toHaveFocus();
    });
    await step('When I press Tab on the last stop, then focus wraps to the first', async () => {
      await tab();
      await expect(body.getByTestId('a-allow')).toHaveFocus();
    });
    await step(
      'When I press Tab on a control out of the Tab order past the last stop, then focus wraps to the first',
      async () => {
        body.getByTestId('b-allow').focus();
        await tab();
        await expect(body.getByTestId('a-allow')).toHaveFocus();
      },
    );
    await step('When I press Shift+Tab on one before the first stop, then focus wraps to the last', async () => {
      body.getByTestId('a-ask').focus();
      await tab(true);
      await expect(body.getByTestId('b-ask')).toHaveFocus();
    });
  },
};

/** As a keyboard user, I tab through a popover and focus wraps between its visible controls only. */
export const TabWrapsPastHiddenControls: Story = {
  args: { content: 'hidden' },
  play: async ({ step }) => {
    await step('When I open the popover', surfaceOpen);
    await step('Then focus is on the first visible control', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
    await step('When I press Shift+Tab, then focus wraps to the last visible control', async () => {
      await tab(true);
      await expect(body.getByTestId('inside-b')).toHaveFocus();
    });
    await step('When I press Tab, then focus wraps to the first visible control', async () => {
      await tab();
      await expect(body.getByTestId('inside-a')).toHaveFocus();
    });
  },
};

/** As a keyboard user, I open a popover with nothing to press and focus stays on its surface. */
export const EmptySurfaceKeepsFocus: Story = {
  args: { content: 'text' },
  play: async ({ step }) => {
    await step('When I open a popover with nothing to press', surfaceOpen);
    await step('Then the surface itself has focus', async () => {
      await waitFor(() => expect(body.getByTestId('story-popover-surface')).toHaveFocus());
    });
    await step('When I press Tab, then focus stays on the surface', async () => {
      await tab();
      await expect(body.getByTestId('story-popover-surface')).toHaveFocus();
    });
  },
};

/** As a keyboard user, I open a popover whose only control is a link and the surface has focus, not the link. */
export const LinksOnlySurfaceFocusesItself: Story = {
  args: { content: 'link' },
  play: async ({ step }) => {
    await step('When I open a popover whose only control is a link', surfaceOpen);
    await step('Then the surface has focus, not the link', async () => {
      await waitFor(() => expect(body.getByTestId('story-popover-surface')).toHaveFocus());
      await expect(body.getByTestId('inside-link')).not.toHaveFocus();
    });
  },
};

type Held = 'a' | 'b' | undefined;
// Which button the popover holds, set by the play as a session drop or a re-render would.
const [held, setHeld] = createSignal<Held>('a');

/** Buttons A and B, and a popover triggered by whichever one `held` names. */
function HeldHarness() {
  const [a, setA] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const [b, setB] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const trigger = (): HTMLButtonElement | undefined => {
    const which = held();
    return which === 'a' ? a() : which === 'b' ? b() : undefined;
  };
  return (
    <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
      <Button ref={setA} testId="held-a">
        A
      </Button>
      <Button ref={setB} testId="held-b">
        B
      </Button>
      <Popover id="story-held" title="Held" trigger={trigger()} onOpenChange={onOpenChange} testId="held-surface">
        <div style={{ padding: '12px' }}>
          <Button testId="held-inside">Inside</Button>
        </div>
      </Popover>
    </div>
  );
}

const heldOpen = (): boolean => document.getElementById('story-held')?.hasAttribute('data-open') === true;

/** As a dotli user, I press a button the popover took back and it opens once. */
export const TriggerHandedBackOpensOnce: Story = {
  render: () => <HeldHarness />,
  beforeEach: () => {
    setHeld('a');
  },
  play: async ({ step }) => {
    await step('Given the popover holds A, and B announces nothing', async () => {
      await waitFor(() => expect(body.getByTestId('held-a')).toHaveAttribute('popovertarget', 'story-held'));
      const other = body.getByTestId('held-b');
      await expect(other).not.toHaveAttribute('popovertarget');
      await expect(other).not.toHaveAttribute('aria-haspopup');
      await expect(other).not.toHaveAttribute('aria-expanded');
      await expect(other).not.toHaveAttribute('aria-controls');
    });
    await step('When it hands A to B and back', async () => {
      setHeld('b');
      await waitFor(() => expect(body.getByTestId('held-b')).toHaveAttribute('popovertarget', 'story-held'));
      setHeld('a');
      await waitFor(() => expect(body.getByTestId('held-a')).toHaveAttribute('popovertarget', 'story-held'));
      await expect(body.getByTestId('held-b')).not.toHaveAttribute('popovertarget');
    });
    await step('And I press A once', () => press('held-a'));
    await step('Then it opened once', async () => {
      await waitFor(() => expect(heldOpen()).toBe(true));
      await expect(onOpenChange.mock.calls).toEqual([[true]]);
    });
  },
};

/** As a dotli user, I lose a popover's button while it is open and it closes once with focus returning to the button. */
export const TriggerReleasedWhileOpenReturnsFocus: Story = {
  render: () => <HeldHarness />,
  beforeEach: () => {
    setHeld('a');
  },
  play: async ({ step }) => {
    await step('Given the popover is open with focus inside', async () => {
      await press('held-a');
      await waitFor(() => expect(body.getByTestId('held-inside')).toHaveFocus());
    });
    await step('When the popover lets its button go, as a session drop does', () => {
      setHeld(undefined);
    });
    await step('Then it closed once and focus went back to the button', async () => {
      await waitFor(() => expect(heldOpen()).toBe(false));
      await expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
      await waitFor(() => expect(body.getByTestId('held-a')).toHaveFocus());
    });
  },
};

/** As a dotli user, I lose a popover's button while focus is on the body and it closes and leaves focus alone. */
export const TriggerReleasedFocusElsewhereClosesOnly: Story = {
  render: () => <HeldHarness />,
  beforeEach: () => {
    setHeld('a');
  },
  play: async ({ step }) => {
    await step('Given the popover is open and focus dropped to the body, as Safari leaves it', async () => {
      await press('held-a');
      await waitFor(() => expect(body.getByTestId('held-inside')).toHaveFocus());
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await step('When the popover lets its button go', () => {
      setHeld(undefined);
    });
    await step('Then it closed and left focus alone', async () => {
      await waitFor(() => expect(heldOpen()).toBe(false));
      await waitFor(() => expect(body.queryByTestId('held-inside')).toBeNull(), { timeout: 2000 });
      await expect(document.activeElement).toBe(document.body);
    });
  },
};
