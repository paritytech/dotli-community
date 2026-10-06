// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { CameraScanDialog } from './CameraScanDialog.js';

const CAMERAS = [
  { deviceId: 'front', label: 'Front camera' },
  { deviceId: 'back', label: 'Back camera' },
];

const meta = {
  title: 'Entities/CameraScanDialog',
  component: CameraScanDialog,
  // Own docs iframes, since each fixed dialog takes the focus and keys of the page it is on.
  parameters: { chrome: true, docs: { story: { inline: false, height: '720px' } } },
  args: {
    title: 'Scan application/octet-stream',
    detail: 'playground.dot requested decoded camera input. Point the camera at the UR QR stream.',
    progress: 'UR reconstruction 42%',
    cameras: CAMERAS,
    selectedCamera: 'back',
    compactPicker: false,
    video: () => undefined,
    onSelectCamera: () => undefined,
    onFlipCamera: () => undefined,
    onCancel: () => undefined,
  },
} satisfies Meta<typeof CameraScanDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CameraList: Story = {
  play: async () => {
    const body = within(document.body);
    // The modal comes in with its open animation.
    await waitFor(async () => {
      await expect(body.getByTestId('camera-scan-video')).toBeVisible();
    });
    await expect(body.getByRole('combobox', { name: 'Camera' })).toHaveValue('back');
    await expect(body.getByTestId('camera-scan-cancel')).toBeVisible();
  },
};

export const SingleCamera: Story = {
  args: { cameras: [], progress: 'Waiting for a QR frame…' },
};

export const Phone: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  args: { compactPicker: true },
  globals: { viewport: { value: 'phone', isRotated: false } },
};
