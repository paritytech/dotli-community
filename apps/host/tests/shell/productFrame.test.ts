// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Without the option above, happy-dom fetches the never-navigated product frames from a dev server. This is the error
// page in `#app` meeting the frame's container swap.
import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { isSandboxOrigin } from '@dotli/config';
import { startSandboxChannel } from '@dotli/sandbox-wire';
import type { FrameHostParams, FrameProduct } from '../../src/runtime/createProductFrame.js';
import { answerConnection, createFakePageCore } from '../../src/runtime/createPageCore.fake.js';
import { createProductFrame } from '../../src/runtime/createProductFrame.js';
import { createPermissionAuthorizations } from '../../src/runtime/createPermissionAuthorizations.js';
import { pageScreen, showErrorPage } from '@dotli/ui';
import { createProductFrameView } from '../../src/createProductFrameView.js';
import { nth } from '@dotli/shared/testing';
import { rethrow } from '../../src/testing/rethrow.js';

type FakeIframeHost = {
  params: FrameHostParams;
  iframe: HTMLIFrameElement;
  dispose: Mock<() => void>;
};

type ProductFramePage = ReturnType<typeof setupProductFramePage>;

type RenderProductParams = {
  product: FrameProduct;
  /** The core connection the render asks for, by its index. */
  connection: number;
};

describe('product frame rebuilds on the page', () => {
  it('As a dApp user, I see a failed product ask to be rebuilt and only its new frame is left over the error page', async () => {
    // Given a product whose load failed after its frame went up
    const page = setupProductFramePage();
    await renderProduct(page, { product: createSubdomainProduct('reloaded'), connection: 0 });
    showErrorPage({ title: 'Failed' });

    // When its sandbox asks to be rebuilt
    askToRecover(page);
    await answerConnection(page, 1);
    await page.changes.until(() => (page.hosts[0]?.dispose.mock.calls.length ?? 0) > 0);

    // Then only the new frame is left
    expect(page.container.children).toHaveLength(1);
    expect(page.container.firstElementChild).toBe(nth(page.hosts, 1).iframe);
  });
});

/** The page's frame over `#app`, with fake frames the test can see, torn down with its channel when the case ends. */
function setupProductFramePage() {
  document.body.innerHTML = `<div id="app"></div>`;
  window.history.replaceState(null, '', '/');
  const fakes = createFakePageCore();
  const container = document.getElementById('app');
  if (container === null) {
    throw new Error('fixture has no #app');
  }
  const hosts: FakeIframeHost[] = [];
  const channel = startSandboxChannel({ target: window, isTrustedOrigin: isSandboxOrigin, report: rethrow });
  onTestFinished(() => {
    pageScreen.clear();
    channel.stop();
  });
  const frame = createProductFrame({
    core: fakes.core,
    createIframeHost(params) {
      const iframe = document.createElement('iframe');
      container.appendChild(iframe);
      const dispose = vi.fn(() => {
        iframe.remove();
        fakes.changes.notify();
      });
      hosts.push({ params, iframe, dispose });
      return Promise.resolve({ iframe, dispose });
    },
    channel,
    subscribePermissionChanges: () => () => undefined,
    permissions: createPermissionAuthorizations(),
    // The real view over `#app`, so the error page meets the container swap.
    view: createProductFrameView({
      body: () => document.body,
      container: () => container,
      clearScreen: pageScreen.clear,
      hideLoading: () => undefined,
    }),
    notify: () => undefined,
  });
  return {
    ...fakes,
    frame,
    /** The page's `#app`, which holds the frames. */
    container,
    /** Each iframe host the frame built, in order. */
    hosts,
  };
}

/** Renders `product` and answers the core connection it asks for. */
async function renderProduct(page: ProductFramePage, { product, connection }: RenderProductParams): Promise<void> {
  const rendered = page.frame.render(product);
  await answerConnection(page, connection);
  await rendered;
}

/** The sandbox in the first frame asking to be rebuilt. */
function askToRecover(page: ProductFramePage): void {
  const asking = nth(page.hosts, 0);
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'dotli:sandbox-recover' },
      origin: asking.params.allowedOrigin ?? '',
      source: asking.iframe.contentWindow,
    }),
  );
}

function createSubdomainProduct(label: string): FrameProduct {
  return { mode: 'subdomain', label, cid: 'cid', chat: Promise.resolve(false), facts: {} };
}
