// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Without the option above, happy-dom fetches the never-navigated product frames from a dev server. The frame's rules
// are unit tested beside product-frame.ts. This one is the error page in `#app` meeting the frame's container swap.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSandboxOrigin } from '@dotli/config';
import { startSandboxChannel, type StartedSandboxChannel } from '@dotli/sandbox-wire';
import type { FrameProduct, ProductFrame } from '../../src/runtime/product-frame.js';
import { answerConnection, createFakePageCore, type FakePageCore } from '../../src/runtime/page-core.fake.js';
import { createProductFrame } from '../../src/runtime/product-frame.js';
import { clearScreen, showErrorPage } from '@dotli/ui';
import { createProductFrameView } from '../../src/product-frame-view.js';
import { nth } from '@dotli/shared/testing';

/** What the frame asks of an iframe host. */
type IframeHostOptions = Parameters<Parameters<typeof createProductFrame>[0]['createIframeHost']>[0];

/** A handler that throws fails the test. */
const rethrow = (error: unknown): never => {
  throw error;
};

interface FakeIframeHost {
  options: IframeHostOptions;
  iframe: HTMLIFrameElement;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

interface Harness extends FakePageCore {
  frame: ProductFrame;
  container: HTMLElement;
  hosts: FakeIframeHost[];
}

let channel: StartedSandboxChannel | null = null;

afterEach(() => {
  clearScreen();
  channel?.stop();
  channel = null;
});

beforeEach(() => {
  document.body.innerHTML = `<div id="app"></div>`;
  window.history.replaceState(null, '', '/');
});

/** The page's frame over `#app`, with fake frames the test can see. */
function harness(fakes: FakePageCore = createFakePageCore()): Harness {
  const container = document.getElementById('app');
  if (container === null) {
    throw new Error('fixture has no #app');
  }
  const hosts: FakeIframeHost[] = [];
  channel = startSandboxChannel({ target: window, isTrustedOrigin: isSandboxOrigin, report: rethrow });
  const frame = createProductFrame({
    core: fakes.core,
    createIframeHost: options => {
      const iframe = document.createElement('iframe');
      options.container.appendChild(iframe);
      const dispose = vi.fn(() => {
        iframe.remove();
        fakes.changes.notify();
      });
      hosts.push({ options, iframe, dispose });
      return Promise.resolve({ iframe, dispose });
    },
    container,
    channel,
    onPermissionsChanged: () => () => undefined,
    // The page around the frame, as the host wires it.
    view: createProductFrameView({ body: () => document.body, clearScreen, hideLoading: () => undefined }),
    notify: () => undefined,
  });
  return { ...fakes, frame, container, hosts };
}

/** Renders `product` and answers the core connection it asks for. */
async function settle(fakes: Harness, product: FrameProduct, connection: number): Promise<void> {
  const rendered = fakes.frame.render(product);
  await answerConnection(fakes, connection);
  await rendered;
}

/** The sandbox in frame `host` asking to be rebuilt, as it does after a reload. */
function askToRecover(fakes: Harness, host = 0): void {
  const asking = nth(fakes.hosts, host);
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'dotli:sandbox-recover' },
      origin: asking.options.allowedOrigin ?? '',
      source: asking.iframe.contentWindow,
    }),
  );
}

const subdomainProduct = (label: string, cid = 'cid'): FrameProduct => ({
  mode: 'subdomain',
  label,
  cid,
  chat: Promise.resolve(false),
});

describe('product frame rebuilds on the page', () => {
  it('As a dApp user, an error page shown over a live product is cleared when its sandbox asks to be rebuilt', async () => {
    // Given a product whose load failed after its frame went up
    const fakes = harness();
    await settle(fakes, subdomainProduct('reloaded'), 0);
    showErrorPage({ title: 'Failed' });

    // When its sandbox asks to be rebuilt
    askToRecover(fakes);
    await answerConnection(fakes, 1);
    await fakes.changes.until(() => (fakes.hosts[0]?.dispose.mock.calls.length ?? 0) > 0);

    // Then only the new frame is left
    expect(fakes.container.children).toHaveLength(1);
    expect(fakes.container.firstElementChild).toBe(nth(fakes.hosts, 1).iframe);
  });
});
