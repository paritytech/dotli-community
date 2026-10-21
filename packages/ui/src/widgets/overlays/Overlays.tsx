// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { ToastStack } from '../../components/overlays/ToastStack.js';
import { ModalOutlet } from './ModalOutlet.js';

/** The page's toasts and the dialog in front of the modal queue. Each app mounts it once. */
export function Overlays(): JSX.Element {
  return (
    <>
      <ToastStack />
      <ModalOutlet />
    </>
  );
}
