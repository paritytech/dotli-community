// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getErrorMessage, formatSize } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import { useStore } from '@dotli/stores-solid';
import { getImageType } from './getImageType.js';
import { previewFile, type ArchiveFile, type Preview } from './previewFile.js';
import { formatArchiveSummary } from './formatArchiveSummary.js';
import { toLoadedArchive, type ArchiveRead, type LoadedArchive } from './toLoadedArchive.js';
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

export type ObjectUrls = {
  /** Returns a URL that serves `blob`. Never throws. */
  create: (blob: Blob) => string;
  /** Frees `url`, a URL `create` returned. Never throws. */
  revoke: (url: string) => void;
};

/** Cut so a huge bundle stays responsive. */
const MAX_TEXT_CHARACTERS = 1_000_000;

const pageObjectUrls: ObjectUrls = {
  create: blob => URL.createObjectURL(blob),
  revoke: url => {
    URL.revokeObjectURL(url);
  },
};

/** The read of one CID and how it went, or `null` before the first read. */
type Reading = { cid: string; read: ArchiveRead } | null;

export function ArchiveView(props: {
  active: boolean;
  load: ArchiveLoader;
  product: ReadableAtom<HostProduct>;
  /** Without them, the browser's own object URLs. */
  objectUrls?: ObjectUrls | undefined;
}): JSX.Element {
  const objectUrls = (): ObjectUrls => props.objectUrls ?? pageObjectUrls;
  const product = useStore(untrack(() => props.product));
  function getCid(): string | undefined {
    const state = product();
    return state.status === 'loaded' ? state.cid : undefined;
  }
  // The variable is for the effect's identity checks, which must see a write at once. The signal is for the render.
  let reading: Reading = null;
  const [readingSignal, setReadingSignal] = createSignal<Reading>(null);
  function setReading(next: Reading): void {
    reading = next;
    setReadingSignal(next);
  }
  function read(): ArchiveRead {
    return readingSignal()?.read ?? { status: 'loading' };
  }
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [imageUrl, setImageUrl] = createSignal<string | null>(null);

  // Read on first show, again for a new CID, and again on the next show after a failed read.
  createEffect(
    () => (props.active ? (getCid() ?? null) : null),
    next => {
      if (next === null || (reading?.cid === next && reading.read.status !== 'failed')) {
        return;
      }
      const started: NonNullable<Reading> = { cid: next, read: { status: 'loading' } };
      setSelectedPath(null);
      setReading(started);
      props.load(next).then(
        files => {
          if (reading === started) {
            setReading({ cid: next, read: toLoadedArchive(files) });
          }
        },
        (error: unknown) => {
          if (reading === started) {
            setReading({ cid: next, read: { status: 'failed', reason: getErrorMessage(error) } });
          }
        },
      );
    },
  );

  const selected = createMemo((): ArchiveFile | undefined => {
    const current = read();
    const path = selectedPath();
    return current.status === 'loaded' && path !== null ? current.files.find(file => file.path === path) : undefined;
  });
  const shown = createMemo((): Preview | undefined => {
    const file = selected();
    return file === undefined ? undefined : previewFile(file);
  });

  let url: string | null = null;
  function revokeUrl(): void {
    if (url !== null) {
      objectUrls().revoke(url);
      url = null;
    }
  }
  createEffect(
    () => (shown()?.kind === 'image' ? selected() : undefined),
    file => {
      revokeUrl();
      const type = file === undefined ? undefined : getImageType(file.path);
      if (file !== undefined && type !== undefined) {
        url = objectUrls().create(new Blob([file.bytes.slice()], { type }));
      }
      setImageUrl(url);
    },
  );
  onCleanup(revokeUrl);

  function getShownText(): string | undefined {
    const current = shown();
    return current?.kind === 'text' ? current.text : undefined;
  }
  function getLoadedArchive(): LoadedArchive | undefined {
    const current = read();
    return current.status === 'loaded' ? current : undefined;
  }
  function getFailure(): string | undefined {
    const current = read();
    return current.status === 'failed' ? current.reason : undefined;
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
