// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test as base } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Qualification, framebuffer, pixelDifference, wireFrames } from './helpers/polkavm-qualification.js';

// Fresh browser/profile per story: no caches, storage or consent cross campaigns.
// noDefaults is essential: ordinary Playwright contexts force every tab visible.
const test = base.extend({
  context: async ({ playwright, launchOptions, headless }, use) => {
    if (headless) {
      throw new Error('Qualification requires HEADED=1 and a real display (or Xvfb)');
    }
    const launched = await playwright.chromium.launch({
      ...launchOptions,
      headless,
      args: [...(launchOptions.args ?? []), '--enable-automation', '--remote-debugging-port=0'],
    });
    try {
      const session = await launched.newBrowserCDPSession();
      const { arguments: arguments_ } = await session.send('Browser.getBrowserCommandLine');
      const profileArgument = arguments_.find(argument => argument.startsWith('--user-data-dir='));
      if (profileArgument === undefined) {
        throw new Error('Chromium profile path is absent');
      }
      const endpoint = await readFile(
        join(profileArgument.slice('--user-data-dir='.length), 'DevToolsActivePort'),
        'utf8',
      );
      const port = endpoint.split('\n')[0];
      if (port === undefined || !/^\d+$/.test(port)) {
        throw new Error('Chromium CDP port is absent');
      }
      const connected = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
      const context = connected.contexts()[0];
      if (context === undefined) {
        throw new Error('Chromium default context is absent');
      }
      await use(context);
    } finally {
      await launched.close();
    }
  },
});
test('As a product user, I complete a handshake and write, read and clear private storage through the real SDK', async ({
  page,
}, info) => {
  // Given
  const run = await Qualification.open(page, info, 'playground');
  try {
    await expect(run.canvas).toHaveAttribute('data-polkavm-profile', 'tri2d');

    // When: source-backed egui coordinates relative to the canvas at a 780x700 viewport.
    await run.canvas.click({ position: { x: 470, y: 276 } });
    await run.until('real handshake response', async () =>
      wireFrames(await run.workers()).some(
        frame => frame.direction === 'response' && frame.trait === 1 && frame.method === 0,
      ),
    );

    // Then: canonical Result::Ok + V1, correlated with the guest request (not a readiness echo).
    let frames = wireFrames(await run.workers());
    const handshake = frames.find(frame => frame.direction === 'request' && frame.trait === 1 && frame.method === 0);
    expect(handshake).toMatchObject({ type: 0 });
    expect(frames.find(frame => frame.direction === 'response' && frame.id === handshake?.id)).toMatchObject({
      trait: 1,
      method: 0,
      type: 1,
      payload: [0, 0],
    });
    await run.screenshot('handshake-completed');

    // When
    await run.canvas.click({ position: { x: 85, y: 155 } }); // Methods
    const navigationFrame = Number(await run.canvas.getAttribute('data-polkavm-frames'));
    await run.until(
      'methods view is presented',
      async () => Number(await run.canvas.getAttribute('data-polkavm-frames')) > navigationFrame + 1,
    );
    await run.canvas.click({ position: { x: 475, y: 262 } }); // Run write/read/clear round trip
    await run.until('guest completes storage round trip', async () =>
      wireFrames(await run.workers()).some(
        frame => frame.direction === 'response' && frame.trait === 7 && frame.method === 2,
      ),
    );

    // Then: the guest only issues clear after comparing the returned value with its original bytes.
    frames = wireFrames(await run.workers());
    const key = [...Buffer.from('pvm-truapi-playground/round-trip')];
    const value = [...Buffer.from('PolkaVM + egui + canonical TrUAPI')];
    const requests = frames.filter(frame => frame.direction === 'request' && frame.trait === 7);
    expect(requests.map(frame => frame.method)).toEqual([1, 0, 2]);
    expect(requests[0]?.payload).toEqual([0, key.length << 2, ...key, value.length << 2, ...value]);
    expect(requests[2]?.payload).toEqual([0, key.length << 2, ...key]);
    for (const request of requests) {
      const response = frames.find(frame => frame.direction === 'response' && frame.id === request.id);
      expect(response).toMatchObject({ trait: 7, method: request.method, type: 1 });
      if (request.method === 0) {
        // Both response envelope versions have the same Option<Vec<u8>> payload.
        expect([0, 1]).toContain(response?.payload[1]);
        expect(response?.payload).toEqual([0, response?.payload[1], 1, value.length << 2, ...value]);
      } else {
        expect(response?.payload).toEqual([0, 0]);
      }
    }
    await run.screenshot('storage-write-read-clear-completed');
    await run.evidence('real-sdk-round-trip');
    expect((await run.workers()).flatMap(worker => worker.errors)).toEqual([]);
  } finally {
    await run.finish();
  }
});

