// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Runs the page product's worker for as long as the page core's ledger wants it. The page holds one reference on the
// ledger, and the core counts the rest. Each turn of the demand to wanted and each core loss queues one pass that
// brings the run in line with the demand, one pass at a time, so overlapping changes do the work once. A run that
// fails, or finds no worker, is not tried again until the demand turns wanted again, so a broken worker cannot loop.

import { createMessagePortProvider, type WireProvider } from '@parity/truapi';
import type { WorkerDemandChange } from '@parity/truapi-host';
import { createReporter, defineCount } from '@dotli/metrics';
import type { ModuleFiles, QuickJsWorker, QuickJsWorkerParams } from '@dotli/quickjs-runtime';
import { createAsyncTaskPool, createRandomId, realTimers, type AsyncTaskPool, type Timers } from '@dotli/shared';
import { pipeProviders, type WorkerExecutable } from '../productLoad/index.js';
import type { CoreConnection, CoreLease, CoreProvider } from '../productRuntime/index.js';

const report = createReporter({ flow: 'product_worker' });

/**
 * Count. One run of the page product's worker. Tagged `outcome` (ok once its entrypoint finished, error when a step of
 * the run failed) and `reason` (the error's name).
 */
const productWorkerRunMetric = defineCount<'error' | 'ok'>('product_worker.run');

/**
 * Count. The worker's VM, or its Web Worker, failed outside the run, such as a timer callback that threw, and the VM
 * serves on. Tagged `outcome` (error) and `reason` (the error's name).
 */
const productWorkerFaultMetric = defineCount<'error'>('product_worker.fault');

/** What the worker uses of a page core lease: the ledger, a connection and the core's loss. */
export type WorkerLease = Pick<CoreLease, 'productId' | 'connect' | 'own' | 'subscribeDown' | 'release'> & {
  runtime: Pick<CoreLease['runtime'], 'acquireWorker' | 'releaseWorker' | 'subscribeWorkerDemand'>;
};

/** The fetch gate of one run. Disposing it denies the asks still open. */
export type WorkerFetchGate = {
  isHostAllowed: QuickJsWorkerParams['isHostAllowed'];
  dispose(): void;
};

export type ProductWorkerParams = {
  /** The page's product, whose worker runs. */
  label: string;
  /**
   * The page core. `acquire` rejects with `CoreRedialError` when the core the page redialed could not boot, and with
   * the boot's error when the core it dials cannot boot.
   */
  core: { acquire(): Promise<WorkerLease> };
  /** Resolves the worker executable `label` publishes, or null for none. Never rejects. */
  readExecutable: (label: string) => Promise<WorkerExecutable | null>;
  /** Resolves the files `cid` names, each checked against its hash. Rejects when they cannot be read. */
  readFiles: (cid: string) => Promise<ModuleFiles>;
  /** Opens the fetch gate of one run. */
  openGate: () => WorkerFetchGate;
  /** Starts one VM in a Web Worker. Throws when the worker cannot be started. */
  startVm: (params: Omit<QuickJsWorkerParams, 'createWorker'>) => QuickJsWorker;
  /** The clock the wire's debug events are stamped with. The page's own by default. */
  timers?: Pick<Timers, 'now'>;
  /** Runs the passes over the demand, one at a time. A pool of its own by default. */
  passes?: Pick<AsyncTaskPool, 'call'>;
};

/** What one run holds, which goes together. */
type RunParts = {
  coreProvider: CoreProvider;
  gate: WorkerFetchGate;
  vm: QuickJsWorker;
  product: WireProvider;
  unpipe: () => void;
};

/**
 * `idle` starts a run once the demand wants one. `spent` is the demand's run that failed or found no worker, which no
 * pass starts again until the demand turns wanted again.
 */
type Run = { kind: 'idle' } | { kind: 'running'; parts: RunParts } | { kind: 'spent' };

/** The lease the worker runs on, with the page's reference held on its ledger and its demand followed. */
type Held = { lease: WorkerLease; stopDemand: () => void };

/**
 * Starts following the page core's demand for the worker of `label`, and takes the page's reference on it. Returns the
 * stop, which ends the run, lets go of the reference and the lease, and is safe to call again.
 */
