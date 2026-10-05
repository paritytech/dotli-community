// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FileInputRegistration } from '@parity/polkavm-browser-runtime/file-input-router';
import { installFileInputControls, installWorkerShutdown, type LocalFileInputControls } from './polkavm-runtime.js';
import { installPolkaVmMenu, type PolkaVmMenu } from './polkavm-menu.js';

let cleanup = (): void => undefined;
afterEach(() => {
  cleanup();
  cleanup = () => undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function registration(handle = 7, delivery: 'stream' | 'inline' | 'relaunch' = 'stream'): FileInputRegistration {
  const fields = {
    id: 'map',
    label: 'Local map',
    extensions: ['.map'],
    mimeTypes: [],
    // Inline delivery is bounded to 8 MiB by the runtime; stream/relaunch accept more.
    maxBytes: delivery === 'inline' ? 8 * 1024 * 1024 : 128 * 1024 * 1024,
  };
  return {
    handle,
    descriptor: delivery === 'relaunch' ? { ...fields, delivery, mountPath: 'game/map.bin' } : { ...fields, delivery },
  };
}

function fixture(): {
  surface: HTMLDivElement;
  controls: LocalFileInputControls;
  menu: PolkaVmMenu;
  picker: HTMLInputElement;
  send: Mock<(message: unknown) => void>;
  select: (file: File) => void;
  approve: () => Promise<void>;
} {
  const surface = document.createElement('div');
  const canvas = document.createElement('canvas');
  surface.append(canvas);
  document.body.append(surface);
  const menu = installPolkaVmMenu(surface, canvas, [], {
    hasFileInput: false,
    grants: () => [],
    pause: vi.fn(),
    retry: vi.fn(),
    launcher: vi.fn(),
  });
  const send = vi.fn<(message: unknown) => void>();
  const controls = installFileInputControls(
    surface,
    menu.status,
    {
      id: 'halo.paseo.fyi',
      entrypoint: 'app.polkavm',
      registrations: [],
    },
    send,
    menu,
  );
  const picker = surface.querySelector<HTMLInputElement>('input[type=file]');
  if (picker === null) {
    throw new Error('Missing native file picker');
  }
  cleanup = () => {
    controls.cleanup();
    menu.cleanup();
  };
  const select = (file: File): void => {
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
    picker.dispatchEvent(new Event('change'));
  };
  const approve = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(document.querySelector('.dotli-file-consent-approve')).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>('.dotli-file-consent-approve')?.click();
  };
  return { surface, controls, menu, picker, send, select, approve };
}

describe('runtime-registered local files', () => {
  it('shows Open file only for ready, live registrations and uses the native picker', () => {
    const { controls, menu, picker } = fixture();
    const click = vi.spyOn(picker, 'click').mockImplementation(() => undefined);
    controls.update([registration()]);
    expect(menu.changeFile.hidden).toBe(true);
    menu.changeFile.click();
    expect(click).not.toHaveBeenCalled();
    controls.ready();
    expect(menu.changeFile.hidden).toBe(false);
    menu.changeFile.click();
    expect(picker.accept).toBe('.map');
    expect(click).toHaveBeenCalledOnce();
    controls.update([]);
    expect(menu.changeFile.hidden).toBe(true);
  });

  it('consents a stream Blob without reading the whole file', async () => {
    const { controls, select, approve, send, menu } = fixture();
    controls.update([registration()]);
    controls.ready();
    const file = new File([new Uint8Array([1, 2, 3])], 'test.map');
    const read = vi.spyOn(file, 'arrayBuffer');
    select(file);
    expect(send).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await approve();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    expect(send).toHaveBeenCalledWith({ type: 'file-input', handle: 7, name: 'test.map', mimeType: '', file });
    expect(read).not.toHaveBeenCalled();
    expect(menu.changeFile.disabled).toBe(false);
  });

  it.each(['inline', 'relaunch'] as const)('delivers bounded %s bytes without host-owned mounting', async delivery => {
    const { controls, select, approve, send } = fixture();
    controls.update([registration(7, delivery)]);
    controls.ready();
    const file = new File([new Uint8Array([1, 2, 3])], 'test.map');
    const read = vi.spyOn(file, 'arrayBuffer');
    select(file);
    expect(read).not.toHaveBeenCalled();
    await approve();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    expect(send).toHaveBeenCalledWith({
      type: 'file-input',
      handle: 7,
      name: 'test.map',
      mimeType: '',
      bytes: new Uint8Array([1, 2, 3]),
    });
  });

  it('restricts a guest request to its handle and returns native-picker cancellation', () => {
    const { controls, picker, send, menu } = fixture();
    controls.update([registration()]);
    controls.ready();
    const click = vi.spyOn(picker, 'click').mockImplementation(() => undefined);
    controls.request(7);
    expect(click).not.toHaveBeenCalled();
    expect(menu.status.textContent).toContain('Open file');
    menu.changeFile.click();
    picker.dispatchEvent(new Event('cancel'));
    expect(send).toHaveBeenCalledWith({
      type: 'mediated-input-result',
      handle: 7,
      status: 3,
      bytes: new Uint8Array(),
    });
  });

  it('cancels a withdrawn registration while consent is open, even with a reused handle', async () => {
    const { controls, select, approve, send, menu } = fixture();
    controls.update([registration()]);
    controls.ready();
    select(new File([new Uint8Array([1])], 'test.map'));
    await vi.waitFor(() => {
      expect(document.querySelector('.dotli-file-consent-approve')).not.toBeNull();
    });
    controls.update([registration()]);
    expect(document.querySelector('.dotli-file-consent-approve')).toBeNull();
    await vi.waitFor(() => {
      expect(menu.changeFile.disabled).toBe(false);
    });
    expect(send).not.toHaveBeenCalled();
    select(new File([new Uint8Array([2])], 'test.map'));
    await approve();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
  });

  it.each(['cancel', 'cleanup'] as const)('does not deliver a late inline read after %s', async action => {
    vi.useFakeTimers();
    const { controls, select, approve, send } = fixture();
    controls.update([registration(7, 'inline')]);
    controls.ready();
    controls.request(7);
    const pending = Promise.withResolvers<ArrayBuffer>();
    const file = new File([new Uint8Array([1])], 'test.map');
    const read = vi.spyOn(file, 'arrayBuffer').mockReturnValue(pending.promise);
    select(file);
    await approve();
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalledOnce();
    });
    if (action === 'cleanup') {
      controls.cleanup();
    } else {
      controls.cancel(7);
    }
    pending.resolve(new Uint8Array([1]).buffer);
    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps unmatched selections recoverable without reading or sending them', async () => {
    const { controls, select, send, menu } = fixture();
    controls.update([registration()]);
    controls.ready();
    const file = new File(['not a map'], 'other.txt');
    const read = vi.spyOn(file, 'arrayBuffer');
    select(file);
    await vi.waitFor(() => {
      expect(menu.status.textContent).toContain('does not accept');
    });
    expect(read).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(menu.changeFile.disabled).toBe(false);
  });
});

