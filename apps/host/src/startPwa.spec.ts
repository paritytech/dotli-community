// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import { createDeferred } from '@dotli/shared';
import { createFakePage } from '@dotli/shared/testing';
import { startPwa, type PwaParams, type PwaRegistration, type PwaWorkbox, type PwaWorker } from './startPwa.js';
import { bindReports } from './testing/bindReports.js';

type NotificationAction = NonNullable<Parameters<PwaParams['showNotification']>[0]['action']>;

type Registration = {
  active: object | null;
  installing: PwaWorker | null;
  waiting: object | null;
} & PwaRegistration;

type CreateFakeWorkerParams = {
  /** The registration the worker moves through, as the browser would move it. */
  registration: Registration;
  /** The state the worker starts in. */
  state: ServiceWorkerState;
};

type CreateFakeWorkboxParams = {
  /** The registration `register` resolves with. */
  registration: PwaRegistration;
};

type CreateFakeRegistrationParams = {
  /** The registration's update check. Resolves when left out. */
  update?: Mock<() => Promise<void>>;
};

type PwaStand = ReturnType<typeof start>;

describe('the update available toast', () => {
  it('As a dotli user, I see the browser find a new release and am offered it at once, before it has downloaded', async () => {
    // Given
    const pwa = await startListening();

    // When
    pwa.find();

    // Then
    expect(pwa.actions.map(action => action.label)).toEqual(['Reload']);
  });

  it('As a dotli user, I start the page while the browser downloads a release and am offered it', async () => {
    // Given
    const pwa = start();
    pwa.find();

    // When
    await pwa.listening;

    // Then
    expect(pwa.actions.map(action => action.label)).toEqual(['Reload']);
  });

  it('As a first-time visitor, I wait while the first worker installs and am offered nothing', async () => {
    // Given
    const pwa = start();
    pwa.registration.active = null;
    await pwa.listening;

    // When
    pwa.find();

    // Then
    expect(pwa.actions).toEqual([]);
  });

  it('As a dotli user, I press Reload while the release downloads and it applies once downloaded and reloads once in control', async () => {
    // Given
    const pwa = await startListening();
    const release = pwa.find();

    // When
    pressReload(pwa);

    // Then the page has not acted on it yet
    expect(pwa.skipWaiting).not.toHaveBeenCalled();
    expect(pwa.reload).not.toHaveBeenCalled();

    // When
    release.settle('installed');
    await pwa.applied;

    // Then
    expect(pwa.skipWaiting).toHaveBeenCalledOnce();
    expect(pwa.reload).not.toHaveBeenCalled();

    // When
    pwa.takeControl();

    // Then
    expect(pwa.reload).toHaveBeenCalledOnce();
  });

  it('As a dotli user, I press Reload on a downloaded release and it applies at once', async () => {
    // Given
    const pwa = await startListening();
    pwa.find().settle('installed');

    // When
    pressReload(pwa);
    await pwa.applied;

    // Then
    expect(pwa.skipWaiting).toHaveBeenCalledOnce();
  });

  it('As a dotli user whose release failed to download, I press Reload and land on the version I have', async () => {
    // Given
    const pwa = await startListening();
    const release = pwa.find();
    pressReload(pwa);

    // When
    release.settle('redundant');
    await pwa.applied;

    // Then
    expect(pwa.reload).toHaveBeenCalledOnce();
    expect(pwa.skipWaiting).not.toHaveBeenCalled();
  });

  it('As a dotli user with two tabs, I press Reload in the tab whose update another tab already applied and it reloads at once', async () => {
    // Given the other tab's Reload activated the update, so nothing waits now
    const pwa = await startListening();
    const release = pwa.find();
    release.settle('installed');
    release.settle('activated');

    // When
    pressReload(pwa);
    await pwa.applied;

    // Then
    expect(pwa.reload).toHaveBeenCalledOnce();
    expect(pwa.skipWaiting).not.toHaveBeenCalled();
  });
});

