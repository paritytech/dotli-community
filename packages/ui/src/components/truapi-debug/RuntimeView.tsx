// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DockPosition, PolkaVmDebugSnapshot } from '@dotli/truapi-debug';
import s from './RuntimeView.module.css';

function backendLabel(snapshot: PolkaVmDebugSnapshot): string {
  return snapshot.backend === 'compiler' ? 'JIT' : snapshot.backend === 'interpreter' ? 'Interpreter' : 'Starting';
}

export function RuntimeBadge(props: {
  snapshot: PolkaVmDebugSnapshot | null;
  dock: DockPosition;
  onOpen: () => void;
}): JSX.Element {
  return (
    <Show when={props.snapshot}>
      {snapshot => (
        <button
          class={s['badge']}
          data-testid="td-runtime-badge"
          data-dock={props.dock}
          type="button"
          onClick={() => {
            props.onOpen();
          }}
          title={`PolkaVM / ${backendLabel(snapshot())} · first frame ${snapshot().firstFrameMs > 0 ? `${snapshot().firstFrameMs.toFixed(1)} ms` : 'pending'}`}
        >
          {`PVM ${backendLabel(snapshot())} · ${snapshot().fps.toFixed(1)} FPS`}
        </button>
      )}
    </Show>
  );
}

function Metric(props: { label: string; metric?: string; children: JSX.Element }): JSX.Element {
  return (
    <div class={s['metric']}>
      <dt class={s['label']}>{props.label}</dt>
      <dd class={s['value']} data-runtime-metric={props.metric}>
        {props.children}
      </dd>
    </div>
  );
}

/** Live counters never enter the event store. Only the visible view formats them. */
export function RuntimeView(props: { snapshot: PolkaVmDebugSnapshot | null; active: boolean }): JSX.Element {
  return (
    <div
      class={s['runtime']}
      data-testid="td-runtime"
      hidden={!props.active}
      role="tabpanel"
      aria-label="PolkaVM runtime diagnostics"
    >
      <Show when={props.active && props.snapshot}>
        {snapshot => (
          <>
            <div class={s['heading']}>
              <span class={s['kicker']}>PolkaVM runtime</span>
              <strong class={s['backend']} data-runtime-metric="backend">
                {backendLabel(snapshot())}
              </strong>
              <span class={s['stage']}>{snapshot().startupStage.replaceAll('-', ' ')}</span>
            </div>
            <dl class={s['grid']}>
              <Show when={snapshot().backend === 'interpreter' && snapshot().compilerFallbackReason !== undefined}>
                <Metric label="Compiler fallback stage">{snapshot().compilerFallbackStage ?? 'unknown'}</Metric>
                <Metric label="Compiler fallback reason">{snapshot().compilerFallbackReason}</Metric>
              </Show>
              <Metric label="First frame" metric="first-frame">
                {snapshot().firstFrameMs > 0 ? `${snapshot().firstFrameMs.toFixed(1)} ms` : 'pending'}
              </Metric>
              <Metric label="Startup">{snapshot().startupMs.toFixed(1)} ms</Metric>
              <Metric label="Translation cache">{snapshot().cacheHit ? 'Hit' : 'Miss'}</Metric>
              <Metric label="Translated Wasm">
                {snapshot().translatedWasmBytes === 0
                  ? '—'
                  : `${(snapshot().translatedWasmBytes / 1024).toFixed(1)} KiB`}
              </Metric>
              <Metric label="Translate">{snapshot().translationMs.toFixed(1)} ms</Metric>
              <Metric label="Compile">{snapshot().compilationMs.toFixed(1)} ms</Metric>
              <Metric label="Frame rate" metric="fps">
                {snapshot().fps.toFixed(1)} FPS
              </Metric>
              <Metric label="Frames">{snapshot().frames}</Metric>
              <Metric label="Updates">{snapshot().updates}</Metric>
              <Metric label="Update p50">{snapshot().updateP50Ms.toFixed(2)} ms</Metric>
              <Metric label="Update p95">{snapshot().updateP95Ms.toFixed(2)} ms</Metric>
              <Metric label="Update max">{snapshot().updateMaxMs.toFixed(2)} ms</Metric>
              <Metric label="Audio chunks">{snapshot().audioChunks}</Metric>
              <Metric label="Audio samples">{snapshot().audioSamples}</Metric>
            </dl>
          </>
        )}
      </Show>
    </div>
  );
}
