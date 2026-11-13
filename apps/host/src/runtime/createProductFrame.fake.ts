// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page around the product frame for specs: it records what the frame shows, and its screens are disposers a spec
// puts up, which run once each as the page's screens come down.

import type { ProductFrameStatus, ProductFrameView, TitledProduct } from './createProductFrame.js';

export type ScreenName = 'page' | 'loading';

/** A page around the frame that records what the frame shows. Never throws. */
export function createFakeProductFrameView() {
  const attached: HTMLIFrameElement[] = [];
  const titles: TitledProduct[] = [];
  const statuses: ProductFrameStatus[] = [];
  let cleared = 0;
  const screens = new Map<ScreenName, () => void>();

  function clearScreen(name: ScreenName): void {
    const dispose = screens.get(name);
    screens.delete(name);
    dispose?.();
  }

  const view: ProductFrameView = {
    attachFrame: iframe => {
      attached.push(iframe);
    },
    showTitle: product => {
      titles.push(product);
    },
    clearScreens({ loading }) {
      clearScreen('page');
      if (loading) {
        clearScreen('loading');
      }
    },
    showStatus: status => {
      statuses.push(status);
    },
    clearMount: () => {
      cleared += 1;
    },
  };

  return {
    /** The view the frame is given. */
    view,
    /** Every frame handed to the layout, in order. */
    attached,
    /** Every product the tab title was shown for, in order. */
    titles,
    /** Every status the frame published, in order. */
    statuses,
    /** How many times the frame emptied its mount. */
    countMountsCleared: (): number => cleared,
    /** Puts up a screen whose dispose runs the first time the frame clears it. */
    showScreen,
  };

  function showScreen(name: ScreenName, dispose: () => void): void {
    screens.set(name, dispose);
  }
}

/** One post to a frame's window. */
type FramePost = {
  /** The message posted. */
  message: unknown;
  /** The origin the post was addressed to, `undefined` when the post named none. */
  targetOrigin: string | undefined;
};

type FramePostRecord = {
  /** The posts to the frame's window, in order. */
  posts: FramePost[];
  /** What every post throws, or `null` while posts succeed. */
  failure: Error | null;
};

const framePosts = new WeakMap<HTMLIFrameElement, FramePostRecord>();

/** A frame as an opaque token: the runtime hands it on, listens for its load, compares its window by identity and posts to it. */
export function createFakeIframe(): HTMLIFrameElement {
  const record: FramePostRecord = { posts: [], failure: null };
  const contentWindow = {
    postMessage(message: unknown, options?: WindowPostMessageOptions): void {
      if (record.failure !== null) {
        throw record.failure;
      }
      record.posts.push({ message, targetOrigin: options?.targetOrigin });
    },
  };
  // The runtime reads no other member of the element, so the token stands in for it.
  const iframe = Object.assign(new EventTarget(), { contentWindow }) as unknown as HTMLIFrameElement;
  framePosts.set(iframe, record);
  return iframe;
}

function readRecord(iframe: HTMLIFrameElement): FramePostRecord {
  const record = framePosts.get(iframe);
  if (record === undefined) {
    throw new Error('The iframe was not made by createFakeIframe');
  }
  return record;
}

/** The posts to the window of a frame `createFakeIframe` made, in order. Throws for any other frame. */
export function readFramePosts(iframe: HTMLIFrameElement): FramePost[] {
  return readRecord(iframe).posts;
}

/** Makes every later post to the window of a frame `createFakeIframe` made throw `error`. Throws for any other frame. */
export function breakFramePosts(iframe: HTMLIFrameElement, error: Error): void {
  readRecord(iframe).failure = error;
}