export function startProductWorker({
  label,
  core,
  readExecutable,
  readFiles,
  openGate,
  startVm,
  timers = realTimers,
  // One pass at a time, so a pass never sees the lease or the run another pass is taking.
  passes = createAsyncTaskPool({ poolSize: 1 }),
}: ProductWorkerParams): () => void {
  let stopped = false;
  let held: Held | null = null;
  // The demand last heard on the held lease. The ledger tells each new subscriber the demand there is now.
  let wanted = false;
  let run: Run = { kind: 'idle' };

  queuePass();
  return stop;

  function stop(): void {
    stopped = true;
    endRun();
    dropLease();
  }

  function queuePass(): void {
    // A pass rejects only when a collaborator breaks its contract of never rejecting.
    passes.call(followDemand).catch((error: unknown) => {
      report.defect(error, {
        step: 'worker_pass',
        metric: productWorkerRunMetric,
        message: '[dot.li worker] A pass over the worker demand threw:',
      });
    });
  }

  /** Takes a lease when none is held, and starts a run when the demand wants one and none ran for it. */
  async function followDemand(): Promise<void> {
    if (stopped) {
      return;
    }
    if (held === null) {
      // The demand the new subscription hears queues the pass that starts the run.
      await takeLease();
      return;
    }
    if (!wanted || run.kind !== 'idle') {
      return;
    }
    await startRun(held.lease);
  }

  async function takeLease(): Promise<void> {
    let lease: WorkerLease;
    try {
      lease = await core.acquire();
    } catch (error) {
      reportRunFailure(error, 'worker_lease');
      return;
    }
    if (stopped) {
      lease.release();
      return;
    }
    lease.runtime.acquireWorker(lease.productId);
    // Unsubscribed as the lease goes, so the listener never hears demand on a lease no longer held.
    const stopDemand = lease.runtime.subscribeWorkerDemand(change => {
      hearDemand(lease, change);
    });
    held = { lease, stopDemand };
    // Subscribed last, as it calls the listener at once for a core that went down since it was acquired.
    lease.subscribeDown(() => {
      if (held?.lease !== lease) {
        return;
      }
      report.log.event('The core under the worker went down, so the worker moves to its replacement', { label });
      endRun();
      dropLease();
      queuePass();
    });
  }

  function hearDemand(lease: WorkerLease, change: WorkerDemandChange): void {
    if (change.productId !== lease.productId) {
      return;
    }
    wanted = change.wanted;
    if (wanted) {
      queuePass();
      return;
    }
    endRun();
  }

  async function startRun(lease: WorkerLease): Promise<void> {
    const executable = await readExecutable(label);
    if (!isWanted(lease)) {
      return;
    }
    if (executable === null) {
      report.log.event('The product publishes no worker, so none runs', { label });
      spend(lease);
      return;
    }
    let files: ModuleFiles;
    try {
      files = await readFiles(executable.cid);
    } catch (error) {
      failStart(lease, error, 'worker_files');
      return;
    }
    if (!isWanted(lease)) {
      return;
    }
    let connection: CoreConnection;
    try {
      connection = await lease.connect({ executionKind: 'Worker' });
    } catch (error) {
      failStart(lease, error, 'worker_connect');
      return;
    }
    const coreProvider = lease.own(connection);
    if (!isWanted(lease)) {
      coreProvider.dispose();
      return;
    }
    const gate = openGate();
    let vm: QuickJsWorker;
    try {
      vm = startVm({
        files,
        entrypoint: executable.entrypoint,
        isHostAllowed: gate.isHostAllowed,
        onConsole: (level, message) => {
          // The product's own output, never a failure of the page, so it stays off the always-on channels.
          report.log.debug(`[dot.li worker ${label}] ${level}:`, message);
        },
        onError: error => {
          report.expected(error, {
            step: 'worker_fault',
            metric: productWorkerFaultMetric,
            message: `[dot.li worker] The worker of ${label} failed outside its run:`,
          });
        },
      });
    } catch (error) {
      gate.dispose();
      coreProvider.dispose();
      failStart(lease, error, 'worker_start');
      return;
    }
    const product = createMessagePortProvider(vm.wire);
    const unpipe = pipeProviders({
      product,
      core: coreProvider,
      flowId: createRandomId(),
      label,
      productId: lease.productId,
      timers,
    });
    const parts: RunParts = { coreProvider, gate, vm, product, unpipe };
    run = { kind: 'running', parts };
    report.log.event('Worker started', { label, entrypoint: executable.entrypoint });
    // The VM serves on once its entrypoint finished, so no pass waits on the run.
    vm.run.then(
      () => {
        productWorkerRunMetric.count({ outcome: 'ok' });
      },
      (error: unknown) => {
        if (run.kind !== 'running' || run.parts !== parts) {
          return;
        }
        endRun({ kind: 'spent' });
        reportRunFailure(error, 'worker_run');
      },
    );
  }

  function failStart(
    lease: WorkerLease,
    error: unknown,
    step: 'worker_files' | 'worker_connect' | 'worker_start',
  ): void {
    reportRunFailure(error, step);
    spend(lease);
  }

  /** Spends the demand on `lease` while it still holds, so a repeat of it starts nothing. */
  function spend(lease: WorkerLease): void {
    if (isWanted(lease)) {
      run = { kind: 'spent' };
    }
  }

  /** Whether `lease` is still the one held and its demand still wants the worker. */
  function isWanted(lease: WorkerLease): boolean {
    return !stopped && held?.lease === lease && wanted;
  }

  /** Ends the run that runs, if any, and moves to `next`. */
  function endRun(next: Exclude<Run, { kind: 'running' }> = { kind: 'idle' }): void {
    const ended = run;
    run = next;
    if (ended.kind !== 'running') {
      return;
    }
    const { coreProvider, gate, vm, product, unpipe } = ended.parts;
    // Unpiped first, since the pipe disposes one side as the other closes.
    unpipe();
    product.dispose();
    vm.dispose();
    gate.dispose();
    coreProvider.dispose();
    report.log.event('Worker ended', { label });
  }

  function dropLease(): void {
    if (held === null) {
      return;
    }
    const { lease, stopDemand } = held;
    held = null;
    wanted = false;
    stopDemand();
    lease.runtime.releaseWorker(lease.productId);
    lease.release();
  }
}

/** Reports a step of a run that failed: the lease, the files, the connection, the VM's start or its entrypoint. */
function reportRunFailure(
  error: unknown,
  step: 'worker_lease' | 'worker_files' | 'worker_connect' | 'worker_start' | 'worker_run',
): void {
  report.expected(error, {
    step,
    metric: productWorkerRunMetric,
    message: '[dot.li worker] The product worker did not run:',
  });
}
