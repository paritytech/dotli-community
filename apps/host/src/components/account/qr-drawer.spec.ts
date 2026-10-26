// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { deferred, bindLogSink, type LogLevel } from '@dotli/shared';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import type { QrDrawOptions } from './qr-code.js';
import { presentQr, type QrShowing } from './qr-drawer.js';

/** A canvas as the drawer sees it: only passed back. */
type FakeCanvas = {
  payload: string;
};

type Draw = {
  canvas: FakeCanvas;
  payload: string;
  options: QrDrawOptions;
  signal: AbortSignal;
};

let metrics: RecordingSentry;
const captured: { error: unknown; context: CaptureContext | undefined }[] = [];
const errorsLogged: string[] = [];
let unbind: (() => void)[] = [];

beforeEach(() => {
  metrics = bindRecordingSentry({ onFinished: onTestFinished });
  unbind = [
    bindCaptureSink({
      exception: (error, context) => {
        captured.push({ error, context });
      },
      expected: () => undefined,
    }),
    bindLogSink({
      emit: (level: LogLevel, message: string) => {
        if (level === 'error') {
          errorsLogged.push(message);
        }
      },
    }),
  ];
});

afterEach(() => {
  for (const stop of unbind) {
    stop();
  }
  captured.length = 0;
  errorsLogged.length = 0;
});

/** A showing whose drawings answer as each test says, recording each draw, canvas and drawn-in code. */
function showing(answer: (draw: Draw) => Promise<void> = () => Promise.resolve()): {
  deps: QrShowing<FakeCanvas>;
  draws: Draw[];
  canvases: FakeCanvas[];
  drawn: string[];
} {
  const draws: Draw[] = [];
  const canvases: FakeCanvas[] = [];
  const drawn: string[] = [];
  return {
    deps: {
      drawQr: (canvas, payload, options, signal) => {
        const draw = { canvas, payload, options, signal };
        draws.push(draw);
        return answer(draw);
      },
      createCanvas: payload => {
        const canvas = { payload };
        canvases.push(canvas);
        return canvas;
      },
      size: () => 218,
      onDrawn: ({ payload }) => {
        drawn.push(payload);
      },
    },
    draws,
    canvases,
    drawn,
  };
}

/** Lets the drawer hear a drawing's answer, which it heard before the test did. */
async function answered(drawing: Promise<void>): Promise<void> {
  await drawing.then(
    () => undefined,
    () => undefined,
  );
}

describe('the sign-in QR drawer', () => {
  it('As a desktop user, the code on show is drawn at the layout size, counted once as ok and drawn in', async () => {
    // Given
    const qr = showing();

    // When
    presentQr('polkadotapp://pair', qr.deps);
    await answered(Promise.resolve());

    // Then
    expect(qr.draws.map(draw => draw.options)).toEqual([
      { width: 218, margin: 2, errorCorrectionLevel: 'Q', color: { dark: '#000000', light: '#ffffff' } },
    ]);
    expect(qr.drawn).toEqual(['polkadotapp://pair']);
    expect(metrics.counted('auth.qr_render')).toEqual([{ outcome: 'ok' }]);
  });

  it('As a user whose phone already scanned, a QR drawing that finishes late is neither drawn in nor counted', async () => {
    // Given
    const held = deferred<undefined>();
    const qr = showing(() => held.promise);
    const stop = presentQr('polkadotapp://pair', qr.deps);

    // When the code goes off show, then its drawing finishes
    stop();
    held.resolve(undefined);
    await answered(held.promise);

    // Then
    expect(qr.drawn).toEqual([]);
    expect(metrics.counted('auth.qr_render')).toEqual([]);
    expect(captured).toEqual([]);
    expect(errorsLogged).toEqual([]);
  });

  it('As a user whose phone already scanned, I am not reported a QR drawing that fails late', async () => {
    // Given
    const held = deferred<undefined>();
    const qr = showing(() => held.promise);
    const stop = presentQr('polkadotapp://pair', qr.deps);

    // When
    stop();
    held.reject(new Error('canvas unavailable'));
    await answered(held.promise);

    // Then
    expect(metrics.counted('auth.qr_render')).toEqual([]);
    expect(captured).toEqual([]);
    expect(errorsLogged).toEqual([]);
  });

  it('As a user who closes the modal while the QR is drawing, I cancel that drawing', () => {
    // Given
    const qr = showing(() => new Promise(() => undefined));
    const stop = presentQr('polkadotapp://pair', qr.deps);
    expect(qr.draws[0]?.signal.aborted).toBe(false);

    // When
    stop();

    // Then
    expect(qr.draws[0]?.signal.aborted).toBe(true);
  });

  it("As a user shown a new pairing code, only the newest QR is drawn in, whenever the first one's drawing ends", async () => {
    // Given the first code's drawing held back
    const first = deferred<undefined>();
    const qr = showing(draw => (draw.payload === 'polkadotapp://first' ? first.promise : Promise.resolve()));
    const stopFirst = presentQr('polkadotapp://first', qr.deps);

    // When the second code replaces it, and the first drawing ends after
    stopFirst();
    presentQr('polkadotapp://second', qr.deps);
    await answered(Promise.resolve());
    first.resolve(undefined);
    await answered(first.promise);

    // Then
    expect(qr.drawn).toEqual(['polkadotapp://second']);
    expect(qr.canvases.map(canvas => canvas.payload)).toEqual(['polkadotapp://first', 'polkadotapp://second']);
  });

  it('As a desktop user whose QR cannot be drawn, the failure is reported once and nothing is drawn in', async () => {
    // Given
    const failure = new Error('canvas unavailable');
    const qr = showing(() => Promise.reject(failure));

    // When
    presentQr('polkadotapp://pair', qr.deps);
    await answered(Promise.reject(failure));

    // Then
    expect(captured).toEqual([{ error: failure, context: { flow: 'wallet', step: 'qr_render' } }]);
    expect(metrics.counted('auth.qr_render')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(errorsLogged).toHaveLength(1);
    expect(qr.drawn).toEqual([]);
  });

  it('As an operator, I see each code drawn on screen counted once as ok', async () => {
    // Given
    const qr = showing();

    // When
    const stopFirst = presentQr('polkadotapp://first', qr.deps);
    await answered(Promise.resolve());
    stopFirst();
    presentQr('polkadotapp://second', qr.deps);
    await answered(Promise.resolve());

    // Then
    expect(metrics.counted('auth.qr_render')).toEqual([{ outcome: 'ok' }, { outcome: 'ok' }]);
    expect(qr.drawn).toEqual(['polkadotapp://first', 'polkadotapp://second']);
  });
});
