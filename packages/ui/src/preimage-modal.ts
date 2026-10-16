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

/** One item that the host will pay a cache node to keep. */
export interface PreimageRetainItemReview {
  /** What the item is: a DotNS name, a file name or a short CID. */
  what?: string;
  size: number;
  /** The period. For an item that renews, the end of the renewals from now, or 0 when they have no end. */
  periodSecs: number;
  /** The name and region of the cache node. */
  node: string;
  /** The price in credits, when the ledger of the node gave the prices. For an item that renews, one day. */
  price?: number;
  /** The node renews the retention each day until the person stops it, or until the end of the period. */
  renews?: boolean;
}

/** What the person sees before the host pays cache nodes to keep one or more items. */
export interface PreimageRetainReview {
  /** The product that asks. */
  label: string;
  items: PreimageRetainItemReview[];
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

function creditsText(price: number): string {
  return `${String(price)} ${price === 1 ? 'credit' : 'credits'}`;
}

// The end of the renewals of an item that renews: until the person stops it, or until a date.
function renewalText(item: PreimageRetainItemReview): string {
  if (item.periodSecs === 0) {
    return 'until you stop';
  }
  const end = new Date(Date.now() + item.periodSecs * 1000);
  return `until ${end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// The price of an item: the price of the period, or for an item that renews the price of one day and the end.
function itemPrice(item: PreimageRetainItemReview, price: number): string {
  return item.renews === true ? `${creditsText(price)} a day, ${renewalText(item)}` : creditsText(price);
}

/**
 * The text of the price that the payer pays now, and how the funds pay it. For an item that renews, `credits` gives the
 * price of a day, and the funds pay the first day now.
 */
function priceText(
  price: number,
  funds: PreimageRetainReview['funds'],
  credits = creditsText(price),
  now = '',
): { value: string; warning: boolean } {
  if (funds === undefined) {
    return { value: credits, warning: false };
  }
  if (price <= funds.free) {
    return { value: `${credits}, ${now}from the free allowance (${String(funds.free)} left today)`, warning: false };
  }
  if (price <= funds.free + funds.paid) {
    const paid = price - funds.free;
    return {
      value: `${credits}: ${now}${String(funds.free)} from the free allowance, ${String(paid)} paid`,
      warning: false,
    };
  }
  return {
    value: `${credits}, more than the payer has (${String(funds.free)} free, ${String(funds.paid)} paid)`,
    warning: true,
  };
}

// The period of an item: a duration, or for an item that renews the renewals and their end.
function periodText(item: PreimageRetainItemReview): string {
  return item.renews === true ? `renewed daily ${renewalText(item)}` : formatPeriod(item.periodSecs);
}

function itemText(item: PreimageRetainItemReview): string {
  const parts = [item.what, formatBytes(item.size), item.renews === true ? undefined : periodText(item), item.node];
  if (item.price !== undefined) {
    parts.push(itemPrice(item, item.price));
  } else if (item.renews === true) {
    parts.push(periodText(item));
  }
  return parts.filter(Boolean).join(' · ');
}

/** Ask the person to pay cache nodes to keep the items of `review`. True when the person accepts. */
export async function showPreimageRetainModal(review: PreimageRetainReview, signal?: AbortSignal): Promise<boolean> {
  const fields: ModalField[] = [{ label: 'App', value: review.label }];
  const [only] = review.items;
  if (review.items.length === 1 && only !== undefined) {
    if (only.what !== undefined) {
      fields.push({ label: 'Item', value: only.what });
    }
    fields.push(
      { label: 'File size', value: formatBytes(only.size) },
      only.renews === true
        ? { label: 'Keep', value: periodText(only) }
        : { label: 'Keep for', value: formatPeriod(only.periodSecs) },
      { label: 'Cache node', value: only.node },
    );
  } else {
    review.items.forEach((item, index) => {
      fields.push({ label: `Item ${String(index + 1)}`, value: itemText(item) });
    });
  }
  const priced = review.items.every(item => item.price !== undefined);
  if (priced) {
    // An item that renews pays its first day now, so the total is what the payer pays now.
    const total = review.items.reduce((sum, item) => sum + (item.price ?? 0), 0);
    const renews = review.items.some(item => item.renews === true);
    const price =
      review.items.length === 1 && only !== undefined && renews
        ? priceText(total, review.funds, itemPrice(only, total), 'the first day ')
        : priceText(total, review.funds);
    fields.push({
      label: review.items.length === 1 ? 'Price' : renews ? 'Total now' : 'Total',
      value: price.value,
      ...(price.warning ? { warning: true } : {}),
    });
  }
  const { result } = await presentModal<'cancel' | 'keep'>(
    {
      icon: iconMarkup(PERMISSION_ICONS.PreimageRetain),
      title:
        review.items.length === 1
          ? 'Keep a file on a cache node'
          : `Keep ${String(review.items.length)} items on cache nodes`,
      fields,
      notice: review.items.some(item => item.renews === true)
        ? 'The node keeps a copy close to you, so reads are fast. It charges one day at a time, until the end or until ' +
          'you stop it. Bulletin keeps the original.'
        : 'The node keeps a copy close to you until the end of the period, so reads are fast. Bulletin keeps the original.',
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
