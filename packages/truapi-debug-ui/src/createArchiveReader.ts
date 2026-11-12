// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ArchiveFiles } from '@dotli/content';
import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, getErrorMessage, type HandlerOf, type MachineTypes } from '@dotli/shared';
import type { ArchiveLoader } from './host.js';
import { toLoadedArchive, type LoadedArchive } from './toLoadedArchive.js';

const report = createReporter({ flow: 'ui' });
const archiveViewTransitionMetric = defineCount<'error'>('archive_view.transition');

type ReadingState = { kind: 'reading'; cid: string };

/** The tab reads on its first show, again for a new CID, and again on the next show after a failed read. */
type ArchiveState =
  | { kind: 'unread' }
  | ReadingState
  | { kind: 'read'; cid: string; archive: LoadedArchive; selectedPath: string | null }
  | { kind: 'failed'; cid: string; reason: string };

/** A read's outcome carries the read it settles, so a read the tab has moved past changes nothing. */
type ArchiveEvent =
  | { kind: 'shown'; cid: string }
  | { kind: 'archiveRead'; reading: ReadingState; archive: LoadedArchive }
  | { kind: 'readFailed'; reading: ReadingState; reason: string }
  | { kind: 'fileSelected'; path: string };

type ArchiveEffect = { kind: 'read'; reading: ReadingState };

type ArchiveMachine = MachineTypes<ArchiveState, ArchiveEvent, ArchiveEffect>;

/** The Archive tab's read of the shown product's files, and the file selected in them. */
export function createArchiveReader({ load }: { load: ArchiveLoader }) {
  /** Reads `cid`, unless the tab already reads or has read it. A failed read is read again. */
  const startReading: HandlerOf<ArchiveMachine, ArchiveState['kind'], 'shown'> = (
    state,
    { cid },
    { emitState, emitSideEffect },
  ) => {
    if ((state.kind === 'reading' || state.kind === 'read') && state.cid === cid) {
      return;
    }
    const reading: ReadingState = { kind: 'reading', cid };
    emitState(reading);
    emitSideEffect({ kind: 'read', reading });
  };
  const machine = createStateMachine<ArchiveMachine>({
    initial: { kind: 'unread' },
    handlers: {
      unread: { shown: startReading },
      reading: {
        shown: startReading,
        archiveRead(state, { reading, archive }, { emitState }) {
          if (state !== reading) {
            return;
          }
          emitState({ kind: 'read', cid: state.cid, archive, selectedPath: null });
        },
        readFailed(state, { reading, reason }, { emitState }) {
          if (state !== reading) {
            return;
          }
          emitState({ kind: 'failed', cid: state.cid, reason });
        },
      },
      read: {
        shown: startReading,
        fileSelected(state, { path }, { emitState }) {
          emitState({ ...state, selectedPath: path });
        },
      },
      failed: { shown: startReading },
    },
    onEffect: ({ reading }) => {
      machine.update(
        // A load that throws rejects this promise, so it ends as a failed read too.
        new Promise<ArchiveFiles>(resolve => {
          resolve(load(reading.cid));
        }).then(
          (files): ArchiveEvent => ({ kind: 'archiveRead', reading, archive: toLoadedArchive(files) }),
          (error: unknown): ArchiveEvent => ({ kind: 'readFailed', reading, reason: getErrorMessage(error) }),
        ),
      );
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: archiveViewTransitionMetric,
        message: '[dot.li] An archive view transition threw',
      });
    },
  });
  return machine;
}
