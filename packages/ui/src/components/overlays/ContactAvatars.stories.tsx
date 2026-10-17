// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, within } from 'storybook/test';
import { mood, portraitUrl } from '../../../.storybook/profile-fixtures.js';
import type { AvatarSlotState, AvatarSlotView } from '../../profile/avatar-overlay.js';
import type { Mood } from '../../profile/profile-record.js';
import { ContactAvatars } from './ContactAvatars.js';
import { MoodRing } from './MoodRing.js';

const ROW = 64;
const CIRCLE = 44;
const WIDTH = 360;

interface Contact {
  name: string;
  photo?: { hue: number; initials: string };
  mood?: Mood;
}

const CONTACTS: readonly Contact[] = [
  { name: 'alice.paseo', photo: { hue: 280, initials: 'A' }, mood: mood('hyped', 'loud') },
  { name: 'bob.paseo', photo: { hue: 190, initials: 'B' } },
  { name: 'carol.paseo', mood: mood('calm', 'soft') },
  { name: 'dave.paseo', photo: { hue: 30, initials: 'D' }, mood: mood('focused') },
  { name: 'erin.paseo', photo: { hue: 120, initials: 'E' }, mood: mood('social') },
];

/**
 * The avatars over a stand-in product list, each row clipped to the list as a
 * product's placement clips it. In the app, avatar-overlay.ts lays the same
 * slots over the product frame.
 */
function ContactList(props: { moving: boolean }): JSX.Element {
  const slots: AvatarSlotView[] = CONTACTS.map((contact, index) => {
    const photoUrl = contact.photo === undefined ? null : portraitUrl(contact.photo.hue, contact.photo.initials);
    return {
      state: (): AvatarSlotState => ({
        rootBox: { x: 0, y: index * ROW, w: WIDTH, h: ROW },
        anchorBox: { x: 16, y: (ROW - CIRCLE) / 2, w: CIRCLE, h: CIRCLE },
        // A moving slot fades out until positions settle; the first shows it.
        moving: props.moving && index === 0,
        photoUrl,
        mood: contact.mood,
      }),
      update: () => undefined,
    };
  });
  return (
    <div
      data-testid="contact-list"
      style={{
        position: 'relative',
        width: `${String(WIDTH)}px`,
        'max-width': '100%',
        height: `${String(CONTACTS.length * ROW)}px`,
        overflow: 'hidden',
        'border-radius': '12px',
        background: '#111114',
        color: '#e4e4e7',
        'font-family': 'system-ui, sans-serif',
      }}
    >
      <For each={CONTACTS}>
        {contact => (
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '16px',
              height: `${String(ROW)}px`,
              padding: '0 16px',
              'border-bottom': '1px solid rgba(255, 255, 255, 0.06)',
            }}
          >
            <span
              style={{
                width: `${String(CIRCLE)}px`,
                height: `${String(CIRCLE)}px`,
                'border-radius': '50%',
                background: '#2a2a2e',
                flex: 'none',
              }}
            />
            <span>{contact.name}</span>
          </div>
        )}
      </For>
      <div style={{ position: 'absolute', inset: '0', 'pointer-events': 'none' }}>
        <ContactAvatars slots={() => slots} />
      </div>
    </div>
  );
}

const meta = {
  title: 'Entities/ContactAvatars',
  component: ContactList,
  args: { moving: false },
} satisfies Meta<typeof ContactList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Photos, mood rings, or both, over each contact's placeholder circle. */
export const Roster: Story = {
  play: async () => {
    const body = within(document.body);
    await expect(body.getAllByTestId('contact-avatar-slot')).toHaveLength(CONTACTS.length);
    await expect(body.getAllByTestId('mood-ring')).toHaveLength(4);
  },
};

export const RosterPhone: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
};

/** The first row is mid-scroll, so its avatar is faded out. */
export const Moving: Story = { args: { moving: true } };

/** The drawer's animated ring, and its still fallback, around a 160 px circle. */
export const MoodRings: StoryObj = {
  render: () => (
    <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '24px' }}>
      <For each={['calm', 'focused', 'hyped', 'social', 'low-key', 'away'] as const}>
        {kind => (
          <div
            style={{
              position: 'relative',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              width: '240px',
              height: '240px',
            }}
          >
            <MoodRing mood={mood(kind)} size={160} animated={kind !== 'away'} />
            <span style={{ color: '#e4e4e7', 'font-family': 'system-ui, sans-serif' }}>{kind}</span>
          </div>
        )}
      </For>
    </div>
  ),
};
