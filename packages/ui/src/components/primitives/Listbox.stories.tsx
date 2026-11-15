// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, createUniqueId, For, type Component } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { GlobeIcon } from '../icons/GlobeIcon.js';
import type { IconProps } from '../icons/iconProps.js';
import { SlidersIcon } from '../icons/SlidersIcon.js';
import { Button } from './Button.js';
import { IconButton } from './IconButton.js';
import { Listbox } from './Listbox.js';

type StoryArgs = {
  onPick: (label: string) => void;
};

type OptionsProps = {
  labels: readonly string[];
  active?: string | undefined;
  chosen?: string | undefined;
  detail?: string | undefined;
  icon?: Component<IconProps> | undefined;
  onPick: (label: string) => void;
};

type InputFrameProps = {
  width: string;
  inputLabel: string;
  listId: string;
  listLabel: string;
  loading?: string | undefined;
  onKeyDown?: (event: KeyboardEvent) => void;
  children: JSX.Element;
};

const MANY_OPTIONS = ['app', 'apple', 'apps', 'apricot', 'april', 'apron', 'aptos', 'aptitude', 'apex', 'aphid'];

const meta = {
  title: 'Primitives/Listbox',
  parameters: { chrome: true },
  args: { onPick: fn() },
  // The stories scroll on mount, so one docs page would jump between them.
  tags: ['!autodocs'],
} satisfies Meta<StoryArgs>;

export default meta;
type Story = StoryObj<StoryArgs>;

/** As a dotli user typing a name, I see options below the input, and only the one the arrow keys point at is active. */
export const UnderInput: Story = {
  render: args => (
    <InputFrame
      width="300px"
      inputLabel="Search a .paseo name"
      listId="listbox-under-input"
      listLabel="Suggested names"
    >
      <Options
        labels={[
          'browse',
          'browser-tests',
          'browse-default-relevant-sort00',
          'browse-default-relevant-sort01',
          'browse-default-relevant-sort-by-date',
        ]}
        active="browse-default-relevant-sort00"
        detail=".paseo"
        onPick={args.onPick}
      />
    </InputFrame>
  ),
  play: async ({ canvas, step }) => {
    await step('Then only one option is active', async () => {
      const active = canvas.getByRole('option', { name: 'browse-default-relevant-sort00.paseo' });
      await expect(canvas.getAllByRole('option', { selected: true })).toEqual([active]);
    });
  },
};

/** As a dotli user typing a name, I click an option and it is picked while the input keeps focus. */
export const ClickKeepsFocus: Story = {
  render: args => (
    <InputFrame width="300px" inputLabel="Name" listId="listbox-click" listLabel="Suggested names">
      <Options labels={['ant', 'apple', 'avocado']} detail=".dot" onPick={args.onPick} />
    </InputFrame>
  ),
  play: async ({ args, canvas, step }) => {
    const input = canvas.getByRole('combobox', { name: 'Name' });
    await step('Given the input has focus', () => {
      input.focus();
    });
    await step('When I click avocado', async () => {
      await (await trustedInput()).click(canvas.getByRole('option', { name: 'avocado.dot' }));
    });
    await step('Then avocado is picked and the input still has focus', async () => {
      await expect(args.onPick).toHaveBeenCalledWith('avocado');
      await expect(input).toHaveFocus();
    });
  },
};

/** As a dotli user, I open a list from a button and see the current network checked. */
export const UnderButton: Story = {
  render: args => (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <Button aria-expanded="true" aria-controls="listbox-under-button">
        Polkadot
      </Button>
      <Listbox id="listbox-under-button" label="Network">
        <Options
          labels={['Polkadot', 'Kusama', 'Paseo testnet']}
          active="Kusama"
          chosen="Polkadot"
          icon={GlobeIcon}
          onPick={args.onPick}
        />
      </Listbox>
    </div>
  ),
  play: async ({ canvas, step }) => {
    await step('Then only Polkadot is checked', async () => {
      const chosen = canvas.getByRole('option', { name: 'Polkadot' });
      await expect(canvas.getAllByRole('option', { checked: true })).toEqual([chosen]);
    });
  },
};

/** As a dotli user, I open a list from a button at a row's end and see its chosen option active, with both fills. */
export const AlignEnd: Story = {
  render: args => (
    <div style={{ display: 'flex', 'justify-content': 'flex-end', width: '260px' }}>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <IconButton aria-label="Sort" aria-expanded="true" aria-controls="listbox-align-end">
          <SlidersIcon />
        </IconButton>
        <Listbox id="listbox-align-end" label="Sort" align="end">
          <Options
            labels={['Most relevant', 'Recently opened', 'Name']}
            active="Recently opened"
            chosen="Recently opened"
            onPick={args.onPick}
          />
        </Listbox>
      </div>
    </div>
  ),
};

