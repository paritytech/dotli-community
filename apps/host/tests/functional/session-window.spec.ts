// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product signs in and out through the sign-in window on the root origin, while the landing page pairs on the page
// itself and never opens the window. Chromium shares the frame's storage across `*.localhost`, so every page's
// copy is the main store here: a stale copy is made by deleting the signed-in flag under a stored sign-in, and the
// window's Continue is reached from the opener fixture page, since a signed-in dotli page never opens the window. The
// recovery phrase signs in, as pairing needs a phone, and the window takes it only as the debug panel asks for it: at
// the phrase intent in the window's request.

import { expect, type APIRequestContext, type Frame, type Page } from '@playwright/test';
import { DOMAIN, NETWORK, PORT, TIMEOUT_MS } from '../env.js';
import { getProductFrame } from '../product-frame.js';
import { requestUrl } from '../../src/runtime/session-handoff/session-protocol.js';
import { seedSettings } from './fixtures/settings.js';
import { isProtocolFrameUrl, ROOT_ORIGIN, waitForFrame } from './helpers/frames.js';
import {
  DEV_PHRASE,
  openerOutcome,
  openPhraseWindow,
  openSessionWindow,
  serveSessionOpener,
  serveSiteOpener,
  serveSiteRedirect,
  sessionWindow,
  SITE_ORIGIN,
  SITE_RETURN_URL,
  siteReply,
  submitPhraseInWindow,
  untilClosed,
} from './helpers/session-window.js';
import {
  clearSessionFlag,
  disableTruapiDebugPanel,
  readSessionFlag,
  setSessionFlag,
  test,
} from './helpers/shared-mode-reset.js';

const LANDING_URL = `${ROOT_ORIGIN}/`;
const PRODUCT_URL = `http://browse.localhost:${PORT}/`;
/** The window opened on its own at its recovery phrase view, as the debug panel's wallet tab asks for it. */
const PHRASE_WINDOW_URL = requestUrl(ROOT_ORIGIN, 'auth', {
  v: 1,
  net: NETWORK,
  round: crypto.randomUUID(),
  intent: 'phrase',
});
/** An origin the window serves: a product host on the root domain. */
const OPENER_ORIGIN = `http://opener.localhost:${PORT}`;
/** An origin the window refuses, as a product's own sandbox. */
const SANDBOX_ORIGIN = `http://x.app.localhost:${PORT}`;
/** The main store's paired session and its cached account, under the local site id the frame keys them by. */
const STORED_SESSION_KEY = 'TRUAPI_local.li_session';
const STORED_UI_STATE_KEY = 'TRUAPI_local.li_session:ui-state';
const STORED_ACCOUNT = { connected: true, publicKey: '0x01', liteUsername: 'alice.01' };
/** The site list, which reads the grants on the root origin. */
const SITE_LIST_URL = `${ROOT_ORIGIN}/s/manage`;

test.setTimeout(TIMEOUT_MS * 4);

// The gateway opens no socket until a chain is asked for, so nothing here waits on a light client. Through the
// context, so the windows a test opens boot on it too.
test.beforeEach(async ({ context }) => {
  await seedSettings(context, { backend: 'rpc-gateway' });
});

function signInButton(page: Page) {
  return page.getByRole('button', { name: 'Sign in with Polkadot App' });
}

/** The account button of a signed-out page while the flag says a sign-in made elsewhere waits. */
function continueButton(page: Page) {
  return page.getByRole('button', { name: 'Continue session' });
}

/** Waits for the landing page's islands to take over their markup, so a click reaches the account button's handler. */
async function openLanding(page: Page): Promise<void> {
  await page.goto(LANDING_URL);
  await page.waitForFunction(() => document.querySelectorAll('astro-island[ssr]').length === 0);
}

/**
 * Opens a product signed out, once its account button offers a sign-in. With `debug`, the debug panel shows, whose
 * wallet tab opens the window at its recovery phrase view.
 */
async function openProduct(page: Page, options: { debug?: boolean } = {}): Promise<void> {
  await page.goto(options.debug === true ? `${PRODUCT_URL}?debug=true` : PRODUCT_URL);
  await expect(signInButton(page)).toBeVisible({ timeout: TIMEOUT_MS });
}

