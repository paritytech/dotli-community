// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable no-restricted-properties -- Predates the story contract: its plays still assert copy. */

import { createSignal, createUniqueId, For, type Component } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { ChevronRightIcon } from '../icons/ChevronRightIcon.js';
import { ClockIcon } from '../icons/ClockIcon.js';
import { GlobeIcon } from '../icons/GlobeIcon.js';
import type { IconProps } from '../icons/iconProps.js';
import { SlidersIcon } from '../icons/SlidersIcon.js';
import { Button } from './Button.js';
import { Chip } from './Chip.js';
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
  end?: ((label: string) => JSX.Element) | undefined;
  onRemove?: ((label: string) => void) | undefined;
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

type OpenListProps = {
  listId: string;
  listLabel: string;
  align?: 'start' | 'end' | undefined;
  loading?: string | undefined;
  /** Renders the control the list drops below, handing its element to `ref`. */
  anchor: (ref: (element: HTMLElement) => void) => JSX.Element;
  children: JSX.Element;
};

/** The lists render in the top layer, outside the story's canvas. */
const body = within(document.body);

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
    await step('Then the list sits below the input', async () => {
      const input = canvas.getByRole('combobox', { name: 'Search a .paseo name' });
      const layer = getLayer(body.getByRole('listbox', { name: 'Suggested names' }));
      await waitFor(async () => {
        await expect(layer).toHaveAttribute('data-side', 'bottom');
        await expect(layer.getBoundingClientRect().top).toBeGreaterThanOrEqual(input.getBoundingClientRect().bottom);
      });
    });
    await step('Then only one option is active', async () => {
      const active = body.getByRole('option', { name: 'browse-default-relevant-sort00.paseo' });
      await expect(body.getAllByRole('option', { selected: true })).toEqual([active]);
    });
  },
};

/** As a dotli user typing a name in an input near the screen's bottom, I see the list open above it and fit on screen. */
export const AboveInputNearBottom: Story = {
  render: args => (
    <div style={{ position: 'fixed', left: '16px', bottom: '40px' }}>
      <InputFrame width="236px" inputLabel="Name" listId="listbox-near-bottom" listLabel="Many options">
        <Options labels={MANY_OPTIONS} onPick={args.onPick} />
      </InputFrame>
    </div>
  ),
  play: async ({ canvas, step }) => {
    const input = canvas.getByRole('combobox', { name: 'Name' });
    const layer = getLayer(body.getByRole('listbox', { name: 'Many options' }));
    await step('Given the list has taken its side and ended its entry', async () => {
      await waitFor(() => expect(layer).toHaveAttribute('data-side'));
      await Promise.all(layer.getAnimations().map(animation => animation.finished));
    });
    await step('Then the list sits above the input, inside the visible area', async () => {
      const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
      await waitFor(async () => {
        const box = layer.getBoundingClientRect();
        await expect(layer).toHaveAttribute('data-side', 'top');
        await expect(box.bottom).toBeLessThanOrEqual(input.getBoundingClientRect().top);
        await expect(box.top).toBeGreaterThanOrEqual(0);
        await expect(box.bottom).toBeLessThanOrEqual(visibleHeight);
      });
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
      await (await trustedInput()).click(body.getByRole('option', { name: 'avocado.dot' }));
    });
    await step('Then avocado is picked and the input still has focus', async () => {
      await expect(args.onPick).toHaveBeenCalledWith('avocado');
      await expect(input).toHaveFocus();
    });
  },
};

/** As a dotli user typing a name, I press in the input and the list stays open. */
export const PressInInputKeepsOpen: Story = {
  render: args => (
    <InputFrame width="300px" inputLabel="Name" listId="listbox-press-input" listLabel="Suggested names">
      <Options labels={['ant', 'apple']} detail=".dot" onPick={args.onPick} />
    </InputFrame>
  ),
  play: async ({ canvas, step }) => {
    const input = canvas.getByRole('combobox', { name: 'Name' });
    await step('Given the input has focus', () => {
      input.focus();
    });
    await step('When I press in the input', async () => {
      await (await trustedInput()).click(input);
    });
    await step('Then the list is still open', async () => {
      const list = body.getByRole('listbox', { name: 'Suggested names' });
      await expect(list.closest('[data-open]')).not.toBeNull();
    });
  },
};