/** As a dotli user, I see each long option on one line, ending in an ellipsis before its check mark. */
export const LongText: Story = {
  render: args => (
    <InputFrame width="236px" inputLabel="Name" listId="listbox-long-text" listLabel="Long text">
      <Options
        labels={[
          'news',
          'browse-default-relevant-sort00',
          'the-longest-name-dotns-allows-is-sixty-three-characters-long-ok',
          'anunbrokennamewithnohyphensatall',
        ]}
        active="browse-default-relevant-sort00"
        chosen="anunbrokennamewithnohyphensatall"
        detail=".paseo"
        onPick={args.onPick}
      />
    </InputFrame>
  ),
};

/** As a keyboard user, I move past the list's edge with the arrow keys and the active option scrolls into view. */
export const ActiveScrollsIntoView: Story = {
  render: args => <ManyOptionsFrame onPick={args.onPick} />,
  play: async ({ canvas, step }) => {
    const input = canvas.getByRole('combobox', { name: 'Name' });
    const list = canvas.getByRole('listbox', { name: 'Many options' });
    await step('Given the input has focus', () => {
      input.focus();
    });
    await step('When I press ArrowUp', async () => {
      await (await trustedInput()).keyboard('{ArrowUp}');
    });
    await step('Then aphid is inside the list', async () => {
      await waitFor(() => expectInside(canvas.getByRole('option', { name: 'aphid' }), list));
    });
    await step('When I press ArrowDown', async () => {
      await (await trustedInput()).keyboard('{ArrowDown}');
    });
    await step('Then app is inside the list', async () => {
      await waitFor(() => expectInside(canvas.getByRole('option', { name: 'app' }), list));
    });
  },
};

/**
 * As a dotli user typing a name while the names still load, I see a loading row after the matches so far, or alone when
 * none match yet.
 */
export const Loading: Story = {
  render: args => (
    <div style={{ display: 'flex', gap: '72px', 'align-items': 'flex-start' }}>
      <InputFrame
        width="300px"
        inputLabel="Name with matches"
        listId="listbox-loading-matches"
        listLabel="Suggested names"
        loading="Loading names"
      >
        <Options labels={['hosted', 'host-tools']} active="host-tools" detail=".paseo" onPick={args.onPick} />
      </InputFrame>
      <InputFrame
        width="300px"
        inputLabel="Name with no matches"
        listId="listbox-loading-empty"
        listLabel="Suggested names"
        loading="Loading names"
      >
        {null}
      </InputFrame>
    </div>
  ),
  play: async ({ canvas, step }) => {
    await step('Then both lists are busy and each shows a status beside it', async () => {
      for (const list of canvas.getAllByRole('listbox')) {
        await expect(list).toHaveAttribute('aria-busy', 'true');
      }
      await expect(canvas.getAllByRole('status')).toHaveLength(2);
    });
  },
};

/** As a phone user, I see a long option end in an ellipsis inside the list, which stays as wide as the input. */
export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: args => (
    <InputFrame width="256px" inputLabel="Name" listId="listbox-phone" listLabel="Phone">
      <Options
        labels={['browse', 'browse-default-relevant-sort00', 'browse-default-relevant-sort01']}
        active="browse-default-relevant-sort00"
        detail=".paseo"
        onPick={args.onPick}
      />
    </InputFrame>
  ),
};

/** A combobox input with its list below, inside a positioned frame as a page places them. */
function InputFrame(props: InputFrameProps): JSX.Element {
  return (
    <div style={{ position: 'relative', width: props.width }}>
      <input
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={props.listId}
        aria-label={props.inputLabel}
        onKeyDown={event => {
          props.onKeyDown?.(event);
        }}
      />
      <Listbox id={props.listId} label={props.listLabel} loading={props.loading}>
        {props.children}
      </Listbox>
    </div>
  );
}

/** One option per label. */
function Options(props: OptionsProps): JSX.Element {
  const idPrefix = createUniqueId();
  return (
    <For each={props.labels}>
      {(label, index) => (
        <Listbox.Option
          id={`${idPrefix}-${String(index())}`}
          active={label === props.active}
          chosen={label === props.chosen}
          icon={props.icon}
          detail={props.detail}
          onPick={() => {
            props.onPick(label);
          }}
        >
          {label}
        </Listbox.Option>
      )}
    </For>
  );
}

/** Ten options under an input whose arrow keys move the active one, wrapping at both ends. */
function ManyOptionsFrame(props: StoryArgs): JSX.Element {
  const [active, setActive] = createSignal(0);
  return (
    <InputFrame
      width="236px"
      inputLabel="Name"
      listId="listbox-many"
      listLabel="Many options"
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
          return;
        }
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive(index => (index + step + MANY_OPTIONS.length) % MANY_OPTIONS.length);
      }}
    >
      <Options labels={MANY_OPTIONS} active={MANY_OPTIONS[active()]} onPick={props.onPick} />
    </InputFrame>
  );
}

/** Asserts the option sits fully inside the list's visible box. */
async function expectInside(option: Element, list: Element): Promise<void> {
  const inner = option.getBoundingClientRect();
  const outer = list.getBoundingClientRect();
  await expect(inner.top).toBeGreaterThanOrEqual(outer.top);
  await expect(inner.bottom).toBeLessThanOrEqual(outer.bottom);
}
