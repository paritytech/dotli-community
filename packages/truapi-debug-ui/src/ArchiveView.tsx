// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Match, Show, Switch, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { formatSize } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import { useStore } from '@dotli/stores-solid';
import { createArchiveReader } from './createArchiveReader.js';
import { previewFile, type ArchiveFile, type Preview } from './previewFile.js';
import { formatArchiveSummary } from './formatArchiveSummary.js';
import type { LoadedArchive } from './toLoadedArchive.js';
import type { ArchiveLoader, HostProduct } from './host.js';
import { Bar } from './shared/Bar.js';
import { CodeBlock } from './shared/CodeBlock.js';
import { EmptyState } from './shared/EmptyState.js';
import { Item, ItemList } from './shared/ItemList.js';
import { Note } from './shared/Note.js';
import { Pane } from './shared/Pane.js';
import { Stack } from './shared/Stack.js';
import s from './ArchiveView.module.css';

/** Cut so a huge bundle stays responsive. */
const MAX_TEXT_CHARACTERS = 1_000_000;

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
  const reader = createArchiveReader({ load: cid => props.load(cid) });
  const state = useStore(reader.state);
  const [imageUrl, setImageUrl] = createSignal<string | null>(null);

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
    const current = state();
    if (current.kind !== 'read') {
      return undefined;
    }
    const { archive, selectedPath } = current;
    return archive.files.find(file => file.path === selectedPath);
  });
  const shown = createMemo((): Preview | undefined => {
    const file = selected();
    return file === undefined ? undefined : previewFile(file);
  });

  createEffect(
    () => {
      const preview = shown();
      const file = selected();
      return preview?.kind === 'image' && file !== undefined ? { bytes: file.bytes, type: preview.type } : null;
    },
    image => {
      if (image === null) {
        setImageUrl(null);
        return;
      }
      const url = objectUrls.createObjectURL(new Blob([image.bytes.slice()], { type: image.type }));
      setImageUrl(url);
      return () => {
        objectUrls.revokeObjectURL(url);
      };
    },
  );

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
                        selected={selected()?.path === file.path}
                        title={file.path}
                        meta={formatSize(file.bytes.length)}
                        onSelect={() => {
                          reader.update({ kind: 'fileSelected', path: file.path });
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
                      {source => <img class={s['image']} src={source()} alt={selected()?.path ?? ''} />}
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
