// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ArchiveFiles } from '@dotli/content';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createStateMachine,
  formatSize,
  getErrorMessage,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import { useStore } from '@dotli/stores-solid';
import { getImageType } from './getImageType.js';
import { previewFile, type ArchiveFile, type Preview } from './previewFile.js';
import { formatArchiveSummary } from './formatArchiveSummary.js';
import { toLoadedArchive, type LoadedArchive } from './toLoadedArchive.js';
import type { ArchiveLoader } from './host.js';
import type { HostProduct } from './host.js';
import { Bar } from './shared/Bar.js';
import { CodeBlock } from './shared/CodeBlock.js';
import { EmptyState } from './shared/EmptyState.js';
import { Item, ItemList } from './shared/ItemList.js';
import { Note } from './shared/Note.js';
import { Pane } from './shared/Pane.js';
import { Stack } from './shared/Stack.js';
import s from './ArchiveView.module.css';

const report = createReporter({ flow: 'ui' });
const archiveViewTransitionMetric = defineCount<'error'>('archive_view.transition');

/** Cut so a huge bundle stays responsive. */
const MAX_TEXT_CHARACTERS = 1_000_000;

/** The tab reads on its first show, again for a new CID, and again on the next show after a failed read. */
type ArchiveState =
  | { kind: 'unread' }
  | ReadingState
  | { kind: 'read'; cid: string; archive: LoadedArchive }
  | { kind: 'failed'; cid: string; reason: string }
  | { kind: 'disposed' };

type ReadingState = { kind: 'reading'; cid: string };

/** A read's outcome carries the read it settles, so a read the tab has moved past changes nothing. */
type ArchiveEvent =
  | { kind: 'shown'; cid: string }
  | { kind: 'archiveRead'; reading: ReadingState; archive: LoadedArchive }
  | { kind: 'readFailed'; reading: ReadingState; reason: string }
  | { kind: 'disposed' };

type ArchiveMachine = MachineTypes<ArchiveState, ArchiveEvent>;