describe('private-cache worker shutdown', () => {
  function workerFixture(): {
    worker: EventTarget & { postMessage: Mock<(message: unknown) => void>; terminate: Mock<() => void> };
    report: Mock<(message: string) => void>;
    stop: () => Promise<void>;
    output: (data: unknown) => void;
  } {
    const worker = Object.assign(new EventTarget(), { postMessage: vi.fn(), terminate: vi.fn() });
    const report = vi.fn<(message: string) => void>();
    const stop = installWorkerShutdown(worker, report);
    const output = (data: unknown): void => {
      worker.dispatchEvent(new MessageEvent('message', { data }));
    };
    return { worker, report, stop, output };
  }

  it('waits for runtime cleanup acknowledgement and makes repeated stop idempotent', async () => {
    const { worker, stop, output, report } = workerFixture();
    const stopped = stop();
    expect(stop()).toBe(stopped);
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'stop' });
    expect(worker.terminate).not.toHaveBeenCalled();
    output({ type: 'terminated' });
    await stopped;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });

  it('reports cleanup failure rather than treating forced termination as clean', async () => {
    vi.useFakeTimers();
    const { worker, stop, report } = workerFixture();
    const stopped = stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.stringContaining('could not be confirmed'));
  });

  it('handles runtime-owned relaunch termination before a host stop', async () => {
    const { worker, stop, output, report } = workerFixture();
    output({ type: 'terminated', cleanupFailed: true });
    await stop();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
  });
});