/** As a dotli user, I open a list from a button and see the current network checked. */
export const UnderButton: Story = {
  render: args => (
    <OpenList
      listId="listbox-under-button"
      listLabel="Network"
      anchor={ref => (
        <Button ref={ref} aria-expanded="true" aria-controls="listbox-under-button">
          Polkadot
        </Button>
      )}
    >
      <Options
        labels={['Polkadot', 'Kusama', 'Paseo testnet']}
        active="Kusama"
        chosen="Polkadot"
        icon={GlobeIcon}
        onPick={args.onPick}
      />
    </OpenList>
  ),
  play: async ({ step }) => {
    await step('Then only Polkadot is checked', async () => {
      const chosen = body.getByRole('option', { name: 'Polkadot' });
      await expect(body.getAllByRole('option', { checked: true })).toEqual([chosen]);
    });
  },
};

/** As a dotli user, I open a list from a button at a row's end and see its chosen option active, with both fills. */
export const AlignEnd: Story = {
  render: args => (
    <div style={{ display: 'flex', 'justify-content': 'flex-end', width: '260px' }}>
      <OpenList
        listId="listbox-align-end"
        listLabel="Sort"
        align="end"
        anchor={ref => (
          <IconButton ref={ref} aria-label="Sort" aria-expanded="true" aria-controls="listbox-align-end">
            <SlidersIcon />
          </IconButton>
        )}
      >
        <Options
          labels={['Most relevant', 'Recently opened', 'Name']}
          active="Recently opened"
          chosen="Recently opened"
          onPick={args.onPick}
        />
      </OpenList>
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

/** As a dotli user, I see each option end in its status and a chevron, after its text. */
export const EndSlot: Story = {
  render: args => (
    <InputFrame width="300px" inputLabel="Actions" listId="listbox-end-slot" listLabel="More actions">
      <Options
        labels={['Chat', 'Offline', 'a-label-long-enough-that-it-must-ellipsize-before-the-slot']}
        icon={GlobeIcon}
        end={label => (
          <>
            {label === 'Chat' ? <Chip>3</Chip> : <span>{label === 'Offline' ? 'Offline' : 'Soon'}</span>}
            <ChevronRightIcon />
          </>
        )}
        onPick={args.onPick}
      />
    </InputFrame>
  ),
  play: async () => {
    const list = await body.findByRole('listbox', { name: 'More actions' });
    const option = within(list).getByRole('option', { name: /^Chat/ });
    const end = within(option).getByTestId('listbox-end');
    const text = within(option).getByText('Chat');
    await expect(end).toHaveTextContent('3');
    await expect(text.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  },
};

/** As a keyboard user, I move past the list's edge with the arrow keys and the active option scrolls into view. */
export const ActiveScrollsIntoView: Story = {
  render: args => <ManyOptionsFrame onPick={args.onPick} />,
  play: async ({ canvas, step }) => {
    const input = canvas.getByRole('combobox', { name: 'Name' });
    const list = body.getByRole('listbox', { name: 'Many options' });
    await step('Given the input has focus', () => {
      input.focus();
    });
    await step('When I press ArrowUp', async () => {
      await (await trustedInput()).keyboard('{ArrowUp}');
    });
    await step('Then aphid is inside the list', async () => {
      await waitFor(() => expectInside(body.getByRole('option', { name: 'aphid' }), list));
    });
    await step('When I press ArrowDown', async () => {
      await (await trustedInput()).keyboard('{ArrowDown}');
    });
    await step('Then app is inside the list', async () => {
      await waitFor(() => expectInside(body.getByRole('option', { name: 'app' }), list));
    });
  },
};

/** As a dotli user typing a name while the names still load, I see a loading row after the matches so far. */
export const Loading: Story = {
  render: args => (
    <InputFrame
      width="300px"
      inputLabel="Name"
      listId="listbox-loading-matches"
      listLabel="Suggested names"
      loading="Loading names"
    >
      <Options labels={['hosted', 'host-tools']} active="host-tools" detail=".paseo" onPick={args.onPick} />
    </InputFrame>
  ),
  play: async ({ step }) => {
    await step('Then the list is busy and a status shows', async () => {
      const list = await body.findByRole('listbox', { name: 'Suggested names' });
      await expect(list).toHaveAttribute('aria-busy', 'true');
      await expect(body.getByRole('status')).toBeInTheDocument();
    });
  },
};

/** As a dotli user typing a name while the names still load, I see the list open with only a loading row. */
export const LoadingAlone: Story = {
  render: () => (
    <InputFrame
      width="300px"
      inputLabel="Name"
      listId="listbox-loading-empty"
      listLabel="Suggested names"
      loading="Loading names"
    >
      {null}
    </InputFrame>
  ),
};

/**
 * As a dotli user typing a name, I see my recent names and the app names under their own headings, and I remove a recent
 * name with its cross and it goes while nothing is picked and the input keeps focus.
 */
export const Groups: Story = {
  render: args => <GroupsFrame onPick={args.onPick} />,
  play: async ({ args, canvas, step }) => {
    const input = canvas.getByRole('combobox', { name: 'Name' });
    await step('Then the recent names are a group named by its heading', async () => {
      const recent = body.getByRole('group', { name: 'Recent' });
      await expect(within(recent).getAllByRole('option')).toHaveLength(2);
    });
    await step('Given the input has focus', () => {
      input.focus();
    });
    await step('When I click the cross on news', async () => {
      const news = body.getByRole('option', { name: 'news.dot' });
      await (await trustedInput()).click(within(news).getByTestId('listbox-remove'));
    });
    await step('Then news is gone, nothing is picked and the input still has focus', async () => {
      await expect(body.queryByRole('option', { name: 'news.dot' })).toBeNull();
      await expect(args.onPick).not.toHaveBeenCalled();
      await expect(input).toHaveFocus();
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

/** A combobox input with its list open below it, until the list closes. */
function InputFrame(props: InputFrameProps): JSX.Element {
  return (
    <div style={{ width: props.width }}>
      <OpenList
        listId={props.listId}
        listLabel={props.listLabel}
        loading={props.loading}
        anchor={ref => (
          <input
            ref={ref}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={props.listId}
            aria-label={props.inputLabel}
            onKeyDown={event => {
              props.onKeyDown?.(event);
            }}
          />
        )}
      >
        {props.children}
      </OpenList>
    </div>
  );
}

/** The control `anchor` renders, with its list open below it until the list closes. */
function OpenList(props: OpenListProps): JSX.Element {
  const [anchor, setAnchor] = createSignal<HTMLElement | undefined>(undefined, { ownedWrite: true });
  const [open, setOpen] = createSignal(true);
  return (
    <>
      {props.anchor(setAnchor)}
      <Listbox
        id={props.listId}
        label={props.listLabel}
        anchor={anchor()}
        open={open()}
        onClose={() => {
          setOpen(false);
        }}
        align={props.align}
        loading={props.loading}
      >
        {props.children}
      </Listbox>
    </>
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
          end={props.end?.(label)}
          remove={
            props.onRemove && {
              label: `Remove ${label}`,
              onRemove: () => {
                props.onRemove?.(label);
              },
            }
          }
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

/** Recent names that each remove themselves, then the app names, each under its heading. */
function GroupsFrame(props: StoryArgs): JSX.Element {
  const [recent, setRecent] = createSignal(['news', 'browse']);
  return (
    <InputFrame width="300px" inputLabel="Name" listId="listbox-groups" listLabel="Suggested names">
      <Listbox.Group label="Recent">
        <Options
          labels={recent()}
          active="browse"
          icon={ClockIcon}
          detail=".dot"
          onRemove={label => {
            setRecent(names => names.filter(name => name !== label));
          }}
          onPick={props.onPick}
        />
      </Listbox.Group>
      <Listbox.Group label="Apps">
        <Options labels={['bridge', 'broker']} detail=".dot" onPick={props.onPick} />
      </Listbox.Group>
    </InputFrame>
  );
}

/** The open floating layer that holds the list. */
function getLayer(list: HTMLElement): HTMLElement {
  const layer = list.closest<HTMLElement>('[data-open]');
  if (layer === null) {
    throw new Error(`No open layer holds the list #${list.id}`);
  }
  return layer;
}

/** Asserts the option sits fully inside the list's visible box. */
async function expectInside(option: Element, list: Element): Promise<void> {
  const inner = option.getBoundingClientRect();
  const outer = list.getBoundingClientRect();
  await expect(inner.top).toBeGreaterThanOrEqual(outer.top);
  await expect(inner.bottom).toBeLessThanOrEqual(outer.bottom);
}