export function ArchiveView(props: {
  active: boolean;
  load: ArchiveLoader;
  product: ReadableAtom<HostProduct>;
  /** Without them, the browser's own object URLs. Read once when the tab mounts. */
  objectUrls?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> | undefined;
}): JSX.Element {
  const objectUrls = untrack(() => props.objectUrls) ?? URL;
  const product = useStore(untrack(() => props.product));
  function getCid(): string | undefined {
    const state = product();
    return state.status === 'loaded' ? state.cid : undefined;
  }
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [imageUrl, setImageUrl] = createSignal<string | null>(null);

  const readShown: HandlerOf<ArchiveMachine, 'unread' | 'failed', 'shown'> = (_state, { cid }, transition) => {
    startReading(cid, transition);
  };
  const readNewCid: HandlerOf<ArchiveMachine, 'reading' | 'read', 'shown'> = (state, { cid }, transition) => {
    if (state.cid === cid) {
      return;
    }
    startReading(cid, transition);
  };
  const dispose: HandlerOf<ArchiveMachine, 'unread' | 'reading' | 'read' | 'failed', 'disposed'> = (
    _state,
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'disposed' });
  };
  const reader = createStateMachine<ArchiveMachine>({
    initial: { kind: 'unread' },
    handlers: {
      unread: { shown: readShown, disposed: dispose },
      reading: {
        shown: readNewCid,
        archiveRead(state, { reading, archive }, { emitState }) {
          if (state !== reading) {
            return;
          }
          emitState({ kind: 'read', cid: state.cid, archive });
        },
        readFailed(state, { reading, reason }, { emitState }) {
          if (state !== reading) {
            return;
          }
          emitState({ kind: 'failed', cid: state.cid, reason });
        },
        disposed: dispose,
      },
      read: { shown: readNewCid, disposed: dispose },
      failed: { shown: readShown, disposed: dispose },
      disposed: null,
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: archiveViewTransitionMetric,
        message: '[dot.li] An archive view transition threw',
      });
    },
  });
  const state = useStore(reader.state);
  onCleanup(() => {
    reader.update({ kind: 'disposed' });
  });

  createEffect(
    () => (props.active ? (getCid() ?? null) : null),
    cid => {
      if (cid === null) {
        return;
      }
      reader.update({ kind: 'shown', cid });
    },
  );

  const selected = createMemo((): ArchiveFile | undefined => {
    const loaded = getLoadedArchive();
    const path = selectedPath();
    return loaded !== undefined && path !== null ? loaded.files.find(file => file.path === path) : undefined;
  });
  const shown = createMemo((): Preview | undefined => {
    const file = selected();
    return file === undefined ? undefined : previewFile(file);
  });

  createEffect(
    () => (shown()?.kind === 'image' ? selected() : undefined),
    file => {
      const type = file === undefined ? undefined : getImageType(file.path);
      if (file === undefined || type === undefined) {
        setImageUrl(null);
        return;
      }
      const url = objectUrls.createObjectURL(new Blob([file.bytes.slice()], { type }));
      setImageUrl(url);
      return () => {
        objectUrls.revokeObjectURL(url);
      };
    },
  );

  /** Moves to a new read of `cid`, whose outcome settles that read only. */
  function startReading(cid: string, { emitState, update }: Transition<ArchiveMachine>): void {
    const reading: ReadingState = { kind: 'reading', cid };
    const load = props.load;
    emitState(reading);
    setSelectedPath(null);
    update(
      // A load that throws rejects this promise, so it ends as a failed read too.
      new Promise<ArchiveFiles>(resolve => {
        resolve(load(cid));
      }).then(
        (files): ArchiveEvent => ({ kind: 'archiveRead', reading, archive: toLoadedArchive(files) }),
        (error: unknown): ArchiveEvent => ({ kind: 'readFailed', reading, reason: getErrorMessage(error) }),
      ),
    );
  }
  function getShownText(): string | undefined {
    const current = shown();
    return current?.kind === 'text' ? current.text : undefined;
  }
  function getLoadedArchive(): LoadedArchive | undefined {
    const current = state();
    return current.kind === 'read' ? current.archive : undefined;
  }
  function getFailure(): string | undefined {
    const current = state();
    return current.kind === 'failed' ? current.reason : undefined;
  }

  return (
    <div class={s['archive']} data-testid="td-archive" hidden={!props.active}>
      <Switch>
        <Match when={product().status !== 'loaded'}>
          <EmptyState testId="td-archive-empty" class={s['whole']}>
            No product loaded yet.
          </EmptyState>
        </Match>
        <Match when={getCid() === undefined}>
          <EmptyState testId="td-archive-empty" class={s['whole']}>
            This product is not served from a CID, so it has no archive.
          </EmptyState>
        </Match>
        <Match when={getFailure() !== undefined}>
          <EmptyState testId="td-archive-empty" class={s['whole']}>
            Could not read the archive: {getFailure()}
          </EmptyState>
        </Match>
        <Match when={getLoadedArchive() === undefined}>
          <EmptyState testId="td-archive-empty" class={s['whole']}>
            Reading archive {getCid()}…
          </EmptyState>
        </Match>
        <Match when={getLoadedArchive()}>
          {archive => (
            <>
              <div class={s['sidebar']}>
                <Bar testId="td-archive-summary">{formatArchiveSummary(archive())}</Bar>
                <ItemList>
                  <For each={archive().files}>
                    {file => (
                      <Item
                        testId="td-archive-file"
                        value={file.path}
                        selected={selectedPath() === file.path}
                        title={file.path}
                        meta={formatSize(file.bytes.length)}
                        onSelect={() => {
                          setSelectedPath(file.path);
                        }}
                      >
                        {file.path}
                      </Item>
                    )}
                  </For>
                </ItemList>
              </div>
              <Pane testId="td-archive-content" label="File content" padded>
                <Switch fallback={<EmptyState testId="td-archive-empty">Select a file.</EmptyState>}>
                  <Match when={shown()?.kind === 'encrypted'}>
                    <EmptyState testId="td-archive-empty">
                      Encrypted, not decrypted: the sandbox asks for its password.
                    </EmptyState>
                  </Match>
                  <Match when={shown()?.kind === 'image'}>
                    <Show when={imageUrl()}>
                      {source => <img class={s['image']} src={source()} alt={selectedPath() ?? ''} />}
                    </Show>
                  </Match>
                  <Match when={shown()?.kind === 'binary'}>
                    <EmptyState testId="td-archive-empty">
                      Binary, {formatSize(selected()?.bytes.length ?? 0)}
                    </EmptyState>
                  </Match>
                  <Match when={getShownText()}>
                    {text => (
                      <Stack>
                        <Show when={text().length > MAX_TEXT_CHARACTERS}>
                          <Note>Showing the first {MAX_TEXT_CHARACTERS.toLocaleString()} characters.</Note>
                        </Show>
                        <CodeBlock>{text().slice(0, MAX_TEXT_CHARACTERS)}</CodeBlock>
                      </Stack>
                    )}
                  </Match>
                </Switch>
              </Pane>
            </>
          )}
        </Match>
      </Switch>
    </div>
  );
}
