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

type ArchiveMachine = MachineTypes<ArchiveState, ArchiveEvent>;

/** The Archive tab's read of the shown product's files, and the file selected in them. */
export function createArchiveReader({ load }: { load: ArchiveLoader }) {
  const startReading: HandlerOf<ArchiveMachine, ArchiveState['kind'], 'shown'> = (
    _state,
    { cid },
    { emitState, update },
  ) => {
    const reading: ReadingState = { kind: 'reading', cid };
    emitState(reading);
    update(
      // A load that throws rejects this promise, so it ends as a failed read too.
      new Promise<ArchiveFiles>(resolve => {
        resolve(load(cid));
      }).then(
        (files): ArchiveEvent => ({ kind: 'archiveRead', reading, archive: toLoadedArchive(files) }),
        (error: unknown): ArchiveEvent => ({ kind: 'readFailed', reading, reason: getErrorMessage(error) }),
      ),
    );
  };
  /** A tab that reads or has read `cid` keeps that read. */
  const readNewCid: HandlerOf<ArchiveMachine, 'reading' | 'read', 'shown'> = (state, event, transition) => {
    if (state.cid === event.cid) {
      return;
    }
    startReading(state, event, transition);
  };
  return createStateMachine<ArchiveMachine>({
    initial: { kind: 'unread' },
    handlers: {
      unread: { shown: startReading },
      reading: {
        shown: readNewCid,
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
        shown: readNewCid,
        fileSelected(state, { path }, { emitState }) {
          emitState({ ...state, selectedPath: path });
        },
      },
      failed: { shown: startReading },
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: archiveViewTransitionMetric,
        message: '[dot.li] An archive view transition threw',
      });
    },
  });
}