describe('checking for a new release', () => {
  it('As a dotli user, I open the page and the shell asks for a new release as soon as it registers', async () => {
    // When
    const pwa = await startListening();

    // Then
    expect(pwa.update).toHaveBeenCalledOnce();
  });

  it('As a dotli user, I come back to the tab and stay, and the shell asks again each time and on schedule', async () => {
    // Given
    const pwa = await startListening();

    // When
    pwa.page.setVisibility('hidden');
    pwa.page.setVisibility('visible');
    pwa.tick();

    // Then the check on registering, then the one each event earned
    expect(pwa.update).toHaveBeenCalledTimes(3);
  });

  it('As a dotli user offline, I come back to the tab and the shell sends no check that is bound to fail', async () => {
    // Given
    const pwa = await startListening();
    pwa.page.setOnline(false);

    // When
    pwa.page.setVisibility('visible');
    pwa.tick();

    // Then only the check on registering
    expect(pwa.update).toHaveBeenCalledOnce();
  });

  it('As a dotli user on a page that stopped offering updates, I come back to the tab and the shell asks for no new release', async () => {
    // Given
    const pwa = await startListening();
    pwa.dispose();

    // When
    pwa.page.setVisibility('hidden');
    pwa.page.setVisibility('visible');
    pwa.tick();

    // Then only the check on registering
    expect(pwa.update).toHaveBeenCalledOnce();
  });
});

describe('an update that was already waiting when the page loaded', () => {
  it('As a dotli user, I reload with an update waiting and it applies without asking', async () => {
    // Given
    const pwa = start();
    pwa.find('installed');

    // When
    await pwa.applied;

    // Then
    expect(pwa.actions).toHaveLength(0);
    expect(pwa.skipWaiting).toHaveBeenCalledOnce();
    expect(pwa.reload).not.toHaveBeenCalled();

    // When
    pwa.takeControl();

    // Then
    expect(pwa.reload).toHaveBeenCalledOnce();
  });
});

describe('where the shell registers no service worker', () => {
  it.each<{ name: string; overrides: Partial<PwaParams> }>([
    {
      name: 'As a dotli developer, I run the dev server and it gets no worker that could serve stale modules',
      overrides: { production: false },
    },
    {
      // The shell on the bare host, as /__preview serves it
      name: 'As a visitor of the bare host, I open its root and it stays the landing page because no worker answers it',
      overrides: { label: null },
    },
    {
      name: 'As a visitor whose browser has no service workers, I open the page and the shell registers none',
      overrides: { serviceWorkers: false },
    },
  ])('$name', ({ overrides }) => {
    // When
    const pwa = start(overrides);

    // Then
    expect(pwa.createWorkbox).not.toHaveBeenCalled();
  });
});

