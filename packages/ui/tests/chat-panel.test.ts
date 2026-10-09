import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelToProductId } from '../src/runtime-config.js';
import { setChatCapability } from '@dotli/shared';
import type {
  HostChatActionSubscribeItem,
  HostRendererActionSubscribeItem,
  ProductRendererRenderRequest,
} from '@parity/truapi';
import type { RenderSink } from '@parity/truapi-host';
import type * as AuthModule from '../src/state/auth.js';
import type * as TopbarModule from '../src/state/topbar.js';
import type * as ServiceModule from '../src/chat/service.js';
import { byId, byTestId, query } from './support.js';
import { moreRow, stubTopbarLayout } from './components/shell/topbar-harness.js';
import { nth } from './helpers/nth.js';
import { preloadFloatingSurfaces } from './helpers/floating.js';

// happy-dom drops a calc() holding a var(). product-frame-layout tests cover the inset terms.
vi.mock('../src/product-iframe-box.js', () => ({
  productIframeBox: () => ({
    top: '56px',
    left: '0px',
    width: 'calc(100% - 10px)',
    height: 'calc(100dvh - 56px)',
  }),
}));

// The panel and service keep module-level state, so each test loads a fresh module graph, stores included.
let stores: {
  auth: typeof AuthModule;
  topbar: typeof TopbarModule;
};
interface Dock {
  initChatPanel: () => void;
}

let disposeDock: (() => void) | undefined;

/** Loads the ChatDock island and the chat state from the current module graph. */
async function loadDock(): Promise<Dock> {
  const solid = await import('solid-js');
  const web = await import('@solidjs/web');
  const { ChatDock } = await import('../src/components/chat/ChatDock.js');
  const state = await import('../src/state/chat-panel.js');
  return {
    initChatPanel: () => {
      state.initChatPanelState();
      disposeDock = web.render(() => solid.createComponent(ChatDock, {}), byId('dock-slot'));
      solid.flush();
    },
  };
}

async function loadChatModules(): Promise<{
  panel: Dock;
  service: typeof ServiceModule;
}> {
  vi.resetModules();
  await loadStores();
  const modules = {
    panel: await loadDock(),
    service: await import('../src/chat/service.js'),
  };
  await mountChatButton();
  return modules;
}

async function loadStores(): Promise<void> {
  stores = {
    auth: await import('../src/state/auth.js'),
    topbar: await import('../src/state/topbar.js'),
  };
}

/** Applies the topbar button's batched Solid updates. */
let flushUi: () => void = () => undefined;
let disposeButton: (() => void) | undefined;

/**
 * Renders the topbar's ChatButton from the current module graph. Built without JSX, which would bind to the Solid
 * instance loaded before resetModules.
 */
async function mountChatButton(): Promise<void> {
  const solid = await import('solid-js');
  const web = await import('@solidjs/web');
  const { ChatButton } = await import('../src/components/shell/ChatButton.js');
  disposeButton = web.render(() => solid.createComponent(ChatButton, {}), byId('topbar-slot'));
  flushUi = solid.flush;
  flushUi();
}

function installChatDom(): void {
  document.body.innerHTML = `
    <div id="topbar-slot"></div>
    <div id="dock-slot"></div>
    <div id="app"><iframe></iframe></div>
  `;
}

/** What the auth controller records on Connected and Disconnected. */
function setLoggedIn(loggedIn: boolean): void {
  stores.auth.setLoggedIn(loggedIn);
  flushUi();
}

function clickChat(): void {
  byId('chat-button').click();
  flushUi();
}

function loadProduct(label: string): void {
  window.dispatchEvent(new CustomEvent('dotli:product-loaded', { detail: { label } }));
  setChatCapability(label, true);
  // The chat affordance is gated on an active session.
  setLoggedIn(true);
}

/** The panel renders on a queued task, then reads IndexedDB, so a fixed wait races slow machines. */
async function settle(ready: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      if (!ready()) {
        throw new Error('panel has not settled');
      }
    },
    { timeout: 5000 },
  );
}

