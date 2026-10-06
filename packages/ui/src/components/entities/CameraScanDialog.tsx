// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Modal } from '../floating/Modal.js';
import { Button } from '../primitives/Button.js';
import s from './CameraScanDialog.module.css';

export interface CameraOption {
  deviceId: string;
  label: string;
}

/**
 * The host's camera for a product's decoded UR QR input
 * (mediated-input-camera.ts owns the camera and the decoder). Cancel, the
 * close button, Escape and the scrim all cancel the scan.
 */
export function CameraScanDialog(props: {
  title: string;
  detail: string;
  progress: string;
  /** Listed only when the device has more than one camera. */
  cameras: readonly CameraOption[];
  selectedCamera: string;
  /** A touch device flips between cameras instead of picking from a list. */
  compactPicker: boolean;
  video: (el: HTMLVideoElement) => void;
  onSelectCamera: (deviceId: string) => void;
  onFlipCamera: () => void;
  onCancel: () => void;
}): JSX.Element {
  const titleId = 'camera-scan-title';
  return (
    <Modal
      open
      onOpenChange={() => {
        props.onCancel();
      }}
      title={props.title}
      labelledBy={titleId}
      class={s['card']}
      testId="camera-scan-modal"
    >
      <Modal.Head titleId={titleId} title={props.title} />
      <Modal.Body>
        <p class={s['caption']}>{props.detail}</p>
        <video ref={props.video} class={s['video']} data-testid="camera-scan-video" autoplay muted playsinline />
        <Show when={props.cameras.length > 1}>
          <div class={s['picker']} data-testid="camera-scan-picker">
            <Show
              when={props.compactPicker}
              fallback={
                <label class={s['pickerLabel']}>
                  <span>Camera</span>
                  <select
                    class={s['select']}
                    value={props.selectedCamera}
                    onChange={event => {
                      props.onSelectCamera(event.currentTarget.value);
                    }}
                  >
                    <option value="">System default camera</option>
                    <For each={props.cameras}>{camera => <option value={camera.deviceId}>{camera.label}</option>}</For>
                  </select>
                </label>
              }
            >
              <Button
                size="sm"
                testId="camera-scan-flip"
                onClick={() => {
                  props.onFlipCamera();
                }}
              >
                Flip camera
              </Button>
            </Show>
          </div>
        </Show>
        <p class={s['caption']} data-testid="camera-scan-progress" aria-live="polite">
          {props.progress}
        </p>
      </Modal.Body>
      <Modal.Actions testId="camera-scan-footer">
        <Button
          variant="secondary"
          block
          testId="camera-scan-cancel"
          onClick={() => {
            props.onCancel();
          }}
        >
          Cancel
        </Button>
      </Modal.Actions>
    </Modal>
  );
}
