// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  observeRuntime,
  wireFrames,
  type DecodedWireFrame,
  type Probe,
} from '../functional/helpers/polkavm-qualification.js';

interface ProductSmoke {
  label: string;
  profile: 'framebuffer' | 'tri2d' | 'webgpu-raster';
  keys: readonly string[];
  scheduling?: 'continuous' | 'demand-driven';
  clickPosition?: { readonly x: number; readonly y: number };
  audio: boolean;
  nonzeroAudio: boolean;
  interaction?: 'gameplay-pointer-capture' | 'pointer-motion' | 'host-frame-handshake' | 'host-sign-in';
}

const products: readonly ProductSmoke[] = [
  {
    label: 'doom',
    profile: 'framebuffer',
    keys: ['Escape', 'Enter', 'Enter', 'Enter', 'w', 'Space'],
    audio: true,
    nonzeroAudio: true,
  },
  {
    label: 'quake',
    profile: 'framebuffer',
    keys: ['Escape', 'Enter', 'Enter', 'ArrowUp', 'Space'],
    audio: true,
    nonzeroAudio: false,
    interaction: 'gameplay-pointer-capture',
  },
  {
    label: 'duke',
    profile: 'framebuffer',
    // Duke starts in a level; Escape would open its in-game menu.
    keys: [],
    audio: true,
    nonzeroAudio: true,
    interaction: 'gameplay-pointer-capture',
  },
  {
    label: 'echat',
    profile: 'tri2d',
    keys: [],
    scheduling: 'demand-driven',
    // The signed-out guest's Retry button reopens the host sign-in prompt.
    clickPosition: { x: 880, y: 132 },
    audio: false,
    nonzeroAudio: false,
    interaction: 'host-sign-in',
  },
  {
    label: 'egui-app-lab',
    profile: 'tri2d',
    keys: ['Tab', 'Enter', 'Tab'],
    scheduling: 'demand-driven',
    audio: false,
    nonzeroAudio: false,
  },
  {
    label: 'pvm-truapi-playground',
    profile: 'tri2d',
    keys: [],
    audio: false,
    nonzeroAudio: false,
    interaction: 'host-frame-handshake',
    clickPosition: { x: 500, y: 250 },
  },
  {
    label: 'lot-lab',
    profile: 'webgpu-raster',
    keys: ['1', '2', '3', '4', 'Space'],
    audio: false,
    nonzeroAudio: false,
  },
  {
    label: 'chinpokomon',
    profile: 'webgpu-raster',
    keys: [],
    audio: false,
    nonzeroAudio: false,
    interaction: 'pointer-motion',
  },
];

const root = process.env['DOTLI_SMOKE_ROOT'] ?? 'westendli.dev';
if (!/^[a-z0-9.-]+$/.test(root)) {
  throw new Error(`DOTLI_SMOKE_ROOT is not a valid host suffix: ${root}`);
}

const runtimeFailure =
  /Failed to load content|App version isn't supported|external App manifest is required|unsupported import|runtime requires ABI version|No connected peers|chainHead follow stopped|execution trapped|exceeded hostcall budget/i;

async function counter(canvas: Locator, name: string): Promise<number> {
  return Number((await canvas.getAttribute(name)) ?? 0);
}
async function clickGuest(canvas: Locator, position: { readonly x: number; readonly y: number }): Promise<void> {
  const insets = (await canvas.getAttribute('data-polkavm-safe-area-insets'))?.split(',').map(value => Number(value));
  const parsedTop = insets?.length === 4 ? insets[1] : undefined;
  const safeTop = parsedTop !== undefined && Number.isFinite(parsedTop) ? parsedTop : 0;
  await canvas.click({ position: { x: position.x, y: position.y + safeTop }, force: true });
}