describe('a shell worker that fails', () => {
  it('As an operator, I see a shell worker that cannot load captured and counted', async () => {
    // Given the connection drops before the worker code loads
    const reports = bindPwaReports();

    // When the page starts and the load rejects
    start({ createWorkbox: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')) });
    await reports.reported;

    // Then the load failure is captured as one issue and counted with its error name
    expect(reports.captures.exception.mock.calls.map(([, context]) => context)).toEqual([
      { flow: 'pwa', step: 'sw_load' },
    ]);
    expect(reports.counted('pwa.sw_load')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });

  it('As an operator, I see a shell worker that cannot register captured and counted', async () => {
    // Given a browser that refuses the worker's registration
    const reports = bindPwaReports();
    const { workbox } = createFakeWorkbox({ registration: createFakeRegistration().registration });
    const refusing: PwaWorkbox = {
      ...workbox,
      register: () => Promise.reject(new DOMException('The operation is insecure.', 'SecurityError')),
    };

    // When the page starts and the registration is refused
    start({ createWorkbox: () => Promise.resolve(refusing) });
    await reports.reported;

    // Then the registration failure is captured as one issue and counted with its error name
    expect(reports.captures.exception.mock.calls.map(([, context]) => context)).toEqual([
      { flow: 'pwa', step: 'sw_register' },
    ]);
    expect(reports.counted('pwa.sw_register')).toEqual([{ outcome: 'error', reason: 'SecurityError' }]);
  });

  it('As an operator, I watch an update check fail and it is counted as expected', async () => {
    // Given a server that cannot answer mid-deploy
    const reports = bindPwaReports();
    const update = vi.fn<() => Promise<void>>(() => Promise.reject(new TypeError('Failed to update a ServiceWorker')));

    // When the page starts and its first check rejects
    start({}, { update });
    await reports.reported;

    // Then the failure is counted as expected and not captured as an issue
    expect(reports.counted('pwa.sw_update')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
    expect(reports.captures.exception).not.toHaveBeenCalled();
  });
});

/** Binds the test's reports, with `reported` settling on the first capture or count. */
function bindPwaReports() {
  const reported = createDeferred<undefined>();
  const reports = bindReports({
    onReport() {
      reported.resolve(undefined);
    },
  });
  return { ...reports, reported: reported.promise };
}

/** Builds a new release's worker, which moves through `registration` as the browser would move it. */
function createFakeWorker({ registration, state }: CreateFakeWorkerParams) {
  const listeners: (() => void)[] = [];
  const worker = {
    state,
    addEventListener(_type: 'statechange', listener: () => void) {
      listeners.push(listener);
    },
  };
  place();
  return {
    /** Moves the worker to `next` and tells its listeners. */
    settle(next: ServiceWorkerState): void {
      worker.state = next;
      place();
      for (const listener of listeners.splice(0)) {
        listener();
      }
    },
  };

  function place(): void {
    registration.installing = worker.state === 'installing' ? worker : null;
    if (worker.state === 'installed') {
      registration.waiting = worker;
    }
    if (worker.state === 'activated') {
      registration.waiting = null;
      registration.active = worker;
    }
  }
}

/** Builds the shell's registration on a visit that already runs a worker. */
function createFakeRegistration({ update = vi.fn(() => Promise.resolve()) }: CreateFakeRegistrationParams = {}) {
  const found: (() => void)[] = [];
  const registration: Registration = {
    active: {},
    installing: null,
    waiting: null,
    addEventListener(_type: 'updatefound', listener: () => void) {
      found.push(listener);
    },
    update,
  };
  return {
    registration,
    update,
    /** The browser finds a new release, in `state`, downloading unless told otherwise. */
    find(state: ServiceWorkerState = 'installing') {
      const release = createFakeWorker({ registration, state });
      for (const listener of found) {
        listener();
      }
      return release;
    },
  };
}

/** Builds a stand-in for Workbox that lets the test emit `controlling`. */
function createFakeWorkbox({ registration }: CreateFakeWorkboxParams) {
  const controlling: (() => void)[] = [];
  const skipWaiting = vi.fn();
  const workbox: PwaWorkbox = {
    addEventListener(_type: 'controlling', listener: () => void) {
      controlling.push(listener);
    },
    removeEventListener(_type: 'controlling', listener: () => void) {
      const index = controlling.indexOf(listener);
      if (index !== -1) {
        controlling.splice(index, 1);
      }
    },
    messageSkipWaiting: skipWaiting,
    register: () => Promise.resolve(registration),
  };
  return {
    workbox,
    skipWaiting,
    /** The new worker takes control of the page. */
    takeControl(): void {
      for (const listener of controlling) {
        listener();
      }
    },
  };
}

/** Starts a product host in production. Change its registration before awaiting, as the page found it on load. */
function start(overrides: Partial<PwaParams> = {}, registration: CreateFakeRegistrationParams = {}) {
  const registrationStand = createFakeRegistration(registration);
  const workboxStand = createFakeWorkbox({ registration: registrationStand.registration });
  const page = createFakePage();
  const actions: NotificationAction[] = [];
  /** Settles once the page acted on the update, by reloading or by telling the worker to take over. */
  const applied = createDeferred<undefined>();
  const listening = createDeferred<undefined>();
  let runCheck: () => void = () => undefined;
  const reload = vi.fn(() => {
    applied.resolve(undefined);
  });
  workboxStand.skipWaiting.mockImplementation(() => {
    applied.resolve(undefined);
  });
  const createWorkbox = vi.fn(() => Promise.resolve(workboxStand.workbox));
  const dispose = startPwa({
    production: true,
    label: 'browse',
    serviceWorkers: true,
    createWorkbox,
    showNotification(params) {
      if (params.action !== undefined) {
        actions.push(params.action);
      }
    },
    reload,
    page: {
      isOnline: () => page.window.onLine,
      visibility: page.document,
      poll: {
        start(run) {
          runCheck = run;
          listening.resolve(undefined);
          return stopTicking;

          function stopTicking(): void {
            runCheck = () => undefined;
          }
        },
      },
    },
    ...overrides,
  });
  return {
    dispose,
    ...workboxStand,
    ...registrationStand,
    page,
    actions,
    reload,
    createWorkbox,
    applied: applied.promise,
    /** Settles once the shell registered and listens for releases. */
    listening: listening.promise,
    /** The periodic check comes due. */
    tick(): void {
      runCheck();
    },
  };
}

/** Starts as `start` does, and resolves once the shell listens for releases. */
async function startListening(): Promise<PwaStand> {
  const pwa = start();
  await pwa.listening;
  return pwa;
}

/** Presses Reload on the last toast. Throws when the last toast offers no Reload. */
function pressReload(pwa: PwaStand): void {
  const action = pwa.actions.at(-1);
  if (action?.label !== 'Reload') {
    throw new Error(`The last toast offers ${action?.label ?? 'nothing'}, not Reload`);
  }
  action.onClick();
}
