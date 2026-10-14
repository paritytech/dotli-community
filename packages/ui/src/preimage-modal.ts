// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ERRORS } from './errors.js';
import { presentModal } from './overlays/load.js';
import { iconMarkup, PERMISSION_ICONS } from './permission-icons.js';
import type { ModalField } from './state/modals.js';

function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${String(Math.round(bytes / 1024))} KB` : `${String(bytes)} B`;
}

export async function showPreimageSubmitModal(dataSize: number, signal?: AbortSignal): Promise<void> {
  const { result } = await presentModal<'cancel' | 'allow'>(
    {
      icon: iconMarkup(PERMISSION_ICONS.PreimageSubmit),
      title: 'Submit Preimage',
      fields: [{ label: 'Data size', value: formatSize(dataSize) }],
      buttons: [
        { label: 'Cancel', variant: 'cancel', result: 'cancel' },
        { label: 'Allow', variant: 'primary', result: 'allow' },
      ],
      dismissOnBackdrop: false,
      fallbackResult: 'cancel',
    },
    signal,
  );
  if (result !== 'allow') {
    throw new Error(ERRORS.PREIMAGE_SUBMIT_DENIED);
  }
}

/** What the person sees before the host pays a cache node to keep a preimage. */
export interface PreimageRetainReview {
  /** The product that asks. */
  label: string;
  size: number;
  periodSecs: number;
  /** The name and region of the cache node. */
  node: string;
  /** The price in credits, when the ledger of the node gave the prices. */
  price?: number;
  /** What the payer can spend: the free allowance for retention that is left today, and the paid credits. */
  funds?: { free: number; paid: number };
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : formatSize(bytes);
}

function formatPeriod(secs: number): string {
  const days = secs / 86_400;
  if (Number.isInteger(days)) {
    return days === 1 ? '1 day' : `${String(days)} days`;
  }
  const hours = Math.ceil(secs / 3600);
  return hours === 1 ? '1 hour' : `${String(hours)} hours`;
}

function priceText(price: number, funds: PreimageRetainReview['funds']): { value: string; warning: boolean } {
  const credits = `${String(price)} ${price === 1 ? 'credit' : 'credits'}`;
  if (funds === undefined) {
    return { value: credits, warning: false };
  }
  if (price <= funds.free) {
    return { value: `${credits}, from the free allowance (${String(funds.free)} left today)`, warning: false };
  }
  if (price <= funds.free + funds.paid) {
    const paid = price - funds.free;
    return { value: `${credits}: ${String(funds.free)} from the free allowance, ${String(paid)} paid`, warning: false };
  }
  return {
    value: `${credits}, more than the payer has (${String(funds.free)} free, ${String(funds.paid)} paid)`,
    warning: true,
  };
}

/** Ask the person to pay a cache node to keep a preimage. True when the person accepts. */
export async function showPreimageRetainModal(review: PreimageRetainReview, signal?: AbortSignal): Promise<boolean> {
  const fields: ModalField[] = [
    { label: 'App', value: review.label },
    { label: 'File size', value: formatBytes(review.size) },
    { label: 'Keep for', value: formatPeriod(review.periodSecs) },
    { label: 'Cache node', value: review.node },
  ];
  if (review.price !== undefined) {
    const price = priceText(review.price, review.funds);
    fields.push({ label: 'Price', value: price.value, ...(price.warning ? { warning: true } : {}) });
  }
  const { result } = await presentModal<'cancel' | 'keep'>(
    {
      icon: iconMarkup(PERMISSION_ICONS.PreimageRetain),
      title: 'Keep a file on a cache node',
      fields,
      notice:
        'The node keeps a copy close to you until the end of the period, so reads are fast. Bulletin keeps the original.',
      buttons: [
        { label: 'Cancel', variant: 'cancel', result: 'cancel' },
        { label: 'Keep', variant: 'primary', result: 'keep' },
      ],
      dismissOnBackdrop: true,
      dismissResult: 'cancel',
      fallbackResult: 'cancel',
    },
    signal,
  );
  return result === 'keep';
}
