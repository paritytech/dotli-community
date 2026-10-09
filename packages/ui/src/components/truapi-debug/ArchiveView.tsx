// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isEncrypted, type ArchiveFiles } from '@dotli/content';
import { productStore } from '../../state/product.js';
import { useStore } from '../use-store.js';
import type { ArchiveLoader } from './archive-source.js';
import { Item, ItemList } from './shared/ItemList.js';
import s from './ArchiveView.module.css';

interface ArchiveFile {
  path: string;
  bytes: Uint8Array;
}

type ArchiveRead =
  | { status: 'loading' }
  | { status: 'loaded'; files: readonly ArchiveFile[]; total: number }
  | { status: 'failed'; reason: string };

type Preview = { kind: 'encrypted' } | { kind: 'image' } | { kind: 'text'; text: string } | { kind: 'binary' };

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};

/** Cut so a huge bundle stays responsive. */
const MAX_TEXT_CHARS = 1_000_000;

function imageType(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : IMAGE_TYPES[path.slice(dot + 1).toLowerCase()];
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function preview(file: ArchiveFile): Preview {
  if (isEncrypted(file.bytes)) {
    return { kind: 'encrypted' };
  }
  if (imageType(file.path) !== undefined) {
    return { kind: 'image' };
  }
  const text = decodeText(file.bytes);
  return text === null ? { kind: 'binary' } : { kind: 'text', text };
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${String(size)} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function toFiles(files: ArchiveFiles): ArchiveRead {
  const list = Object.entries(files)
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { status: 'loaded', files: list, total: list.reduce((sum, file) => sum + file.bytes.length, 0) };
}

export function ArchiveView(props: { active: boolean; load: ArchiveLoader }): JSX.Element {
  const product = useStore(productStore);
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
      URL.revokeObjectURL(url);
      url = null;
    }
  };
  createEffect(
    () => (shown()?.kind === 'image' ? selected() : undefined),
    file => {
      freeUrl();
      const type = file === undefined ? undefined : imageType(file.path);
      if (file !== undefined && type !== undefined) {
        url = URL.createObjectURL(new Blob([file.bytes.slice()], { type }));
      }
      setImageUrl(url);
    },
  );
  onCleanup(freeUrl);

  const shownText = (): string | undefined => {
    const current = shown();
    return current?.kind === 'text' ? current.text : undefined;
  };
  const loaded = (): Extract<ArchiveRead, { status: 'loaded' }> | undefined => {
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
          <div class={s['empty']} data-testid="td-archive-empty">
            No product loaded yet.
          </div>
        </Match>
        <Match when={cid() === undefined}>
          <div class={s['empty']} data-testid="td-archive-empty">
            This product is not served from a CID, so it has no archive.
          </div>
        </Match>
        <Match when={failure() !== undefined}>
          <div class={s['empty']} data-testid="td-archive-empty">
            Could not read the archive: {failure()}
          </div>
        </Match>
        <Match when={loaded() === undefined}>
          <div class={s['empty']} data-testid="td-archive-empty">
            Reading archive {cid()}…
          </div>
        </Match>
        <Match when={loaded()}>
          {archive => (
            <>
              <div class={s['sidebar']}>
                <div class={s['summary']} data-testid="td-archive-summary">
                  {`${String(archive().files.length)} ${archive().files.length === 1 ? 'file' : 'files'} · ${formatBytes(archive().total)}`}
                </div>
                <ItemList>
                  <For each={archive().files}>
                    {file => (
                      <Item
                        testId="td-archive-file"
                        value={file.path}
                        selected={selectedPath() === file.path}
                        title={file.path}
                        onSelect={() => {
                          setSelectedPath(file.path);
                        }}
                      >
                        <span class={s['path']}>{file.path}</span>
                        <span class={s['size']}>{formatBytes(file.bytes.length)}</span>
                      </Item>
                    )}
                  </For>
                </ItemList>
              </div>
              <div class={s['content']} data-testid="td-archive-content">
                <Switch
                  fallback={
                    <div class={s['empty']} data-testid="td-archive-empty">
                      Select a file.
                    </div>
                  }
                >
                  <Match when={shown()?.kind === 'encrypted'}>
                    <div class={s['empty']} data-testid="td-archive-empty">
                      Encrypted, not decrypted: the sandbox asks for its password.
                    </div>
                  </Match>
                  <Match when={shown()?.kind === 'image'}>
                    <Show when={imageUrl()}>
                      {src => <img class={s['image']} src={src()} alt={selectedPath() ?? ''} />}
                    </Show>
                  </Match>
                  <Match when={shown()?.kind === 'binary'}>
                    <div class={s['empty']} data-testid="td-archive-empty">
                      Binary, {formatBytes(selected()?.bytes.length ?? 0)}
                    </div>
                  </Match>
                  <Match when={shownText()}>
                    {text => (
                      <>
                        <Show when={text().length > MAX_TEXT_CHARS}>
                          <div class={s['note']}>Showing the first {MAX_TEXT_CHARS.toLocaleString()} characters.</div>
                        </Show>
                        <pre class={s['text']}>{text().slice(0, MAX_TEXT_CHARS)}</pre>
                      </>
                    )}
                  </Match>
                </Switch>
              </div>
            </>
          )}
        </Match>
      </Switch>
    </div>
  );
}
