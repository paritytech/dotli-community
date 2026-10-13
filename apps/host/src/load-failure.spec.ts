// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from '@dotli/config';
import { configureModeStorage } from '@dotli/config';
import { memoryModeStorage } from '@dotli/config/testing';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import type { ErrorPageContent } from '@dotli/ui';
import {
  FAILOVER_BTN_LABELS,
  GO_BACK_BTN_LABEL,
  OPEN_SETTINGS_BTN_LABEL,
  RELOAD_BTN_LABEL,
  TRY_ANYWAY_BTN_LABEL,
  type ErrorDescription,
  type ErrorKind,
  type Recovery,
} from './errors.js';
import { presentLoadFailure, type ErrorSightings } from './load-failure.js';

type Page = ErrorPageContent;

function described(kind: ErrorKind, recovery: Recovery, extra: Partial<ErrorDescription> = {}): ErrorDescription {
  return { kind, title: `Title ${kind}`, message: `Message ${kind}`, recovery, tips: ['Waiting a moment.'], ...extra };
}

function memorySightings(seen: string | null = null): ErrorSightings & { last: () => string | null } {
  let kind = seen;
  return {
    seen: next => kind === next,
    remember: next => {
      kind = next;
    },
    last: () => kind,
  };
}

function present(
  error: ErrorDescription,
  backend: Backend,
  sightings: ErrorSightings = memorySightings(),
): {
  pages: Page[];
  shown: () => Page;
  click: (label: string) => void;
  reload: ReturnType<typeof vi.fn>;
  openSettings: ReturnType<typeof vi.fn>;
  switchBackend: ReturnType<typeof vi.fn>;
  resetProtocolOnReload: ReturnType<typeof vi.fn>;
  debug: DotliDebugEvent[];
} {
  const pages: Page[] = [];
  const debug: DotliDebugEvent[] = [];
  const deps = {
    copy: {
      reload: RELOAD_BTN_LABEL,
      reloadIcon: () => null,
      openSettings: OPEN_SETTINGS_BTN_LABEL,
      tryAnyway: TRY_ANYWAY_BTN_LABEL,
      goBack: GO_BACK_BTN_LABEL,
      failover: FAILOVER_BTN_LABELS,
    },
    trustedProviderHosts: () => ['rpc.example', 'ipfs.example'],
    showErrorPage: (page: Page) => {
      pages.push(page);
    },
    openSettings: vi.fn(),
    reload: vi.fn(),
    switchBackend: vi.fn(),
    resetProtocolOnReload: vi.fn(),
    sightings,
    emit: (event: DotliDebugEvent) => {
      debug.push(event);
    },
  };
  presentLoadFailure({ error, cause: new Error('hub sync timed out'), label: 'doom', backend }, deps);
  const shown = (): Page => {
    const page = pages.at(-1);
    if (page === undefined) {
      throw new Error('no page shown');
    }
    return page;
  };
  return {
    pages,
    shown,
    click: label => {
      const action = shown().actions?.find(candidate => candidate.label === label);
      if (action === undefined) {
        throw new Error(`no ${label} button`);
      }
      // Node has no MouseEvent, and no load-failure action reads its event.
      action.onClick(new Event('click') as MouseEvent);
    },
    debug,
    ...deps,
  };
}

function labels(page: Page): string[] {
  return (page.actions ?? []).map(action => `${action.label}${action.primary === true ? ' (primary)' : ''}`);
}

// Settings come from a memory store, not Node's localStorage, and the previous store is put back after each test.
beforeEach(() => configureModeStorage(memoryModeStorage()));

