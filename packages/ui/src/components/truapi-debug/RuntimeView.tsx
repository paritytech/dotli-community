// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { PolkaVmDebugSnapshot } from '@dotli/truapi-debug';

function backendLabel(snapshot: PolkaVmDebugSnapshot): string {
  return snapshot.backend === 'compiler' ? 'JIT' : snapshot.backend === 'interpreter' ? 'Interpreter' : 'Starting';
}

export function RuntimeBadge(props: { snapshot: PolkaVmDebugSnapshot | null; onOpen: () => void }): JSX.Element {
  return (
    <Show when={props.snapshot}>
      {snapshot => (
        <button
          class="td-runtime-badge"
          type="button"
          onClick={props.onOpen}
          title={`PolkaVM / ${backendLabel(snapshot())} · first frame ${snapshot().firstFrameMs > 0 ? `${snapshot().firstFrameMs.toFixed(1)} ms` : 'pending'}`}
        >
          {`PVM ${backendLabel(snapshot())} · ${snapshot().fps.toFixed(1)} FPS`}
        </button>
      )}
    </Show>
  );
}

/** Live counters never enter the event store. Only the visible view formats them. */
export function RuntimeView(props: { snapshot: PolkaVmDebugSnapshot | null; active: boolean }): JSX.Element {
  return (
    <div
      class={props.active ? 'td-runtime' : 'td-runtime hidden'}
      role="tabpanel"
      aria-label="PolkaVM runtime diagnostics"
    >
      <Show when={props.active && props.snapshot}>
        {snapshot => (
          <>
            <div class="td-runtime-heading">
              <span class="td-runtime-kicker">PolkaVM runtime</span>
              <strong data-runtime-metric="backend">{backendLabel(snapshot())}</strong>
              <span class="td-runtime-stage">{snapshot().startupStage.replaceAll('-', ' ')}</span>
            </div>
            <dl class="td-runtime-grid">
              <Show when={snapshot().backend === 'interpreter' && snapshot().compilerFallbackReason !== undefined}>
                <div>
                  <dt>Compiler fallback stage</dt>
                  <dd>{snapshot().compilerFallbackStage ?? 'unknown'}</dd>
                </div>
                <div>
                  <dt>Compiler fallback reason</dt>
                  <dd>{snapshot().compilerFallbackReason}</dd>
                </div>
              </Show>
              <div>
                <dt>First frame</dt>
                <dd data-runtime-metric="first-frame">
                  {snapshot().firstFrameMs > 0 ? `${snapshot().firstFrameMs.toFixed(1)} ms` : 'pending'}
                </dd>
              </div>
              <div>
                <dt>Startup</dt>
                <dd>{snapshot().startupMs.toFixed(1)} ms</dd>
              </div>
              <div>
                <dt>Translation cache</dt>
                <dd>{snapshot().cacheHit ? 'Hit' : 'Miss'}</dd>
              </div>
              <div>
                <dt>Translated Wasm</dt>
                <dd>
                  {snapshot().translatedWasmBytes === 0
                    ? '—'
                    : `${(snapshot().translatedWasmBytes / 1024).toFixed(1)} KiB`}
                </dd>
              </div>
              <div>
                <dt>Translate</dt>
                <dd>{snapshot().translationMs.toFixed(1)} ms</dd>
              </div>
              <div>
                <dt>Compile</dt>
                <dd>{snapshot().compilationMs.toFixed(1)} ms</dd>
              </div>
              <div>
                <dt>Frame rate</dt>
                <dd data-runtime-metric="fps">{snapshot().fps.toFixed(1)} FPS</dd>
              </div>
              <div>
                <dt>Frames</dt>
                <dd>{snapshot().frames}</dd>
              </div>
              <div>
                <dt>Updates</dt>
                <dd>{snapshot().updates}</dd>
              </div>
              <div>
                <dt>Update p50</dt>
                <dd>{snapshot().updateP50Ms.toFixed(2)} ms</dd>
              </div>
              <div>
                <dt>Update p95</dt>
                <dd>{snapshot().updateP95Ms.toFixed(2)} ms</dd>
              </div>
              <div>
                <dt>Update max</dt>
                <dd>{snapshot().updateMaxMs.toFixed(2)} ms</dd>
              </div>
              <div>
                <dt>Audio chunks</dt>
                <dd>{snapshot().audioChunks}</dd>
              </div>
              <div>
                <dt>Audio samples</dt>
                <dd>{snapshot().audioSamples}</dd>
              </div>
            </dl>
          </>
        )}
      </Show>
    </div>
  );
}