/**
 * Signs in on a product with the recovery phrase, which stores a local wallet in the main store. The window takes a
 * phrase only when the debug panel asks for one, as pairing needs a phone.
 */
async function signInOnProduct(page: Page): Promise<void> {
  await openProduct(page, { debug: true });
  const window = await openPhraseWindow(page);
  await Promise.all([page.waitForEvent('load'), submitPhraseInWindow(window)]);
  await expect(page.getByTestId('user-badge')).toHaveAttribute('data-wallet', 'local', { timeout: TIMEOUT_MS });
}

/** A paired sign-in in the main store with its flag, which a product page loads into. */
async function signInPairedOnProduct(page: Page, request: APIRequestContext): Promise<void> {
  await openProduct(page);
  await storePairedSignIn(await waitForFrame(page, isProtocolFrameUrl, TIMEOUT_MS));
  await setSessionFlag(request);
  await page.reload();
  await expect(page.getByTestId('user-badge')).toBeVisible({ timeout: TIMEOUT_MS });
}

/** Marks the document, so a test can tell it was not reloaded: the mark survives only as long as the document. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset['testNoReload'] = '1';
  });
}

/** Every window `page` opens from now on, so a test can say none opened. */
function recordWindows(page: Page): Page[] {
  const windows: Page[] = [];
  page.on('popup', window => {
    windows.push(window);
  });
  return windows;
}

/**
 * A grant for the site fixture's origin, written into the grants database through the page's IndexedDB. The page's
 * own first read creates that database, so a caller waits for that read to end first.
 */
async function seedSiteGrant(page: Page): Promise<void> {
  await page.evaluate(async origin => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('dotli-site-grants', 1);
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(open.error ?? new Error('The grants database did not open'));
      };
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('grants', 'readwrite');
      const now = Date.now();
      tx.objectStore('grants').put({
        token: 'functional-test-token',
        origin,
        publicKey: '0x01',
        owner: '0x02',
        firstUsedAt: now,
        lastUsedAt: now,
      });
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('The grant was not written'));
      };
    });
    db.close();
  }, SITE_ORIGIN);
}

/** A paired sign-in and its cached account in the main store, written through a document on the root origin. */
async function storePairedSignIn(target: Frame): Promise<void> {
  await target.evaluate(
    ([sessionKey, uiStateKey, account]) => {
      localStorage.setItem(sessionKey, '0x0102');
      localStorage.setItem(uiStateKey, JSON.stringify(account));
    },
    [STORED_SESSION_KEY, STORED_UI_STATE_KEY, STORED_ACCOUNT] as const,
  );
}