describe('chat panel', () => {
  beforeEach(() => {
    localStorage.clear();
    installChatDom();
    // Prefetch fires a real idle timer that outlives the test otherwise.
    vi.stubGlobal('requestIdleCallback', () => 0);
  });

  afterEach(() => {
    disposeButton?.();
    disposeButton = undefined;
    disposeDock?.();
    disposeDock = undefined;
    flushUi = () => undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('As a user, the chat button appears only for chat-capable products', async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    const button = byId('chat-button');
    expect(button.hidden).toBe(true);

    loadProduct('chatless');
    setChatCapability('chatless', false);
    flushUi();
    expect(button.hidden).toBe(true);

    loadProduct('chatty-visible');
    expect(button.hidden).toBe(false);

    window.dispatchEvent(new CustomEvent('dotli:product-error'));
    flushUi();
    expect(button.hidden).toBe(true);
  });

  it('As a phone user, the chat button collapses into the More menu, whose Chat row opens the panel', async () => {
    // Given: a bar with no room for the chat button.
    vi.resetModules();
    await loadStores();
    const panel = await loadDock();
    const solid = await import('solid-js');
    const web = await import('@solidjs/web');
    const { ChatButton } = await import('../src/components/shell/ChatButton.js');
    const { ActionGroup } = await import('../src/components/shell/topbar/ActionGroup.js');
    // The More menu opens and is read in the same tick: its surface chunk, from this graph.
    await preloadFloatingSurfaces();
    stubTopbarLayout(1);
    disposeButton = web.render(
      () =>
        solid.createComponent(ActionGroup, {
          get children() {
            return solid.createComponent(ChatButton, {});
          },
        }),
      byId('topbar-slot'),
    );
    flushUi = solid.flush;
    flushUi();
    panel.initChatPanel();
    expect(document.querySelector('#more-popover [role="menuitem"][data-item="chat"]')).toBeNull();

    // When: a product with chat loads, with a session.
    loadProduct('chatty-more');

    // When
    byId('more-button').click();
    flushUi();

    // Then
    expect(moreRow('chat').textContent).toBe('Chat');

    // When
    moreRow('chat').click();
    flushUi();

    // Then
    expect(byId('chat-panel').hidden).toBe(false);
    expect(byId('chat-button').getAttribute('aria-expanded')).toBe('true');
    expect(byId('more-popover').hasAttribute('data-open')).toBe(false);
  });

  it('As a user, the chat button is hidden until I log in and hides again on logout', async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    const button = byId('chat-button');

    loadProduct('chatty-gated');
    setLoggedIn(false);
    expect(button.hidden).toBe(true);

    setLoggedIn(true);
    expect(button.hidden).toBe(false);

    // Logging out while the panel is open must also close it.
    clickChat();
    expect(byId('chat-panel').hidden).toBe(false);
    setLoggedIn(false);
    expect(button.hidden).toBe(true);
    expect(byId('chat-panel').hidden).toBe(true);
  });

  it('As a user, an empty room list shows a waiting hint', async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    loadProduct('chatty-empty');

    clickChat();
    await settle(() => byId('chat-panel-hint').hidden === false);

    expect(byId('chat-panel').hidden).toBe(false);
    expect(byId('chat-panel-hint').hidden).toBe(false);
    expect(byId('chat-panel-composer', HTMLFormElement).hidden).toBe(true);
  });

  it('As a user, opening the panel lists rooms with icon and name', async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct('chatty-rooms');
    const productId = labelToProductId('chatty-rooms');

    await service.productCreateRoom(productId, {
      roomId: 'support',
      name: 'Support',
      icon: 'data:image/png;base64,AAAA',
    });
    // Rooms created in the same millisecond tie, so let the clock tick for "General" to sort first.
    await new Promise(resolve => setTimeout(resolve, 2));
    await service.productCreateRoom(productId, {
      roomId: 'general',
      name: 'General',
      icon: '',
    });

    clickChat();
    await settle(() => document.querySelectorAll('[data-testid="chat-room-item"]').length === 2);

    expect(byId('chat-panel-rooms').hidden).toBe(false);
    expect(byId('chat-panel-composer', HTMLFormElement).hidden).toBe(true);
    const items = document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-room-item"]');
    expect(items).toHaveLength(2);
    expect(items[1]?.textContent).toContain('Support');
    expect(items[1]?.querySelector<HTMLImageElement>('img[data-testid="chat-room-icon"]')?.src).toBe(
      'data:image/png;base64,AAAA',
    );
    expect(items[0]?.querySelector('[data-testid="chat-room-icon"][data-fallback]')?.textContent).toBe('G');

    nth(items, 1).click();
    await settle(() => byId('chat-panel-rooms').hidden === true);
    expect(byId('chat-panel-rooms').hidden).toBe(true);
    expect(byId('chat-panel-title').textContent).toBe('Support');
    expect(byId('chat-panel-back').hidden).toBe(false);
    expect(byId('chat-panel-composer', HTMLFormElement).hidden).toBe(false);

    byId('chat-panel-back').click();
    await settle(() => byId('chat-panel-rooms').hidden === false);
    expect(byId('chat-panel-rooms').hidden).toBe(false);
    expect(byId('chat-panel-back').hidden).toBe(true);
  });

  it('As a user, the panel stretches to the top when the topbar hides', async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    const panelEl = byId('chat-panel');

    stores.topbar.setTopbarVisible(false);
    flushUi();
    expect(panelEl.hasAttribute('data-topbar-hidden')).toBe(true);

    stores.topbar.setTopbarVisible(true);
    flushUi();
    expect(panelEl.hasAttribute('data-topbar-hidden')).toBe(false);
  });

  it('As a user, product messages render and replies reach the product', async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct('chatty-send');
    const productId = labelToProductId('chatty-send');
    const published: HostChatActionSubscribeItem[] = [];
    service.registerChatConnection(productId, {
      publish: action => {
        published.push(action);
        return Promise.resolve();
      },
      publishRendererAction: () => Promise.resolve(),
      render: () => () => undefined,
    });

    await service.productCreateRoom(productId, {
      roomId: 'main',
      name: 'Main',
      icon: '',
    });
    await service.productPostMessage(productId, 'main', {
      tag: 'Text',
      value: { text: 'hello from the app' },
    });

    clickChat();
    await settle(() => document.querySelector('[data-testid="chat-room-item"]') !== null);
    const roomItem = document.querySelector<HTMLButtonElement>('[data-testid="chat-room-item"]');
    expect(roomItem?.textContent).toContain('Main');
    roomItem?.click();
    await settle(() => byId('chat-panel-messages').textContent.includes('hello from the app'));
    expect(byId('chat-panel-messages').textContent).toContain('hello from the app');
    const time = document.querySelector<HTMLTimeElement>('[data-testid="chat-msg-time"]');
    expect(time?.textContent).toBe('just now');
    expect(time?.title).not.toBe('');

    const input = byId('chat-panel-input', HTMLInputElement);
    input.value = 'hello back';
    byId('chat-panel-composer', HTMLFormElement).requestSubmit();
    await settle(() => byId('chat-panel-messages').textContent.includes('hello back') && published.length === 1);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      roomId: 'main',
      payload: {
        tag: 'MessagePosted',
        value: { tag: 'Text', value: { text: 'hello back' } },
      },
    });
    expect(byId('chat-panel-messages').textContent).toContain('hello back');
  });

  it('As a user, bots and rooms share one list ordered by last message time', async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct('contacts');
    const productId = labelToProductId('contacts');

    // Stamps within one millisecond tie, and the list orders contacts by them.
    const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 2));
    await service.productCreateRoom(productId, {
      roomId: 'first',
      name: 'First',
      icon: '',
    });
    await tick();
    await service.productCreateRoom(productId, {
      roomId: 'second',
      name: 'Second',
      icon: '',
    });
    await tick();
    await service.productCreateRoom(productId, {
      roomId: 'idle',
      name: 'Idle',
      icon: '',
    });
    await tick();
    expect(
      await service.registerBot(productId, {
        botId: 'echo',
        name: 'Echo Bot',
        icon: 'data:image/png;base64,AAAA',
      }),
    ).toBe('New');
    await tick();
    await service.productPostMessage(productId, 'second', {
      tag: 'Text',
      value: { text: 'older' },
    });
    await tick();
    await service.productPostMessage(productId, 'first', {
      tag: 'Text',
      value: { text: 'newer' },
    });

    clickChat();
    await settle(() => document.querySelectorAll('[data-testid="chat-room-item"]').length === 4);

    // One recency order across rooms and bots, falling back to creation time for contacts without messages.
    const items = [...document.querySelectorAll<HTMLElement>('[data-testid="chat-room-item"]')];
    expect(items.map(row => byTestId('chat-room-name', row).textContent)).toEqual([
      'First',
      'Second',
      'Echo Bot',
      'Idle',
    ]);

    const botRow = nth(items, 2);
    expect(botRow.querySelector<HTMLImageElement>('img[data-testid="chat-room-icon"]')?.src).toBe(
      'data:image/png;base64,AAAA',
    );
    botRow.click();
    await settle(() => byId('chat-panel-rooms').hidden === true);
    expect(byId('chat-panel-title').textContent).toBe('Echo Bot');
    expect(byId('chat-panel-composer', HTMLFormElement).hidden).toBe(false);

    // A bot messages the user by posting with its botId as the roomId.
    await service.productPostMessage(productId, 'echo', {
      tag: 'Text',
      value: { text: 'hi, I am the bot' },
    });
    await settle(() => byId('chat-panel-messages').textContent.includes('hi, I am the bot'));
    const botMessage = byTestId('chat-msg', byId('chat-panel-messages'));
    expect([...botMessage.children].map(child => child.getAttribute('data-testid'))).toEqual(['chat-msg-bubble']);

    byId('chat-panel-back').click();
    await settle(() => byId('chat-panel-rooms').hidden === false);
    const reordered = [...document.querySelectorAll<HTMLElement>('[data-testid="chat-room-item"]')].map(
      row => byTestId('chat-room-name', row).textContent,
    );
    expect(reordered).toEqual(['Echo Bot', 'First', 'Second', 'Idle']);
  });

  it('As a user, custom messages render live trees and taps reach the product', async () => {
    // Without IntersectionObserver the mount subscribes at once, which this test needs.
    vi.stubGlobal('IntersectionObserver', undefined);
    try {
      const { panel, service } = await loadChatModules();
      panel.initChatPanel();
      loadProduct('chatty-custom');
      const productId = labelToProductId('chatty-custom');

      const published: HostChatActionSubscribeItem[] = [];
      const rendererActions: HostRendererActionSubscribeItem[] = [];
      const renders: {
        request: ProductRendererRenderRequest;
        sink: RenderSink;
      }[] = [];
      const disposeRender = vi.fn();
      service.registerChatConnection(productId, {
        publish: action => {
          published.push(action);
          return Promise.resolve();
        },
        publishRendererAction: item => {
          rendererActions.push(item);
          return Promise.resolve();
        },
        render: (request, sink) => {
          renders.push({ request, sink });
          return disposeRender;
        },
      });

      await service.productCreateRoom(productId, {
        roomId: 'main',
        name: 'Main',
        icon: '',
      });
      const messageId = await service.productPostMessage(productId, 'main', {
        tag: 'Custom',
        value: { messageType: 'poll', payload: '0x0102' },
      });

      clickChat();
      await settle(() => document.querySelector('[data-testid="chat-room-item"]') !== null);
      document.querySelector<HTMLButtonElement>('[data-testid="chat-room-item"]')?.click();
      await settle(() => renders.length === 1);

      const context = {
        tag: 'ChatMessage',
        value: { roomId: 'main', messageId, messageType: 'poll' },
      };
      expect(renders).toHaveLength(1);
      expect(renders[0]?.request).toEqual({ context, payload: '0x0102' });
      expect(byId('chat-panel-messages').textContent).toContain('Loading…');

      nth(renders, 0).sink.onUpdate({
        tag: 'Column',
        value: {
          modifiers: [],
          props: {},
          children: [
            {
              tag: 'Text',
              value: {
                modifiers: [],
                props: {},
                children: [{ tag: 'String', value: { text: 'Pick one' } }],
              },
            },
            {
              tag: 'Button',
              value: {
                modifiers: [],
                props: {
                  text: 'Option A',
                  enabled: true,
                  clickAction: 'pick:a',
                },
                children: [],
              },
            },
          ],
        },
      });
      await settle(() => byId('chat-panel-messages').textContent.includes('Pick one'));
      expect(byId('chat-panel-messages').textContent).toContain('Pick one');

      // Tapping the rendered button publishes a renderer action, not a chat action.
      document.querySelector<HTMLButtonElement>('[data-testid="chat-custom-btn"]')?.click();
      await settle(() => rendererActions.length === 1);
      expect(rendererActions).toEqual([{ context, actionId: 'pick:a', payload: '0x' }]);
      expect(published).toHaveLength(0);

      // A failed render must not leave a partial tree standing.
      nth(renders, 0).sink.onError?.(new Error('render refused'));
      await settle(() => !byId('chat-panel-messages').textContent.includes('Pick one'));
      expect(byId('chat-panel-messages').textContent).not.toContain('Pick one');
      expect(byId('chat-panel-messages').textContent).toContain('This message can’t be shown right now.');

      byId('chat-panel-back').click();
      await settle(() => disposeRender.mock.calls.length > 0);
      expect(disposeRender).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('As a user, unseen product messages show an unread badge', async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct('chatty-unread');
    const productId = labelToProductId('chatty-unread');

    await service.productCreateRoom(productId, {
      roomId: 'main',
      name: 'Main',
      icon: '',
    });
    await service.productPostMessage(productId, 'main', {
      tag: 'Text',
      value: { text: 'ping' },
    });

    const badge = byId('chat-unread-badge');
    await settle(() => badge.hidden === false);
    expect(badge.textContent).toBe('1');

    clickChat();
    await settle(() => badge.hidden === true);
    expect(badge.hidden).toBe(true);
  });

  it('As a user, each room shows its own unread count until I open it', async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct('chatty-room-unread');
    const productId = labelToProductId('chatty-room-unread');

    await service.productCreateRoom(productId, {
      roomId: 'busy',
      name: 'Busy',
      icon: '',
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    await service.productCreateRoom(productId, {
      roomId: 'quiet',
      name: 'Quiet',
      icon: '',
    });
    await service.productPostMessage(productId, 'busy', {
      tag: 'Text',
      value: { text: 'one' },
    });
    await service.productPostMessage(productId, 'busy', {
      tag: 'Text',
      value: { text: 'two' },
    });

    // The topbar badge sums unreads across rooms.
    const badge = byId('chat-unread-badge');
    await settle(() => badge.textContent === '2');

    clickChat();
    await settle(() => document.querySelectorAll('[data-testid="chat-room-item"]').length === 2);
    const roomBadges = document.querySelectorAll('[data-testid="chat-room-unread"]');
    expect(roomBadges).toHaveLength(1);
    expect(roomBadges[0]?.textContent).toBe('2');
    const busyRow = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-room-item"]')].find(row =>
      row.textContent.includes('Busy'),
    );
    expect(busyRow?.querySelector('[data-testid="chat-room-unread"]')).not.toBeNull();

    // A message for another room while viewing this one stays unread.
    busyRow?.click();
    await settle(() => byId('chat-panel-rooms').hidden === true);
    await service.productPostMessage(productId, 'quiet', {
      tag: 'Text',
      value: { text: 'psst' },
    });

    byId('chat-panel-back').click();
    await settle(() => document.querySelectorAll('[data-testid="chat-room-unread"]').length === 1);
    const backBadges = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-room-item"]')].map(
      row => row.querySelector('[data-testid="chat-room-unread"]')?.textContent ?? '',
    );
    // Quiet lists first with the newest message, carrying the unread it got while Busy was open.
    expect(backBadges).toEqual(['1', '']);

    byId('chat-panel-close').click();
    flushUi();
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1');
  });

  it('As a user, opening the panel narrows the app and closing restores it', async () => {
    const { panel } = await loadChatModules();
    const layout = await import('../src/product-frame-layout.js');
    const iframe = query(document, '#app iframe', HTMLIFrameElement);
    layout.attachProductFrame(iframe);
    panel.initChatPanel();
    loadProduct('chatty-iframe');

    clickChat();
    expect(byId('chat-panel').hidden).toBe(false);
    expect(byId('chat-button').getAttribute('aria-expanded')).toBe('true');
    expect(byId('chat-panel').style.width).toBe('360px');
    expect(iframe.style.width).toBe('calc(calc(100% - 10px) - 360px)');

    const state = await import('../src/state/chat-panel.js');
    state.setChatPanelWidth(420);
    flushUi();
    expect(iframe.style.width).toBe('calc(calc(100% - 10px) - 420px)');

    await settle(() => document.getElementById('chat-panel-close') !== null);
    byId('chat-panel-close').click();
    flushUi();
    expect(byId('chat-panel').hidden).toBe(true);
    expect(byId('chat-button').getAttribute('aria-expanded')).toBe('false');
    // Closed, the frame gets the whole safe box.
    expect(iframe.style.width).toBe('calc(100% - 10px)');
  });

  it('As a user, reloading the product with the panel open keeps the app narrowed', async () => {
    const { panel } = await loadChatModules();
    const layout = await import('../src/product-frame-layout.js');
    layout.attachProductFrame(query(document, '#app iframe', HTMLIFrameElement));
    panel.initChatPanel();
    loadProduct('chatty-reload');
    clickChat();

    const fresh = document.createElement('iframe');
    byId('app').replaceChildren(fresh);
    layout.attachProductFrame(fresh);
    loadProduct('chatty-reload');

    expect(byId('chat-panel').hidden).toBe(false);
    expect(fresh.style.width).toBe('calc(calc(100% - 10px) - 360px)');
  });

  it('As a user, Escape closes the panel and returns focus to the chat button', async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    loadProduct('chatty-escape');

    clickChat();
    await settle(() => document.getElementById('chat-panel-close') !== null);
    byId('chat-panel-close').focus();
    byId('chat-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushUi();

    expect(byId('chat-panel').hidden).toBe(true);
    expect(document.activeElement).toBe(byId('chat-button'));
  });

  it('As a user, a message for another room does not reload the conversation I am reading', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    try {
      const { panel, service } = await loadChatModules();
      panel.initChatPanel();
      loadProduct('chatty-steady');
      const productId = labelToProductId('chatty-steady');
      const render = vi.fn(() => () => undefined);
      service.registerChatConnection(productId, {
        publish: () => Promise.resolve(),
        publishRendererAction: () => Promise.resolve(),
        render,
      });
      await service.productCreateRoom(productId, {
        roomId: 'main',
        name: 'Main',
        icon: '',
      });
      await new Promise(resolve => setTimeout(resolve, 2));
      await service.productCreateRoom(productId, {
        roomId: 'side',
        name: 'Side',
        icon: '',
      });
      await service.productPostMessage(productId, 'main', {
        tag: 'Custom',
        value: { messageType: 'poll', payload: '0x01' },
      });

      clickChat();
      await settle(() => document.querySelectorAll('[data-testid="chat-room-item"]').length === 2);
      [...document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-room-item"]')]
        .find(row => row.textContent.includes('Main'))
        ?.click();
      await settle(() => render.mock.calls.length === 1);

      await service.productPostMessage(productId, 'side', {
        tag: 'Text',
        value: { text: 'elsewhere' },
      });
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(render).toHaveBeenCalledTimes(1);
      expect(byId('chat-panel-title').textContent).toBe('Main');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("As a user, loading another product while the panel is open shows that product's contacts", async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct('first-app');
    await service.productCreateRoom(labelToProductId('first-app'), {
      roomId: 'a',
      name: 'First room',
      icon: '',
    });
    await service.productCreateRoom(labelToProductId('second-app'), {
      roomId: 'b',
      name: 'Second room',
      icon: '',
    });

    clickChat();
    await settle(() => byId('chat-panel-rooms').textContent.includes('First room'));
    document.querySelector<HTMLButtonElement>('[data-testid="chat-room-item"]')?.click();
    await settle(() => byId('chat-panel-rooms').hidden === true);

    loadProduct('second-app');
    await settle(() => byId('chat-panel-rooms').textContent.includes('Second room'));
    expect(byId('chat-panel-rooms').hidden).toBe(false);
    expect(byId('chat-panel-rooms').textContent).not.toContain('First room');
  });

  it('As a user, a failed reply keeps the message and shows why', async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct('chatty-composer-error');
    const productId = labelToProductId('chatty-composer-error');
    let denied = true;
    service.registerChatConnection(productId, {
      publish: () => Promise.reject(denied ? new Error('request denied') : new Error('boom')),
      publishRendererAction: () => Promise.resolve(),
      render: () => () => undefined,
    });
    await service.productCreateRoom(productId, {
      roomId: 'main',
      name: 'Main',
      icon: '',
    });

    clickChat();
    await settle(() => document.querySelector('[data-testid="chat-room-item"]') !== null);
    document.querySelector<HTMLButtonElement>('[data-testid="chat-room-item"]')?.click();
    await settle(() => byId('chat-panel-rooms').hidden === true);

    const input = byId('chat-panel-input', HTMLInputElement);
    const composer = byId('chat-panel-composer', HTMLFormElement);
    input.value = 'hello';
    composer.requestSubmit();
    // The hint shows as soon as the send fails, but the thread re-reads the message afterwards.
    await settle(
      () => byId('chat-panel-hint').hidden === false && byId('chat-panel-messages').textContent.includes('hello'),
    );
    expect(byId('chat-panel-hint').textContent).toBe('Log in to chat with this app.');
    expect(byId('chat-panel-messages').textContent).toContain('hello');

    denied = false;
    input.value = 'again';
    composer.requestSubmit();
    await settle(
      () =>
        byId('chat-panel-hint').textContent === 'Message saved, but the app could not be reached.' &&
        byId('chat-panel-messages').textContent.includes('again'),
    );
    expect(byId('chat-panel-messages').textContent).toContain('again');
  });

  it('As a user, opening a room focuses the composer', async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct('chatty-focus');
    const productId = labelToProductId('chatty-focus');
    await service.productCreateRoom(productId, {
      roomId: 'main',
      name: 'Main',
      icon: '',
    });

    clickChat();
    await settle(() => document.querySelector('[data-testid="chat-room-item"]') !== null);
    document.querySelector<HTMLButtonElement>('[data-testid="chat-room-item"]')?.click();
    await settle(() => document.activeElement === byId('chat-panel-input'));
    expect(document.activeElement).toBe(byId('chat-panel-input'));
  });

  it('As a user, a messages read that finishes after I closed the panel leaves the room unread', async () => {
    const { panel, service } = await loadChatModules();
    const state = await import('../src/state/chat-panel.js');
    panel.initChatPanel();
    loadProduct('chatty-late-read');
    const productId = labelToProductId('chatty-late-read');
    await service.productCreateRoom(productId, {
      roomId: 'main',
      name: 'Main',
      icon: '',
    });
    await service.productPostMessage(productId, 'main', {
      tag: 'Text',
      value: { text: 'ping' },
    });
    expect(state.chatPanelStore.get().unreadByRoom['main']).toBe(1);

    // Hold the room's message read until the panel has closed, as a slow IndexedDB read would.
    const original = service.chatMessages;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const readSpy = vi.spyOn(service, 'chatMessages').mockImplementation(async (readProductId, readRoomId) => {
      await gate;
      return original(readProductId, readRoomId);
    });
    try {
      clickChat();
      await settle(() => document.querySelector('[data-testid="chat-room-item"]') !== null);
      document.querySelector<HTMLButtonElement>('[data-testid="chat-room-item"]')?.click();
      await settle(() => byId('chat-panel-rooms').hidden === true);

      byId('chat-panel-close').click();
      flushUi();
      expect(byId('chat-panel').hidden).toBe(true);

      release?.();
      await new Promise(resolve => setTimeout(resolve, 20));

      // The late read must not mark the room seen.
      expect(state.chatPanelStore.get().unreadByRoom['main']).toBe(1);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('As a user, a render error closes the panel and the next open recovers it', async () => {
    const { panel } = await loadChatModules();
    const manifest = await import('../../shared/src/active-manifest.js');
    panel.initChatPanel();
    loadProduct('chatty-broken-render');

    // ChatPanel's title() reads this only with no room open, so failing it once throws during the first render.
    const manifestSpy = vi.spyOn(manifest, 'getActiveRootManifest').mockImplementationOnce(() => {
      throw new Error('render boom');
    });
    try {
      clickChat();
      await settle(() => byId('chat-panel').hidden === true);
      expect(byId('chat-panel').hidden).toBe(true);

      clickChat();
      await settle(() => document.getElementById('chat-panel-close') !== null);
      expect(byId('chat-panel-close')).not.toBeNull();
    } finally {
      manifestSpy.mockRestore();
    }
  });

  // Must stay last in this describe, as it resets the module registry via vi.doMock.
  it('As a user, if the chat code cannot load, the panel closes and the next open retries', async () => {
    vi.resetModules();
    let calls = 0;
    vi.doMock('../src/components/chat/ChatPanel.js', () => {
      calls += 1;
      throw new Error('chunk failed');
    });
    try {
      await loadStores();
      const panel = await loadDock();
      await mountChatButton();
      panel.initChatPanel();
      loadProduct('chatty-broken');

      clickChat();
      await settle(() => calls === 1 && byId('chat-panel').hidden === true);

      clickChat();
      await settle(() => calls === 2 && byId('chat-panel').hidden === true);
    } finally {
      vi.doUnmock('../src/components/chat/ChatPanel.js');
      vi.resetModules();
    }
  });
});