for (const campaign of ['freedoom1', 'freedoom2'] as const) {
  test(`As a ${campaign} player, I play the correct campaign, control file consent and resume the same running game`, async ({
    page,
    context,
  }, info) => {
    // Given
    const run = await Qualification.open(page, info, campaign);
    try {
      const mountPath = `game/${campaign}.wad`;
      expect(run.fixture.mountPath).toBe(mountPath);
      const workers = await run.workers();
      expect(workers).toHaveLength(1);
      expect(workers[0]?.starts[0]?.assets.filter(asset => asset.path.endsWith('.wad'))).toEqual([
        { path: mountPath, sha256: run.index.uploads[campaign].sha256 },
      ]);
      await expect(run.canvas).toHaveAttribute('data-polkavm-profile', 'framebuffer');
      await expect(run.canvas).toHaveAttribute('width', '640');
      await expect(run.canvas).toHaveAttribute('height', '400');

      // When: Escape opens the native Doom menu; selecting New Game, episode (Phase 1) and skill starts play.
      await run.canvas.focus();
      await page.keyboard.press('Escape');
      await delay(250);
      const menu = await framebuffer(run.frame);
      expect(new Set(menu).size, 'The actual menu has rendered colored pixels').toBeGreaterThan(16);
      await run.screenshot(`${campaign}-native-menu`);
      await page.keyboard.press('Enter');
      await delay(150);
      await page.keyboard.press('Enter');
      if (campaign === 'freedoom1') {
        await delay(150);
        await page.keyboard.press('Enter');
      }
      await run.until(
        'level replaces native menu',
        async () => pixelDifference(menu, await framebuffer(run.frame)) > 0.25,
      );
      // Allow the level's screen-wipe to finish before measuring input-driven world movement.
      await delay(1500);
      const standing = await framebuffer(run.frame);
      await page.keyboard.down('ArrowRight');
      await delay(700);
      await page.keyboard.up('ArrowRight');
      const turned = await framebuffer(run.frame);

      // Then: visible world changes under input, not merely a frame counter increment.
      expect(pixelDifference(standing, turned), 'Turning changes the rendered world').toBeGreaterThan(0.1);
      await expect(run.canvas).toHaveAttribute('data-polkavm-audio-nonzero', 'true', { timeout: 15_000 });
      await run.until('audio output is running after real user activation', async () =>
        run.frame.evaluate(() => window.__polkavmQualification.audio.some(audio => audio.state === 'running')),
      );
      await run.screenshot(`${campaign}-playing-after-turn`);
      await run.evidence(`${campaign}-cold-gameplay`);

      // When: a cancelled file grant must not restart or replace the live game.
      const upload = await run.upload();
      const originalCanvas = await run.canvas.elementHandle();
      await run.frame.locator('#dotli-polkavm-menu-open').click();
      await run.frame.locator('input[type=file]').setInputFiles(upload);
      await expect(run.frame.locator('.dotli-file-consent-backdrop')).toBeVisible();
      await run.screenshot(`${campaign}-file-consent`);
      await run.frame.locator('.dotli-file-consent-cancel').click();

      // Then
      await expect(run.frame.locator('.dotli-file-consent-backdrop')).toHaveCount(0);
      expect((await run.workers()).map(worker => ({ id: worker.id, terminated: worker.terminated }))).toEqual([
        { id: workers[0]?.id, terminated: false },
      ]);
      await expect(run.canvas).toHaveAttribute('data-polkavm-cache-hit', 'false');
      expect(await originalCanvas.evaluate(element => element.isConnected)).toBe(true);
      await originalCanvas.dispose();

      // When: consent grants precisely this campaign's bytes at its correct IWAD mount.
      await run.frame.locator('input[type=file]').setInputFiles(upload);
      await run.frame.locator('.dotli-file-consent-approve').click();
      await run.until('approved file starts a replacement worker', async () => (await run.workers()).length === 2);
      await run.ready(true);

      // Then: compiled code is reused, but the old worker is gone and the mount remains correct.
      const restarted = await run.workers();
      expect(restarted[0]?.terminated).toBe(true);
      expect(restarted[1]?.terminated).toBe(false);
      expect(restarted[1]?.starts[0]?.assets.filter(asset => asset.path.endsWith('.wad'))).toEqual([
        { path: mountPath, sha256: run.index.uploads[campaign].sha256 },
      ]);
      await expect.poll(() => run.liveWorkers.size).toBe(1);
      await run.evidence(`${campaign}-approved-warm-restart`);

      // When: a real second browser tab takes foreground ownership. No synthetic visibility event.
      const activeWorker = [...run.liveWorkers][0];
      const other = await context.newPage();
      try {
        await other.goto('about:blank');
        await other.bringToFront();
        await run.until(
          'real tab becomes hidden (run with HEADED=1)',
          async () => run.frame.evaluate(() => document.visibilityState === 'hidden'),
          10_000,
        );
        await expect(run.canvas).toHaveAttribute('data-polkavm-paused', 'true');
        await run.until(
          'worker acknowledges background',
          async () => (await run.workers()).at(-1)?.background.at(-1) === true,
        );
        const paused = await run.canvas.evaluate(element => ({
          frames: element.getAttribute('data-polkavm-frames'),
          audio: element.getAttribute('data-polkavm-audio-chunks'),
        }));
        await delay(600);
        expect(
          await run.canvas.evaluate(element => ({
            frames: element.getAttribute('data-polkavm-frames'),
            audio: element.getAttribute('data-polkavm-audio-chunks'),
          })),
        ).toEqual(paused);
        expect(
          await run.frame.evaluate(() => window.__polkavmQualification.audio.every(audio => audio.state !== 'running')),
        ).toBe(true);
        await run.evidence(`${campaign}-background-paused`);
        await page.bringToFront();
        await run.until('real tab becomes visible', async () =>
          run.frame.evaluate(() => document.visibilityState === 'visible'),
        );
        await expect(run.canvas).toHaveAttribute('data-polkavm-paused', 'false');
        await run.until(
          'worker acknowledges foreground',
          async () => (await run.workers()).at(-1)?.background.at(-1) === false,
        );
        await expect
          .poll(async () => Number(await run.canvas.getAttribute('data-polkavm-frames')))
          .toBeGreaterThan(Number(paused.frames));

        // Then: the exact worker survives, and native menu input still changes what the player sees.
        expect([...run.liveWorkers]).toEqual([activeWorker]);
        expect(await run.workers()).toHaveLength(2);
        await run.canvas.focus();
        const resumed = await framebuffer(run.frame);
        await page.keyboard.press('Escape');
        await run.until(
          'resumed game responds to menu input',
          async () => pixelDifference(resumed, await framebuffer(run.frame)) > 0.01,
        );
        await expect
          .poll(async () => Number(await run.canvas.getAttribute('data-polkavm-audio-chunks')))
          .toBeGreaterThan(Number(paused.audio));
        await run.until('foreground audio resumes', async () =>
          run.frame.evaluate(() => window.__polkavmQualification.audio.some(audio => audio.state === 'running')),
        );
        await run.screenshot(`${campaign}-resumed-native-menu`);
        await run.evidence(`${campaign}-same-worker-resumed`);
      } finally {
        await other.close();
      }
      expect((await run.workers()).flatMap(worker => worker.errors)).toEqual([]);
    } finally {
      await run.finish();
    }
  });
}