test.describe('Signing in on the landing page', () => {
  test('As a visitor on the landing page, I sign in on the page itself and no window opens', async ({ page }) => {
    // Given the landing page open with its windows recorded
    await openLanding(page);
    const windows = recordWindows(page);

    // When the user presses Sign in
    await signInButton(page).click();

    // Then the code shows on the page and no window opened
    const canvas = page.getByTestId('auth-modal-qr-tile').locator('canvas');
    await expect(canvas).toHaveAttribute('data-qr-payload', /^polkadotapp:\/\//, { timeout: TIMEOUT_MS });
    await expect(page.getByTestId('auth-modal-window')).toHaveCount(0);
    expect(windows).toEqual([]);
  });

  test('As a visitor whose paired sign-in another page stored, I load the landing page and see my account with no window', async ({
    page,
    request,
  }) => {
    // Given a paired sign-in stored in the main store by another page
    await openLanding(page);
    await storePairedSignIn(page.mainFrame());
    await setSessionFlag(request);
    const windows = recordWindows(page);

    // When the landing page reloads
    await page.reload();

    // Then the account shows and no window opened
    await expect(page.getByTestId('landing-auth-button')).toContainText('alice.01', { timeout: TIMEOUT_MS });
    expect(windows).toEqual([]);
  });

  test('As a visitor on the landing page with a flag over an empty main store, I open it and am offered a plain sign-in', async ({
    page,
    request,
  }) => {
    // Given the flag set over an empty main store
    await setSessionFlag(request);

    // When the landing page opens
    await openLanding(page);

    // Then Sign in shows and Continue does not
    await expect(signInButton(page)).toBeVisible({ timeout: TIMEOUT_MS });
    await expect(continueButton(page)).toHaveCount(0);
  });

  test('As a user signed in with a local wallet beside a paired session, I sign out on the landing page, no window opens and every app is signed out', async ({
    page,
    context,
    request,
  }) => {
    // Given a local wallet and a paired session kept beside it in the main store
    await signInOnProduct(page);
    const landing = await context.newPage();
    await openLanding(landing);
    await expect(landing.getByTestId('user-badge')).toHaveAttribute('data-wallet', 'local', { timeout: TIMEOUT_MS });
    await storePairedSignIn(landing.mainFrame());
    const windows = recordWindows(landing);

    // When the user signs out from the account menu
    await landing.getByTestId('landing-auth-button').click();
    await Promise.all([
      landing.waitForEvent('load'),
      landing.getByRole('button', { name: 'Sign out', exact: true }).click(),
    ]);

    // Then the main store holds nothing, the flag is gone and no window opened
    await expect(signInButton(landing)).toBeVisible({ timeout: TIMEOUT_MS });
    await expect(landing.getByTestId('user-badge')).toHaveCount(0);
    expect(await landing.evaluate(key => localStorage.getItem(key), STORED_SESSION_KEY)).toBeNull();
    expect(await readSessionFlag(request)).toBe(false);
    expect(windows).toEqual([]);

    // Then a product is signed out too
    await page.reload();
    await expect(signInButton(page)).toBeVisible({ timeout: TIMEOUT_MS });
    await expect(page.getByTestId('user-badge')).toHaveCount(0);
  });
});

test.describe('Signing in through the window', () => {
  test('As a signed-out user on a product, I press Sign in and the sign-in window shows the code for that product', async ({
    page,
  }) => {
    // Given a product open
    await openProduct(page);

    // When the user presses Sign in
    const window = await openSessionWindow(page, () => signInButton(page).click());

    // Then the window pairs under the product's host
    await expect(sessionWindow(window)).toHaveAttribute('data-view', 'pairing', { timeout: TIMEOUT_MS });
    await expect(window.getByText(`browse.localhost:${PORT}`)).toBeVisible();
  });

  test('As a signed-out user on a product, I sign in through the sign-in window and see my account', async ({
    page,
  }) => {
    // Given a product open with the debug panel
    await openProduct(page, { debug: true });

    // When the user signs in with a phrase in the window
    const window = await openPhraseWindow(page);
    await Promise.all([page.waitForEvent('load'), submitPhraseInWindow(window)]);

    // Then the product shows the local wallet account
    await expect(page.getByTestId('user-badge')).toHaveAttribute('data-wallet', 'local', { timeout: TIMEOUT_MS });
  });

  test('As a user signed in on one page, I continue with my account from another through the sign-in window', async ({
    page,
    context,
  }) => {
    // Given a product signed in and an opener page on another product host
    await signInOnProduct(page);
    const opener = await context.newPage();
    await opener.goto(await serveSessionOpener(opener, OPENER_ORIGIN));

    // When the opener opens the window and the user presses Continue
    const window = await openSessionWindow(opener, () => opener.getByTestId('opener-sign-in').click());
    await expect(sessionWindow(window)).toHaveAttribute('data-view', 'continue', { timeout: TIMEOUT_MS });
    await expect(window.getByTestId('session-window-local')).toBeVisible();
    await Promise.all([untilClosed(window), window.getByTestId('session-window-continue-button').click()]);

    // Then the opener receives the local wallet without a paired session
    await expect(openerOutcome(opener)).toHaveAttribute('data-outcome', 'result');
    await expect(openerOutcome(opener)).toHaveAttribute('data-wallet', 'true');
    await expect(openerOutcome(opener)).toHaveAttribute('data-session', 'false');
  });

  test('As a user on a product, I continue with a paired account and see it at once', async ({ page, request }) => {
    // Given a product that loaded signed out, and a paired sign-in stored since by another page, written here through
    // the protocol frame, whose document is on the root origin
    await openProduct(page);
    await storePairedSignIn(await waitForFrame(page, isProtocolFrameUrl, TIMEOUT_MS));
    await setSessionFlag(request);
    await markDocument(page);

    // When the user opens the window and presses Continue
    const window = await openSessionWindow(page, () => signInButton(page).click());
    await expect(sessionWindow(window)).toHaveAttribute('data-view', 'continue', { timeout: TIMEOUT_MS });
    await Promise.all([untilClosed(window), window.getByTestId('session-window-continue-button').click()]);

    // Then the account shows with no reload
    await expect(page.getByTestId('user-badge')).toBeVisible({ timeout: TIMEOUT_MS });
    await expect(page.locator('html')).toHaveAttribute('data-test-no-reload', '1');
  });

  test('As a user on a product whose sign-in made elsewhere waits, I press Continue session and see my account at once', async ({
    page,
    request,
  }) => {
    // Given the flag set over an empty copy, as a product in Safari finds it after a sign-in on another product, and a
    // paired sign-in stored since in the main store, which this page did not hear of
    await setSessionFlag(request);
    await page.goto(PRODUCT_URL);
    await expect(continueButton(page)).toBeVisible({ timeout: TIMEOUT_MS });
    await storePairedSignIn(await waitForFrame(page, isProtocolFrameUrl, TIMEOUT_MS));
    await markDocument(page);

    // When the window opens, it sends the stored sign-in and closes with no Continue to press
    const window = await openSessionWindow(page, () => continueButton(page).click());
    await untilClosed(window);

    // Then the account shows with no reload
    await expect(page.getByTestId('user-badge')).toBeVisible({ timeout: TIMEOUT_MS });
    await expect(page.locator('html')).toHaveAttribute('data-test-no-reload', '1');
  });

  test('As a user on a product who reloads the sign-in window, I still sign in through it', async ({ page }) => {
    // Given a phrase window open from a product
    await openProduct(page, { debug: true });
    const window = await openPhraseWindow(page);
    await expect(sessionWindow(window)).toHaveAttribute('data-view', 'phrase', { timeout: TIMEOUT_MS });

    // When the window reloads and the user signs in with a phrase
    await window.reload();
    await Promise.all([page.waitForEvent('load'), submitPhraseInWindow(window)]);

    // Then the product shows the local wallet account
    await expect(page.getByTestId('user-badge')).toHaveAttribute('data-wallet', 'local', { timeout: TIMEOUT_MS });
  });

  test('As a user who opens the sign-in window on its own, I sign in there and am told to return to the app', async ({
    page,
    request,
  }) => {
    // Given the sign-in window opened directly at its phrase view
    await page.goto(PHRASE_WINDOW_URL);
    await expect(sessionWindow(page)).toHaveAttribute('data-view', 'phrase', { timeout: TIMEOUT_MS });

    // When the user signs in with a phrase
    await page.getByTestId('session-window-phrase-input').fill(DEV_PHRASE);
    await page.getByTestId('session-window-phrase-submit').click();

    // Then the window says to return to the app and the flag is set
    await expect(sessionWindow(page)).toHaveAttribute('data-view', 'done-no-opener', { timeout: TIMEOUT_MS });
    expect(await readSessionFlag(request)).toBe(true);
  });

  test('As a signed-out user, I am asked to sign in by a product and its Sign in opens the window', async ({
    page,
  }) => {
    // Given a product page with its frame loaded
    await page.goto(`http://${DOMAIN}.localhost:${PORT}/`);
    const product = await getProductFrame(page, TIMEOUT_MS);

    // When the product asks for a login and the user presses Sign in on the prompt
    await product.getByTestId('run-request-login').click();
    const modal = page.getByTestId('auth-modal-window');
    await expect(modal).toHaveAttribute('data-view', 'prompt', { timeout: TIMEOUT_MS });
    const window = await openSessionWindow(page, () => page.getByTestId('auth-modal-window-signin').click());

    // Then the modal waits and the window pairs under the product's host
    await expect(modal).toHaveAttribute('data-view', 'window');
    await expect(sessionWindow(window)).toHaveAttribute('data-view', 'pairing', { timeout: TIMEOUT_MS });
    await expect(window.getByText(`${DOMAIN}.localhost:${PORT}`)).toBeVisible();
  });
});

test.describe('Signing in through the window fails', () => {
  test('As a user whose browser blocks the sign-in window, I am told so and offered another try', async ({
    playwright,
    launchOptions,
  }) => {
    // Given: a browser that opens no window, as one that blocks pop-ups
    const browser = await playwright.chromium.launch({
      ...launchOptions,
      args: [...(launchOptions.args ?? []), '--block-new-web-contents'],
    });
    try {
      const context = await browser.newContext();
      await seedSettings(context, { backend: 'rpc-gateway' });
      await disableTruapiDebugPanel(context);
      const page = await context.newPage();
      await openProduct(page);

      // When the user presses Sign in
      await signInButton(page).click();

      // Then the blocked view shows with a retry
      await expect(page.getByTestId('auth-modal-window')).toHaveAttribute('data-view', 'blocked');
      await expect(page.getByTestId('auth-modal-window-retry')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('As a user on a product, I close the wait for the sign-in window and the window closes too', async ({
    page,
  }) => {
    // Given a product waiting on an open sign-in window
    await openProduct(page);
    const backdrop = page.getByTestId('auth-modal-backdrop');
    const window = await openSessionWindow(page, () => signInButton(page).click());
    await expect(backdrop).toHaveAttribute('data-open');
    await expect(page.getByTestId('auth-modal-window')).toHaveAttribute('data-view', 'window');

    // When the user closes the wait
    await Promise.all([untilClosed(window), page.getByTestId('auth-modal-close').click()]);

    // Then the modal closes
    await expect(backdrop).not.toHaveAttribute('data-open');
  });

  test('As a user, I close the sign-in window and the page stops waiting and stays signed out', async ({ page }) => {
    // Given a product with its sign-in window pairing
    await openProduct(page);
    const window = await openSessionWindow(page, () => signInButton(page).click());
    await expect(sessionWindow(window)).toHaveAttribute('data-view', 'pairing', { timeout: TIMEOUT_MS });

    // When I close it and come back to the page, which finds its window closed, as only the window's handle says it is
    // gone. The browser reports the window closed before the page's handle reads closed, and a return the page hears
    // in between waits for the next, so I come back until the page stops waiting. A headless page that never hides can
    // only be told it is visible again.
    await window.close({ runBeforeUnload: true });
    await untilClosed(window);
    const backdrop = page.getByTestId('auth-modal-backdrop');
    await expect
      .poll(async () => {
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        return backdrop.getAttribute('data-open');
      })
      .toBeNull();

    // Then the modal closes and Sign in shows
    await expect(backdrop).not.toHaveAttribute('data-open');
    await expect(signInButton(page)).toBeVisible();
  });

  test('As a page on a product sandbox origin, I open the sign-in window and it refuses me while both sides say so', async ({
    page,
  }) => {
    // Given an opener page on a product sandbox origin
    await page.goto(await serveSessionOpener(page, SANDBOX_ORIGIN));

    // When it opens the sign-in window
    const window = await openSessionWindow(page, () => page.getByTestId('opener-sign-in').click());

    // Then the window shows refused and the opener heard refused
    await expect(sessionWindow(window)).toHaveAttribute('data-view', 'refused', { timeout: TIMEOUT_MS });
    await expect(openerOutcome(page)).toHaveAttribute('data-outcome', 'refused');
    await expect(openerOutcome(page)).toHaveAttribute('data-reply', 'reason round type');
  });
});

test.describe('Signing a site in', () => {
  test('As a site, I open the sign-in window, the user cancels on the consent screen and I get refused with declined', async ({
    page,
  }) => {
    // Given a site's page on its own https origin, whose sign-in window asks the user's consent under its full origin
    await page.goto(await serveSiteOpener(page));
    const window = await openSessionWindow(page, () => page.getByTestId('opener-sign-in').click());
    await expect(sessionWindow(window)).toHaveAttribute('data-view', 'consent', { timeout: TIMEOUT_MS });
    await expect(window.getByTestId('session-window-title')).toHaveText(SITE_ORIGIN);

    // When the user cancels on the consent screen
    await Promise.all([untilClosed(window), window.getByTestId('session-window-decline').click()]);

    // Then the window closed and the site was refused as declined
    expect(window.isClosed()).toBe(true);
    await expect(siteReply(page)).toHaveAttribute('data-type', 'dotli:s:refused');
    await expect(siteReply(page)).toHaveAttribute('data-reason', 'declined');
  });
});

test.describe('Signing a site in by redirect', () => {
  test('As a site that cannot keep a popup, I sign in by redirect, the user cancels on the consent screen and I get back refused with declined', async ({
    page,
  }) => {
    // Given a site whose well-known file lists its return address, which goes to the sign-in window in its own tab
    await page.goto(await serveSiteRedirect(page));
    await page.getByTestId('opener-sign-in').click();
    await expect(sessionWindow(page)).toHaveAttribute('data-view', 'consent', { timeout: TIMEOUT_MS });
    await expect(page.getByTestId('session-window-title')).toHaveText(SITE_ORIGIN);

    // When the user cancels on the consent screen
    await page.getByTestId('session-window-decline').click();

    // Then the tab is back on the return address, whose sealed answer opens to a refusal as declined
    await expect(siteReply(page)).toHaveAttribute('data-type', 'dotli:s:refused', { timeout: TIMEOUT_MS });
    await expect(siteReply(page)).toHaveAttribute('data-reason', 'declined');
    expect(page.url().split('#')[0]).toBe(SITE_RETURN_URL);
  });

  test('As a site whose well-known file does not list my return address, I sign in by redirect and the window says I did not allow it', async ({
    page,
  }) => {
    // Given a site whose well-known file lists another address
    await page.goto(await serveSiteRedirect(page, { listed: false }));

    // When it goes to the sign-in window by redirect
    await page.getByTestId('opener-sign-in').click();

    // Then the window stays, saying the site did not allow this return address
    await expect(sessionWindow(page)).toHaveAttribute('data-view', 'site-not-allowed', { timeout: TIMEOUT_MS });
    expect(new URL(page.url()).pathname).toBe('/s/auth');
  });
});

test.describe("Signing a site's transaction", () => {
  test('As a site, I open the sign window without a grant, the user cancels on the consent screen and I get refused with declined', async ({
    page,
  }) => {
    // Given a site's page on its own https origin, whose sign window asks the user's consent under its full origin
    await page.goto(await serveSiteOpener(page, { route: 'sign' }));
    const window = await openSessionWindow(page, () => page.getByTestId('opener-sign-in').click());
    await expect(sessionWindow(window)).toHaveAttribute('data-view', 'consent', { timeout: TIMEOUT_MS });
    await expect(window.getByTestId('session-window-title')).toHaveText(SITE_ORIGIN);

    // When the user cancels on the consent screen
    await Promise.all([untilClosed(window), window.getByTestId('session-window-decline').click()]);

    // Then the window closed and the site was refused as declined
    expect(window.isClosed()).toBe(true);
    await expect(siteReply(page)).toHaveAttribute('data-type', 'dotli:s:refused');
    await expect(siteReply(page)).toHaveAttribute('data-reason', 'declined');
  });

  test("As dot.li's own page, I open the sign window and am refused as a bad request", async ({ page }) => {
    // Given a page on a product host of the root domain that asks for a transaction as a site would
    await page.goto(await serveSiteOpener(page, { origin: OPENER_ORIGIN, route: 'sign' }));

    // When it opens the sign window
    const window = await openSessionWindow(page, () => page.getByTestId('opener-sign-in').click());

    // Then the window shows refused and the page was refused as a bad request
    await expect(sessionWindow(window)).toHaveAttribute('data-view', 'refused', { timeout: TIMEOUT_MS });
    await expect(siteReply(page)).toHaveAttribute('data-type', 'dotli:s:refused');
    await expect(siteReply(page)).toHaveAttribute('data-reason', 'bad_request');
  });
});

test.describe('The signed-in sites', () => {
  test('As a user who signed in to a site, I open the site list, see that site and revoke it, and the list is empty', async ({
    page,
  }) => {
    // Given the site list on the root origin, whose first read ended and so created the grants database, which then
    // gets one site's grant
    await page.goto(SITE_LIST_URL);
    await expect(sessionWindow(page)).toHaveAttribute('data-view', 'sites', { timeout: TIMEOUT_MS });
    await seedSiteGrant(page);
    await page.reload();
    await expect(page.getByTestId('session-window-site-origin')).toHaveText(SITE_ORIGIN, { timeout: TIMEOUT_MS });

    // When the user revokes that site
    await page.getByTestId('session-window-site-revoke').click();

    // Then the list says no site uses the sign-in
    await expect(page.getByTestId('session-window-sites-empty')).toBeVisible({ timeout: TIMEOUT_MS });
    await expect(page.getByTestId('session-window-site')).toHaveCount(0);
  });
});

test.describe('Signing out', () => {
  test('As a signed-in user, I sign out on a product and every page is signed out', async ({
    page,
    context,
    request,
  }) => {
    // Given two product pages signed in with a local wallet
    await signInOnProduct(page);
    const product = await context.newPage();
    await product.goto(PRODUCT_URL);
    await expect(product.getByTestId('user-badge')).toHaveAttribute('data-wallet', 'local', { timeout: TIMEOUT_MS });

    // When the user signs out on one of them
    await product.getByTestId('auth-button').click();
    const [window] = await Promise.all([
      product.waitForEvent('popup'),
      product.waitForEvent('load'),
      product.getByRole('button', { name: 'Sign out', exact: true }).click(),
    ]);

    // Then the window closes, the page shows Sign in and the flag is gone
    await untilClosed(window);
    await expect(signInButton(product)).toBeVisible({ timeout: TIMEOUT_MS });
    expect(await readSessionFlag(request)).toBe(false);

    // Then the first tab, left open and never focused, hears its wallet go and shows signed out
    await expect(signInButton(page)).toBeVisible({ timeout: TIMEOUT_MS });
    await expect(page.getByTestId('user-badge')).toHaveCount(0);

    // Then: with the flag back, a page shows only what the main store still holds, which is nothing, and offers to
    // continue the sign-in the flag claims
    await setSessionFlag(request);
    await page.reload();
    await expect(continueButton(page)).toBeVisible({ timeout: TIMEOUT_MS });
    await expect(page.getByTestId('user-badge')).toHaveCount(0);
  });

  test('As a user signed out elsewhere, I load a page and it drops its stale copy and shows me signed out', async ({
    page,
    context,
    request,
  }) => {
    // Given: a paired sign-in whose flag is gone, as a product's copy after a sign-out on another
    await signInPairedOnProduct(page, request);
    await clearSessionFlag(request);

    // When a product page loads
    const product = await context.newPage();
    await product.goto(PRODUCT_URL);

    // Then it shows signed out
    await expect(signInButton(product)).toBeVisible({ timeout: TIMEOUT_MS });
    await expect(product.getByTestId('user-badge')).toHaveCount(0);
  });

  test('As a user signed out elsewhere, I come back to a page left open and it drops its copy', async ({
    page,
    request,
  }) => {
    // Given a paired sign-in on a product whose flag another page deleted
    await signInPairedOnProduct(page, request);
    await clearSessionFlag(request);

    // When: the tab becomes visible again, which a headless page that never hides can only be told
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    // Then the page shows signed out
    await expect(signInButton(page)).toBeVisible({ timeout: TIMEOUT_MS });
    await expect(page.getByTestId('user-badge')).toHaveCount(0);
  });

  test('As a developer on a local wallet whose flag is gone, I come back to a page left open and load another and both keep me signed in on it', async ({
    page,
    context,
    request,
  }) => {
    // Given a local wallet sign-in on a product whose flag another page deleted
    await signInOnProduct(page);
    await clearSessionFlag(request);

    // When the open tab checks again, and another page loads
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const product = await context.newPage();
    await product.goto(PRODUCT_URL);

    // Then only a sign-out forgets the wallet
    await expect(product.getByTestId('user-badge')).toHaveAttribute('data-wallet', 'local', { timeout: TIMEOUT_MS });
    await expect(page.getByTestId('user-badge')).toHaveAttribute('data-wallet', 'local');
  });
});