describe('presentLoadFailure', () => {
  it('As a visitor whose app cannot be opened, I see why with its tips and no button to press', () => {
    // When
    const { shown } = present(described('manifest-invalid', 'none'), 'smoldot-direct');

    // Then
    expect(shown()).toMatchObject({ title: 'Title manifest-invalid', detail: 'Message manifest-invalid' });
    expect(shown().tips).toEqual(['Waiting a moment.']);
    expect(labels(shown())).toEqual([]);
  });

  it('As a visitor on a failure a reload fixes, I press Reload and the page reloads', () => {
    // Given
    const { shown, click, reload } = present(described('module-fetch-failed', 'reload'), 'smoldot-direct');

    // When
    click(RELOAD_BTN_LABEL);

    // Then
    expect(labels(shown())).toEqual([RELOAD_BTN_LABEL]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a visitor on a light client failing for the first time, I am pointed at Settings rather than the gateway', () => {
    // Given
    const sightings = memorySightings();
    const { shown, click, openSettings } = present(
      described('hub-sync-timeout', 'switch-backend'),
      'smoldot-shared-worker',
      sightings,
    );

    // When
    click(OPEN_SETTINGS_BTN_LABEL);

    // Then
    expect(labels(shown())).toEqual([`${RELOAD_BTN_LABEL} (primary)`, OPEN_SETTINGS_BTN_LABEL]);
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(sightings.last()).toBe('hub-sync-timeout');
  });

  it('As a visitor on a light client failing the same way again, I am offered the gateway only after a warning I can back out of', () => {
    // Given
    const { shown, click, switchBackend, debug } = present(
      described('hub-sync-timeout', 'switch-backend'),
      'smoldot-direct',
      memorySightings('hub-sync-timeout'),
    );
    const offered = labels(shown());

    // When
    click(FAILOVER_BTN_LABELS['rpc-gateway']);
    const warning = shown();
    click(GO_BACK_BTN_LABEL);
    const backAgain = labels(shown());
    click(FAILOVER_BTN_LABELS['rpc-gateway']);
    click(TRY_ANYWAY_BTN_LABEL);

    // Then
    expect(offered).toEqual([`${RELOAD_BTN_LABEL} (primary)`, FAILOVER_BTN_LABELS['rpc-gateway']]);
    expect(warning.glyph).toBe('warning');
    expect(warning.detail).toEqual(
      expect.arrayContaining([expect.stringContaining('through rpc.example and ipfs.example instead')]),
    );
    expect(labels(warning)).toEqual([TRY_ANYWAY_BTN_LABEL, `${GO_BACK_BTN_LABEL} (primary)`]);
    expect(backAgain).toEqual(offered);
    expect(switchBackend.mock.calls).toEqual([['rpc-gateway']]);
    expect(debug.map(event => event.payload)).toEqual([
      { from: 'smoldot-direct', to: 'rpc-gateway', reason: 'hub sync timed out' },
    ]);
  });

  it('As a visitor on a gateway, I switch to the light client in one press, and the failure is not remembered', () => {
    // Given
    const sightings = memorySightings();
    const { shown, click, switchBackend } = present(
      described('rpc-timeout', 'switch-backend'),
      'rpc-gateway',
      sightings,
    );

    // When
    click(FAILOVER_BTN_LABELS['smoldot-shared-worker']);

    // Then
    expect(labels(shown())).toEqual([RELOAD_BTN_LABEL, `${FAILOVER_BTN_LABELS['smoldot-shared-worker']} (primary)`]);
    expect(switchBackend.mock.calls).toEqual([['smoldot-shared-worker']]);
    expect(sightings.last()).toBeNull();
  });

  it('As a visitor whose light client lost its subscription, I reload onto a clean chain database', () => {
    // Given
    const { click, reload, resetProtocolOnReload } = present(
      described('chain-halted', 'switch-backend', { resetProtocol: true }),
      'smoldot-direct',
    );

    // When
    click(RELOAD_BTN_LABEL);

    // Then
    expect(resetProtocolOnReload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(resetProtocolOnReload.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0] ?? 0);
  });

  it('As a visitor hitting two unrelated unknown failures, I am never offered the gateway shortcut for them', () => {
    // Given
    const sightings = memorySightings();

    // When
    present(described('unknown', 'switch-backend'), 'smoldot-direct', sightings);

    // Then
    expect(sightings.last()).toBeNull();
  });
});
