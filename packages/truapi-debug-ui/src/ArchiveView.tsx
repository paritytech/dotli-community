// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ReadableStore } from '@dotli/shared';
import { useStore } from './use-store.js';
import {
  formatBytes,
  imageType,
  preview,
  summaryLabel,
  toFiles,
  type ArchiveFile,
  type ArchiveRead,
  type LoadedArchive,
  type Preview,
} from './archive-preview.js';
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

/** Cut so a huge bundle stays responsive. */
const MAX_TEXT_CHARS = 1_000_000;

export interface ObjectUrls {
  create: (blob: Blob) => string;
  revoke: (url: string) => void;
}

const pageObjectUrls: ObjectUrls = {
  create: blob => URL.createObjectURL(blob),
  revoke: url => {
    URL.revokeObjectURL(url);
  },
};

export function ArchiveView(props: {
  active: boolean;
  load: ArchiveLoader;
  product: ReadableStore<HostProduct>;
  /** Without them, the browser's own object URLs. */
  objectUrls?: ObjectUrls | undefined;
}): JSX.Element {
  const objectUrls = (): ObjectUrls => props.objectUrls ?? pageObjectUrls;
  const product = useStore(untrack(() => props.product));
  const cid = (): string | undefined => {
    const state = product();
    return state.status === 'loaded' ? state.cid : undefined;
  };
  const [read, setRead] = createSignal<ArchiveRead>({ status: 'loading' });
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [imageUrl, setImageUrl] = createSignal<string | null>(null);

  // Read on first show, and again only for a new CID.
  let readCid: string | null = null;
  createEffect(
    () => (props.active ? (cid() ?? null) : null),
    next => {
      if (next === null || next === readCid) {
        return;
      }
      readCid = next;
      setSelectedPath(null);
      setRead({ status: 'loading' });
      props.load(next).then(
        files => {
          if (readCid === next) {
            setRead(toFiles(files));
          }
        },
        (err: unknown) => {
          if (readCid === next) {
            setRead({ status: 'failed', reason: err instanceof Error ? err.message : String(err) });
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
    return file === undefined ? undefined : preview(file);
  });

  let url: string | null = null;
  const freeUrl = (): void => {
    if (url !== null) {
      objectUrls().revoke(url);
      url = null;
    }
  };
  createEffect(
    () => (shown()?.kind === 'image' ? selected() : undefined),
    file => {
      freeUrl();
      const type = file === undefined ? undefined : imageType(file.path);
      if (file !== undefined && type !== undefined) {
        url = objectUrls().create(new Blob([file.bytes.slice()], { type }));
      }
      setImageUrl(url);
    },
  );
  onCleanup(freeUrl);

  const shownText = (): string | undefined => {
    const current = shown();
    return current?.kind === 'text' ? current.text : undefined;
  };
  const loaded = (): LoadedArchive | undefined => {
    const current = read();
    return current.status === 'loaded' ? current : undefined;
  };
  const failure = (): string | undefined => {
    const current = read();
    return current.status === 'failed' ? current.reason : undefined;
  };

  return (
    <div class={s['archive']} data-testid="td-archive" hidden={!props.active}>
      <Switch>
        <Match when={product().status !== 'loaded'}>
          <EmptyState testId="td-archive-empty" class={s['whole']}>
            No product loaded yet.
          </EmptyState>
        </Match>
        <Match when={cid() === undefined}>
          <EmptyState testId="td-archive-empty" class={s['whole']}>
            This product is not served from a CID, so it has no archive.
          </EmptyState>
        </Match>
        <Match when={failure() !== undefined}>
          <EmptyState testId="td-archive-empty" class={s['whole']}>
            Could not read the archive: {failure()}
          </EmptyState>
        </Match>
        <Match when={loaded() === undefined}>
          <EmptyState testId="td-archive-empty" class={s['whole']}>
            Reading archive {cid()}…
          </EmptyState>
        </Match>
        <Match when={loaded()}>
          {archive => (
            <>
              <div class={s['sidebar']}>
                <Bar testId="td-archive-summary">{summaryLabel(archive())}</Bar>
                <ItemList>
                  <For each={archive().files}>
                    {file => (
                      <Item
                        testId="td-archive-file"
                        value={file.path}
                        selected={selectedPath() === file.path}
                        title={file.path}
                        meta={formatBytes(file.bytes.length)}
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
                      {src => <img class={s['image']} src={src()} alt={selectedPath() ?? ''} />}
                    </Show>
                  </Match>
                  <Match when={shown()?.kind === 'binary'}>
                    <EmptyState testId="td-archive-empty">
                      Binary, {formatBytes(selected()?.bytes.length ?? 0)}
                    </EmptyState>
                  </Match>
                  <Match when={shownText()}>
                    {text => (
                      <Stack>
                        <Show when={text().length > MAX_TEXT_CHARS}>
                          <Note>Showing the first {MAX_TEXT_CHARS.toLocaleString()} characters.</Note>
                        </Show>
                        <CodeBlock>{text().slice(0, MAX_TEXT_CHARS)}</CodeBlock>
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
