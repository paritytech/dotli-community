// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { LogoSymbol } from '@dotli/ui/brand';
import { Spinner } from '@dotli/ui';
import { drawQrCode, type DrawQr } from '../qr-code.js';
import { presentQr } from '../qr-drawer.js';
import s from './PairingQr.module.css';

interface DrawnQr {
  payload: string;
  canvas: HTMLCanvasElement;
}

/** The side the code may take, quiet zone included, which the stylesheet owns. */
function qrSize(box: HTMLElement): number {
  return Number.parseInt(getComputedStyle(box).getPropertyValue('--qr-size'), 10);
}

/** Decorative: the code's error correction survives it. */
function QrBadge(): JSX.Element {
  return (
    <span class={s['badge']} aria-hidden="true" data-testid="auth-modal-qr-badge">
      <span class={s['badgeMark']}>
        <LogoSymbol height={26} />
      </span>
    </span>
  );
}

/** The code's tile, a link to the deeplink on a phone, so tapping the code pairs too. */
function QrTile(props: { qr: DrawnQr; link: boolean }): JSX.Element {
  return (
    <Show
      when={props.link}
      fallback={
        <div class={s['tile']} data-testid="auth-modal-qr-tile">
          {props.qr.canvas}
          <QrBadge />
        </div>
      }
    >
      <a href={props.qr.payload} class={s['tile']} data-testid="auth-modal-qr-link">
        {props.qr.canvas}
        <QrBadge />
      </a>
    </Show>
  );
}

export interface PairingQrProps {
  /** The pairing deeplink, null while it is being made. */
  payload: string | null;
  /** Hidden, the code is still drawn, so it shows at once when asked for. */
  shown: boolean;
  /** Whether the tile links to the deeplink. */
  link: boolean;
  /** Without one, the `qrcode` chunk draws the code. */
  drawQr?: DrawQr | undefined;
}

/** The pairing code on its tile, drawn as soon as its payload is known, with a spinner in its place until then. */
export function PairingQr(props: PairingQrProps): JSX.Element {
  let box: HTMLDivElement | undefined;

  // Last payload wins: a drawing is dropped once its payload is no longer on show.
  const [drawn, setDrawn] = createSignal<DrawnQr | null>(null);
  createEffect(
    () => ({ payload: props.payload, drawQr: props.drawQr ?? drawQrCode }),
    ({ payload, drawQr }) => {
      const qrBox = box;
      if (payload === null || qrBox === undefined) {
        return;
      }
      return presentQr(payload, {
        drawQr,
        createCanvas: shownPayload => {
          const canvas = document.createElement('canvas');
          canvas.dataset['qrPayload'] = shownPayload;
          canvas.className = s['canvas'] ?? '';
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', 'Sign-in QR code');
          return canvas;
        },
        size: () => qrSize(qrBox),
        onDrawn: qr => {
          setDrawn(qr);
        },
      });
    },
  );
  const qr = (): DrawnQr | undefined => {
    const d = drawn();
    return d !== null && d.payload === props.payload ? d : undefined;
  };

  return (
    <div
      ref={el => {
        box = el;
      }}
      class={s['qr']}
      id="auth-modal-qr"
      data-testid="auth-modal-qr"
      hidden={!props.shown}
    >
      <Show when={props.shown}>
        <Show
          when={qr()}
          fallback={
            <div class={s['placeholder']}>
              <Spinner class={s['placeholderSpinner']} testId="auth-modal-spinner" />
            </div>
          }
        >
          {drawnQr => <QrTile qr={drawnQr()} link={props.link} />}
        </Show>
      </Show>
    </div>
  );
}
