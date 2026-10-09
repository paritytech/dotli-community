// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Local content/resolution fixtures with passive observation of the unmodified runtime and SDK. */
import {
  expect,
  type Frame,
  type Locator,
  type Page,
  type TestInfo,
  type Worker as PlaywrightWorker,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PORT } from '../../env.js';

const ROOT = resolve(import.meta.dirname, '../../../../..');
const INDEX = resolve(ROOT, 'dist/polkavm-qualification/fixtures.json');
export type Campaign = 'freedoom1' | 'freedoom2';
type FixtureName = 'playground' | Campaign;
interface FixtureEntry {
  car: string;
  manifest: string;
  cid: string;
  carSha256: string;
  manifestSha256: string;
  programSha256: string;
  productId: string;
  mountPath?: string;
}
interface FixtureIndex {
  schemaVersion: number;
  source: { repository: string; revision: string; guestSdkRevision: string };
  fixtures: Record<FixtureName, FixtureEntry>;
  uploads: Record<Campaign, { path: string; sha256: string }>;
}
interface WireObservation {
  direction: 'request' | 'response';
  bytes: number[];
}
interface WorkerObservation {
  id: number;
  url: string;
  terminated: boolean;
  starts: { programSha256: string; assets: { path: string; sha256: string }[] }[];
  ready: Record<string, unknown>[];
  wire: WireObservation[];
  logs: string[];
  errors: string[];
  background: boolean[];
}
export interface Probe {
  workers: WorkerObservation[];
  audio: AudioContext[];
}
declare global {
  interface Window {
    __polkavmQualification: Probe;
  }
}

function fixturePath(path: string): string {
  const absolute = resolve(dirname(INDEX), path);
  if (!absolute.startsWith(`${dirname(INDEX)}${sep}`)) {
    throw new Error(`Fixture path escapes prepared directory: ${path}`);
  }
  return absolute;
}
async function checkedFile(path: string, hash: string): Promise<Buffer> {
  const bytes = await readFile(fixturePath(path));
  expect(createHash('sha256').update(bytes).digest('hex'), `Prepared fixture hash: ${path}`).toBe(hash);
  return bytes;
}

/** Installs before any page script; never consumes, replaces or fabricates runtime messages. */
export async function observeRuntime(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: Probe = { workers: [], audio: [] };
    window.__polkavmQualification = probe;
    const digest = async (bytes: Uint8Array): Promise<string> => {
      const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
      return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    };
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args: ConstructorParameters<typeof Worker>) {
        const worker = new target(...args);
        if (!String(args[0]).includes('polkavm-worker.js')) {
          return worker;
        }
        const record: WorkerObservation = {
          id: probe.workers.length,
          url: String(args[0]),
          terminated: false,
          starts: [],
          ready: [],
          wire: [],
          logs: [],
          errors: [],
          background: [],
        };
        probe.workers.push(record);
        worker.addEventListener('message', (event: MessageEvent<Record<string, unknown>>) => {
          const message = event.data;
          if (message['type'] === 'ready') {
            record.ready.push(message);
          }
          if (message['type'] === 'host-frame-request') {
            record.wire.push({ direction: 'request', bytes: Array.from(message['bytes'] as Uint8Array) });
          }
          if (message['type'] === 'background-state') {
            record.background.push(message['backgrounded'] as boolean);
          }
          if (message['type'] === 'log') {
            record.logs.push(String(message['message']));
          }
          if (message['type'] === 'error') {
            record.errors.push(String(message['message']));
          }
        });
        worker.addEventListener('error', event => record.errors.push(event.message));
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (message: unknown, options?: Transferable[] | StructuredSerializeOptions) => {
          const data = message as Record<string, unknown>;
          if (data['type'] === 'host-frame-response') {
            record.wire.push({ direction: 'response', bytes: Array.from(data['bytes'] as Uint8Array) });
          }
          if (data['type'] === 'start') {
            // Copy before the real postMessage transfers ownership; retain only hashes.
            const program = new Uint8Array(data['program'] as Uint8Array);
            const assets = (data['assets'] as { path: string; bytes: Uint8Array }[]).map(asset => ({
              path: asset.path,
              bytes: new Uint8Array(asset.bytes),
            }));
            void Promise.all([
              digest(program),
              Promise.all(assets.map(async asset => ({ path: asset.path, sha256: await digest(asset.bytes) }))),
            ])
              .then(([programSha256, hashes]) => record.starts.push({ programSha256, assets: hashes }))
              .catch((error: unknown) => record.errors.push(String(error)));
          }
          if (Array.isArray(options)) {
            post(message, options);
          } else {
            post(message, options);
          }
        };
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => {
          record.terminated = true;
          terminate();
        };
        return worker;
      },
    });
    const NativeAudio = window.AudioContext;
    window.AudioContext = new Proxy(NativeAudio, {
      construct(target, args: ConstructorParameters<typeof AudioContext>) {
        const context = new target(...args);
        probe.audio.push(context);
        return context;
      },
    });
  });
}