async function waitForRuntimeReady(page: Page, body: Locator, canvas: Locator, label: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  let lastText = '';
  while (Date.now() < deadline) {
    const [ready, text] = await Promise.all([
      canvas
        .count()
        .then(count =>
          count === 0
            ? Promise.resolve(false)
            : canvas.getAttribute('data-polkavm-ready').then(value => value === 'true'),
        ),
      body.count().then(count => (count === 0 ? Promise.resolve('') : body.innerText())),
    ]);
    lastText = text.trim();
    if (runtimeFailure.test(lastText)) {
      throw new Error(`${label}: runtime failed\n${lastText}`);
    }
    if (ready) {
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`${label}: runtime did not become ready within 180s\n${lastText}`);
}

async function cancelSignIn(page: Page, canvas: Locator): Promise<void> {
  const signIn = page.locator('#auth-modal-backdrop');
  await expect(signIn).toBeVisible({ timeout: 30_000 });
  const responsesBefore = await counter(canvas, 'data-polkavm-host-frame-responses');
  const framesBefore = await counter(canvas, 'data-polkavm-frames');
  await signIn.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(signIn).toBeHidden();
  await expect
    .poll(() => counter(canvas, 'data-polkavm-host-frame-responses'), { timeout: 30_000 })
    .toBeGreaterThan(responsesBefore);
  await expect.poll(() => counter(canvas, 'data-polkavm-frames'), { timeout: 30_000 }).toBeGreaterThan(framesBefore);
}

async function assertHandshake(canvas: Locator, workerId: number, wireStart: number): Promise<void> {
  const observedFrames = async (): Promise<DecodedWireFrame[]> => {
    const worker = await canvas.evaluate(
      (element, id) =>
        element.ownerDocument.defaultView?.__polkavmQualification.workers.find(worker => worker.id === id),
      workerId,
    );
    if (worker === undefined || worker.terminated) {
      throw new Error('Handshake runtime worker disappeared');
    }
    return wireFrames([{ ...worker, wire: worker.wire.slice(wireStart) }]);
  };
  await expect
    .poll(async () => (await observedFrames()).some(frame => frame.direction === 'request'), {
      timeout: 30_000,
      message: 'Run handshake must emit a real guest request',
    })
    .toBe(true);
  const request = (await observedFrames()).find(frame => frame.direction === 'request');
  expect(request, 'Malformed handshake request: expected trait 1, method 0, type 0, payload [0,3]').toMatchObject({
    trait: 1,
    method: 0,
    type: 0,
    payload: [0, 3],
  });
  await expect
    .poll(async () => (await observedFrames()).some(frame => frame.direction === 'response'), {
      timeout: 30_000,
      message: 'Canonical handshake must receive a real host response',
    })
    .toBe(true);
  const response = (await observedFrames()).find(frame => frame.direction === 'response');
  expect(
    response,
    'Invalid handshake response: expected correlated trait 1, method 0, type 1, Result::Ok V1 [0,0], not a protocol error',
  ).toEqual({
    direction: 'response',
    id: request?.id,
    trait: 1,
    method: 0,
    type: 1,
    payload: [0, 0],
  });
}

async function smokeProduct(page: Page, product: ProductSmoke): Promise<Record<string, unknown>> {
  const productUrl = `https://${product.label}.${root}/`;
  const iframeSelector = `iframe[src*="${product.label}.app.${root}"]`;

  await page.goto(productUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  // Fresh testnet visits must launch without opting in. Production still
  // exercises the explicit Settings opt-in before running each product.
  if (root === 'dot.li') {
    await page.locator('#mode-button[aria-haspopup="dialog"]').click();
    const settings = page.getByRole('dialog', {
      name: 'Settings',
      exact: true,
    });
    const polkaVmApps = settings.getByRole('switch', {
      name: 'PolkaVM apps',
      exact: true,
    });
    await expect(polkaVmApps).toHaveAttribute('aria-checked', 'false');
    await polkaVmApps.click();
    await Promise.all([
      page.waitForEvent('load'),
      settings.getByRole('button', { name: 'Save & Apply', exact: true }).click(),
    ]);
  }

  const iframe = page.locator(iframeSelector);
  await expect(iframe).toBeAttached({ timeout: 180_000 });
  const iframeSource = await iframe.getAttribute('src');
  if (iframeSource === null) {
    throw new Error(`${product.label}: product iframe has no src`);
  }

  const encodedManifest = new URL(iframeSource).searchParams.get('executableManifest');
  if (encodedManifest === null) {
    throw new Error(`${product.label}: product iframe carries no executableManifest`);
  }
  const manifest = JSON.parse(encodedManifest) as {
    $v?: number;
    kind?: string;
    runtime?: { kind?: string; abiVersion?: number };
  };
  expect(manifest.$v, `${product.label}: App manifest version`).toBe(2);
  expect(manifest.kind, `${product.label}: executable kind`).toBe('app');
  const runtime = manifest.runtime;
  expect(runtime?.kind, `${product.label}: runtime kind`).toBe('polkavm');
  expect(runtime?.abiVersion, `${product.label}: runtime ABI`).toBe(1);

  const frame = page.frameLocator(iframeSelector);
  const body = frame.locator('body');
  const canvas = frame.locator('#dotli-polkavm-canvas');
  await waitForRuntimeReady(page, body, canvas, product.label);

  await expect(canvas).toHaveAttribute('data-polkavm-profile', product.profile);
  await expect(canvas).toHaveAttribute('data-polkavm-backend', 'compiler');
  await expect(body).not.toContainText(runtimeFailure);
  if (product.profile === 'webgpu-raster') {
    await expect(canvas).toHaveAttribute('data-polkavm-gpu', 'ready');
  }
  if (product.interaction === 'host-sign-in' && (await page.locator('#auth-modal-backdrop').isVisible())) {
    // Older echat builds prompt on startup; current builds wait for Retry.
    await cancelSignIn(page, canvas);
  }

  // Readiness alone precedes the first rendered UI and the host loader dismissal.
  await expect.poll(() => counter(canvas, 'data-polkavm-frames'), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.locator('#app-loading')).toBeHidden({ timeout: 30_000 });
  let handshakeWorker: Probe['workers'][number] | undefined;
  if (product.interaction === 'host-frame-handshake') {
    await expect
      .poll(
        () =>
          canvas.evaluate(
            element => element.ownerDocument.defaultView?.__polkavmQualification.workers.at(-1)?.starts.length,
          ),
        { timeout: 30_000, message: 'Passive observer must capture the executed guest program hash' },
      )
      .toBe(1);
    handshakeWorker = await canvas.evaluate(element =>
      element.ownerDocument.defaultView?.__polkavmQualification.workers.at(-1),
    );
    if (handshakeWorker === undefined) {
      throw new Error('Handshake runtime worker was not observed');
    }
  }

  const framesBefore = await counter(canvas, 'data-polkavm-frames');
  const updatesBefore = await counter(canvas, 'data-polkavm-updates');
  const audioBefore = await counter(canvas, 'data-polkavm-audio-samples');

  await clickGuest(canvas, product.clickPosition ?? { x: 160, y: 100 });
  for (const key of product.keys) {
    await page.keyboard.press(key);
  }

  if (product.interaction === 'gameplay-pointer-capture') {
    // The first click may already have captured the pointer, which clears arming.
    await expect
      .poll(
        () =>
          canvas.evaluate(
            element =>
              element.ownerDocument.pointerLockElement === element ||
              element.getAttribute('data-polkavm-pointer-capture-armed') === 'true',
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    if (!(await canvas.evaluate(element => element.ownerDocument.pointerLockElement === element))) {
      await canvas.click({ position: { x: 160, y: 100 } });
    }
    await expect(canvas).toHaveAttribute('data-polkavm-pointer-captured', 'true', { timeout: 10_000 });
    await expect
      .poll(() => canvas.evaluate(element => element.ownerDocument.pointerLockElement === element), {
        timeout: 10_000,
      })
      .toBe(true);
  } else if (product.interaction === 'pointer-motion') {
    const motionSamplesBefore = await counter(canvas, 'data-polkavm-motion-samples');
    const bounds = await canvas.boundingBox();
    if (bounds === null) {
      throw new Error(`${product.label}: runtime canvas has no bounds`);
    }
    await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.5);
    await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.5, { steps: 8 });
    await expect
      .poll(() => counter(canvas, 'data-polkavm-motion-samples'), {
        timeout: 10_000,
      })
      .toBeGreaterThan(motionSamplesBefore);
    await expect(canvas).toHaveAttribute('data-polkavm-motion-source', 'pointer');
  } else if (product.interaction === 'host-frame-handshake') {
    if (handshakeWorker === undefined) {
      throw new Error('Handshake runtime worker was not observed before input');
    }
    await assertHandshake(canvas, handshakeWorker.id, handshakeWorker.wire.length);
  } else if (product.interaction === 'host-sign-in') {
    // A fresh prompt proves the guest handled input after cancellation.
    await cancelSignIn(page, canvas);
  }

  if (product.scheduling === 'demand-driven') {
    await expect.poll(() => counter(canvas, 'data-polkavm-frames'), { timeout: 30_000 }).toBeGreaterThan(framesBefore);
  } else {
    await expect
      .poll(() => counter(canvas, 'data-polkavm-frames'), { timeout: 30_000 })
      .toBeGreaterThan(framesBefore + 30);
    await expect
      .poll(() => counter(canvas, 'data-polkavm-updates'), { timeout: 30_000 })
      .toBeGreaterThan(updatesBefore + 30);
  }

  if (product.audio) {
    await expect
      .poll(() => counter(canvas, 'data-polkavm-audio-samples'), {
        timeout: 30_000,
      })
      .toBeGreaterThan(audioBefore);
    if (product.nonzeroAudio) {
      await expect(canvas).toHaveAttribute('data-polkavm-audio-nonzero', 'true');
    }
  } else if (product.profile === 'tri2d') {
    await expect
      .poll(() => counter(canvas, 'data-polkavm-tri2d-draws'), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
  }

  if (product.profile !== 'framebuffer') {
    const framesBeforeResize = await counter(canvas, 'data-polkavm-frames');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => counter(canvas, 'data-polkavm-frames'), { timeout: 30_000 })
      .toBeGreaterThan(framesBeforeResize);
  }

  return {
    product: product.label,
    manifest,
    backend: await canvas.getAttribute('data-polkavm-backend'),
    profile: await canvas.getAttribute('data-polkavm-profile'),
    gpu: await canvas.getAttribute('data-polkavm-gpu'),
    frames: await counter(canvas, 'data-polkavm-frames'),
    updates: await counter(canvas, 'data-polkavm-updates'),
    audioSamples: await counter(canvas, 'data-polkavm-audio-samples'),
    tri2dDraws: await counter(canvas, 'data-polkavm-tri2d-draws'),
    pointerCaptured: await canvas.getAttribute('data-polkavm-pointer-captured'),
    motionSamples: await counter(canvas, 'data-polkavm-motion-samples'),
    motionSource: await canvas.getAttribute('data-polkavm-motion-source'),
    hostFrameRequests: await counter(canvas, 'data-polkavm-host-frame-requests'),
    hostFrameResponses: await counter(canvas, 'data-polkavm-host-frame-responses'),
  };
}

for (const product of products) {
  test(`${product.label} reaches a playable state`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    try {
      if (product.interaction === 'host-frame-handshake') {
        await observeRuntime(page);
      }
      const metrics = await smokeProduct(page, product);
      await testInfo.attach(`${product.label}-smoke.json`, {
        body: Buffer.from(JSON.stringify(metrics, null, 2)),
        contentType: 'application/json',
      });
    } catch (error) {
      try {
        await testInfo.attach(`${product.label}-failure.png`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
      } catch (screenshotError) {
        console.warn('Could not capture the product failure screenshot:', screenshotError);
      }
      throw error;
    } finally {
      if (product.interaction === 'host-frame-handshake') {
        try {
          const frames = await Promise.all(
            page.frames().map(async frame => {
              const state = await frame.evaluate(() => ({
                workers: (window as Partial<Window>).__polkavmQualification?.workers ?? [],
                canvas: Object.fromEntries(
                  Object.entries(document.querySelector<HTMLCanvasElement>('#dotli-polkavm-canvas')?.dataset ?? {}),
                ),
              }));
              return {
                url: frame.url(),
                ...state,
                decodedWire: state.workers.map(worker => {
                  try {
                    return { workerId: worker.id, frames: wireFrames([worker]) };
                  } catch (error) {
                    return { workerId: worker.id, decodeError: String(error) };
                  }
                }),
              };
            }),
          );
          await testInfo.attach(`${product.label}-wire-provenance.json`, {
            body: JSON.stringify({ productUrl: page.url(), frames }, null, 2),
            contentType: 'application/json',
          });
        } catch (evidenceError) {
          console.warn('Could not capture handshake wire/program provenance:', evidenceError);
        }
      }
      await context.close();
    }
  });
}