export class Qualification {
  readonly logs: string[] = [];
  readonly liveWorkers = new Set<PlaywrightWorker>();
  private mountedFrame?: Frame;
  get frame(): Frame {
    if (this.mountedFrame === undefined) {
      throw new Error('Sandbox frame has not mounted');
    }
    return this.mountedFrame;
  }
  readonly page: Page;
  readonly info: TestInfo;
  readonly name: FixtureName;
  readonly index: FixtureIndex;
  readonly fixture: FixtureEntry;
  private constructor(page: Page, info: TestInfo, name: FixtureName, index: FixtureIndex, fixture: FixtureEntry) {
    this.page = page;
    this.info = info;
    this.name = name;
    this.index = index;
    this.fixture = fixture;
  }

  static async open(page: Page, info: TestInfo, name: FixtureName): Promise<Qualification> {
    let index: FixtureIndex;
    try {
      index = JSON.parse(await readFile(INDEX, 'utf8')) as FixtureIndex;
    } catch (cause) {
      throw new Error('Qualification fixtures are required. Run npm run prepare:polkavm-qualification first.', {
        cause,
      });
    }
    expect(index.schemaVersion).toBe(1);
    const fixture = index.fixtures[name];
    const lock = JSON.parse(
      await readFile(resolve(ROOT, 'apps/host/tests/functional/fixtures/polkavm/qualification.lock.json'), 'utf8'),
    ) as {
      schemaVersion: number;
      source: FixtureIndex['source'];
      artifacts: Record<FixtureName, Pick<FixtureEntry, 'cid' | 'carSha256' | 'manifestSha256' | 'programSha256'>>;
      freedoom: { freedoom1Sha256: string; freedoom2Sha256: string };
    };
    expect(lock.schemaVersion).toBe(1);
    expect(index.source, 'Prepared content must match the checked-in immutable source').toEqual(lock.source);
    expect(lock.artifacts[name], 'Fixture lock must contain approved artifact hashes').toBeDefined();
    expect({
      cid: fixture.cid,
      carSha256: fixture.carSha256,
      manifestSha256: fixture.manifestSha256,
      programSha256: fixture.programSha256,
    }).toEqual(lock.artifacts[name]);
    for (const campaign of ['freedoom1', 'freedoom2'] as const) {
      expect(index.uploads[campaign].sha256).toBe(lock.freedoom[`${campaign}Sha256`]);
    }
    expect(fixture.productId).toBeTruthy();
    const car = await checkedFile(fixture.car, fixture.carSha256);
    const manifest = (await checkedFile(fixture.manifest, fixture.manifestSha256)).toString('utf8');
    const qualification = new Qualification(page, info, name, index, fixture);
    await info.attach('provenance', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          fixtures: index,
          fixtureLock: lock,
          runtime: JSON.parse(await readFile(resolve(ROOT, 'scripts/polkavm-runtime.lock.json'), 'utf8')) as unknown,
          sdk: JSON.parse(await readFile(resolve(ROOT, 'vendor/truapi-host.lock.json'), 'utf8')) as unknown,
        },
        null,
        2,
      ),
    });
    page.on('console', message => qualification.logs.push(`[${message.type()}] ${message.text()}`));
    page.on('pageerror', error => qualification.logs.push(`[pageerror] ${error.message}`));
    page.on('worker', worker => {
      if (!worker.url().includes('polkavm-worker.js')) {
        return;
      }
      qualification.liveWorkers.add(worker);
      worker.on('close', () => qualification.liveWorkers.delete(worker));
    });
    await observeRuntime(page);
    await page.setViewportSize({ width: 780, height: 700 });
    const label = `qualification-${name}`;
    const protocolHtml = await readFile(resolve(ROOT, 'apps/protocol/dist/index.html'), 'utf8');
    const rootManifest = { $v: 1, displayName: `Qualification ${name}`, description: 'Local qualification fixture' };
    const resolver = `<script>(() => {
      const cid = ${JSON.stringify(fixture.cid)};
      const manifest = ${JSON.stringify(manifest).replaceAll('<', '\\u003c')};
      const rootManifest = ${JSON.stringify(rootManifest)};
      window.addEventListener('message', event => {
        const m = event.data;
        if (event.source !== parent || !m || m.namespace !== 'dotli:protocol' || m.kind !== 'request') return;
        let result;
        if (m.method === 'resolveDotName') result = cid;
        else if (m.method === 'resolveRootManifest') result = {kind:'ok', value:rootManifest, raw:JSON.stringify(rootManifest)};
        else if (m.method === 'resolveExecutableManifest') result = m.payload.kind === 'app'
          ? {kind:'ok', value:JSON.parse(manifest), raw:manifest} : {kind:'empty'};
        else return;
        event.stopImmediatePropagation();
        parent.postMessage({namespace:'dotli:protocol',kind:'response',id:m.id,ok:true,result}, event.origin);
      }, true);
    })();</script>`;
    await page.route(
      url => url.hostname === 'host.localhost',
      async route => {
        if (route.request().resourceType() !== 'document') {
          return route.continue();
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: {
            'Cross-Origin-Embedder-Policy': 'credentialless',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'cross-origin',
          },
          body: protocolHtml.replace('<head>', `<head>${resolver}`),
        });
      },
    );
    await page.route(
      url => url.hostname === `${label}.app.localhost`,
      async route => {
        const url = new URL(route.request().url());
        if (
          route.request().resourceType() === 'document' &&
          url.searchParams.get('chainBackend') === 'smoldot-direct'
        ) {
          url.searchParams.set('chainBackend', 'rpc-gateway');
          return route.fulfill({ status: 302, headers: { location: url.href } });
        }
        return route.continue();
      },
    );
    await page.route('**/ipfs/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname !== `/ipfs/${fixture.cid}`) {
        qualification.logs.push(`[unexpected-content] ${url.href}`);
        return route.abort('blockedbyclient');
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.ipld.car',
        body: car,
        headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' },
      });
    });
    try {
      await page.goto(
        `http://${label}.localhost:${PORT}/?chainBackend=smoldot-direct&network=paseo-next-v2&polkaVmEnabled=1&dotliProductId=${fixture.productId}`,
        { waitUntil: 'domcontentloaded' },
      );
      await qualification.until('sandbox frame mounts', () => {
        const frame = page
          .frames()
          .find(candidate => candidate.url().startsWith(`http://${label}.app.localhost:${PORT}/`));
        if (frame === undefined) {
          return false;
        }
        qualification.mountedFrame = frame;
        return true;
      });
      await qualification.ready(false);
      return qualification;
    } catch (error) {
      await qualification.finish();
      throw error;
    }
  }

  get canvas(): Locator {
    return this.frame.locator('#dotli-polkavm-canvas');
  }
  async workers(): Promise<WorkerObservation[]> {
    return this.frame.evaluate(() => window.__polkavmQualification.workers);
  }
  async until(description: string, condition: () => Promise<boolean> | boolean, timeout = 90_000): Promise<void> {
    const deadline = Date.now() + timeout;
    do {
      if (this.mountedFrame !== undefined && !this.mountedFrame.isDetached()) {
        const errors = (await this.workers()).flatMap(worker => worker.errors);
        if (errors.length > 0) {
          throw new Error(`${description}: ${errors.join('\n')}\n${this.logs.slice(-30).join('\n')}`);
        }
        const failed = await this.frame
          .locator('.dotli-polkavm-menu')
          .evaluateAll(elements => elements[0]?.textContent ?? '');
        if (failed.includes('Unable to run app')) {
          throw new Error(`${description}: ${failed}`);
        }
      }
      if (await condition()) {
        return;
      }
      await delay(100);
    } while (Date.now() < deadline);
    const status = this.mountedFrame === undefined ? '' : await this.frame.locator('body').innerText();
    throw new Error(`${description} did not complete. Host/sandbox: ${status}\n${this.logs.slice(-50).join('\n')}`);
  }
  async ready(warm: boolean): Promise<void> {
    await this.until('runtime becomes ready', async () =>
      this.canvas.evaluateAll(elements => elements[0]?.getAttribute('data-polkavm-ready') === 'true'),
    );
    await expect(this.canvas).toHaveAttribute('data-polkavm-backend', 'compiler');
    await expect(this.canvas).toHaveAttribute('data-polkavm-cache-hit', String(warm));
    if (warm) {
      await expect(this.canvas).toHaveAttribute('data-polkavm-translation-ms', '0');
      await expect(this.canvas).toHaveAttribute('data-polkavm-compilation-ms', '0');
    }
    await this.until(
      'passive worker probe observes verified program',
      async () => (await this.workers()).at(-1)?.starts.length === 1,
    );
    expect((await this.workers()).at(-1)?.starts[0]?.programSha256).toBe(this.fixture.programSha256);
    await this.until(
      'guest presents its first frame',
      async () => Number(await this.canvas.getAttribute('data-polkavm-frames')) > 0,
    );
    // The first guest frame can precede dismissal of the host's input-blocking loader.
    await expect(this.page.locator('#app-loading')).toBeHidden();
    await this.screenshot(warm ? 'warm-ready' : 'cold-ready');
  }
  async upload(): Promise<string> {
    if (this.name === 'playground') {
      throw new Error('Playground has no file upload');
    }
    const upload = this.index.uploads[this.name];
    await checkedFile(upload.path, upload.sha256);
    return fixturePath(upload.path);
  }
  async screenshot(name: string): Promise<void> {
    await this.info.attach(name, { body: await this.page.screenshot(), contentType: 'image/png' });
  }
  async evidence(name: string): Promise<void> {
    const state = await this.frame.evaluate(() => ({
      workers: window.__polkavmQualification.workers,
      audio: window.__polkavmQualification.audio.map(context => context.state),
      canvas: Object.fromEntries(
        Object.entries(document.querySelector<HTMLCanvasElement>('#dotli-polkavm-canvas')?.dataset ?? {}),
      ),
      visibility: document.visibilityState,
    }));
    await this.info.attach(name, { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
  }
  async finish(): Promise<void> {
    try {
      if (this.mountedFrame !== undefined && !this.mountedFrame.isDetached()) {
        await this.evidence('final-runtime-state');
      }
      await this.screenshot('final-surface');
    } finally {
      await this.info.attach('browser-log', { body: this.logs.join('\n'), contentType: 'text/plain' });
      await this.page.goto('about:blank');
      await expect
        .poll(() => this.liveWorkers.size, { message: 'Navigation must destroy every runtime worker' })
        .toBe(0);
      expect(this.page.workers().filter(worker => worker.url().includes('polkavm-worker.js'))).toEqual([]);
      await this.info.attach('teardown', {
        body: JSON.stringify({ liveRuntimeWorkers: this.liveWorkers.size, url: this.page.url() }),
        contentType: 'application/json',
      });
    }
  }
}

/** A passively observed canonical host frame and its decoded payload. */
export interface DecodedWireFrame {
  direction: WireObservation['direction'];
  id: string;
  trait: number;
  method: number;
  type: number;
  payload: number[];
}

/** Decode the canonical SCALE string + trait/method/type frame header, without generating replies. */
export function wireFrames(workers: WorkerObservation[]): DecodedWireFrame[] {
  return workers
    .flatMap(worker => worker.wire)
    .map(frame => {
      const bytes = Buffer.from(frame.bytes);
      const first = bytes[0];
      if (first === undefined || (first & 3) !== 0) {
        throw new Error('Expected short canonical request ID');
      }
      const end = 1 + (first >>> 2);
      if (bytes.length < end + 3) {
        throw new Error('Truncated host frame');
      }
      return {
        direction: frame.direction,
        id: bytes.subarray(1, end).toString('utf8'),
        trait: bytes.readUInt8(end),
        method: bytes.readUInt8(end + 1),
        type: bytes.readUInt8(end + 2),
        payload: [...bytes.subarray(end + 3)],
      };
    });
}

/** Sample actual presented framebuffer pixels, not frame counters or a hardware-specific golden image. */
export async function framebuffer(frame: Frame): Promise<number[]> {
  return frame.locator('#dotli-polkavm-canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('Expected Doom framebuffer');
    }
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const sample: number[] = [];
    // Interior world, excluding the animated status bar and letterboxing.
    for (let y = 20; y < canvas.height * 0.7; y += 4) {
      for (let x = 20; x < canvas.width - 20; x += 4) {
        const offset = (y * canvas.width + x) * 4;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        if (red === undefined || green === undefined || blue === undefined) {
          throw new Error('Framebuffer sample out of bounds');
        }
        sample.push((red << 16) | (green << 8) | blue);
      }
    }
    return sample;
  });
}
export function pixelDifference(left: number[], right: number[]): number {
  expect(left.length).toBe(right.length);
  return left.filter((pixel, index) => pixel !== right[index]).length / left.length;
}
