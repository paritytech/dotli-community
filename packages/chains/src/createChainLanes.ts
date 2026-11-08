// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The lanes of one chain: several connections to it, each with its own broker, opened and closed so each stays under
// the follow limit its transport states. Lane 0 lives as long as the lanes. Another lane opens when no lane has room
// and closes once no session is on it.

import { createReporter } from '@dotli/metrics';
import { runEvery } from '@dotli/shared';
import type { BrokerConnection } from './brokerMessages.js';
import { chainLaneOpenMetric } from './chainLaneOpenMetric.js';
import { chainPoolCloseMetric } from './chainPoolCloseMetric.js';
import type { BrokerWarner } from './createBrokerWarner.js';
import { createChainBroker, type ChainBroker } from './createChainBroker.js';
import { createLaneRouter, type LaneConnectParams, type LaneHandle } from './createLaneRouter.js';
import { createPausableTransport, type PausableTransport } from './createPausableTransport.js';
import { createWatchGuard, type WatchGuard } from './createWatchGuard.js';
import type { ChainTransport, ChainTransportHooks, ConnectionStatus } from './transportHooks.js';

const report = createReporter({ flow: 'protocol' });

/** The lanes of one chain, which keep each connection under the chain's follow limit. */
export type ChainLanes = NonNullable<ReturnType<typeof createChainLanes>>;

type Params = {
  /** Names the chain in errors and logs. */
  label: string;
  /** Builds one lane's transport, or null when this context cannot reach the chain. Called once per lane. */
  createTransport: (hooks: ChainTransportHooks) => ChainTransport | null;
  /** Shared by the lanes' brokers, so the chain keeps one warning count. */
  warn: BrokerWarner;
  /** Whether the pool is paused as the lanes are built. */
  paused: boolean;
  /** Hears each change of the combined status. */
  onStatus: (status: ConnectionStatus) => void;
  /** Hears the first halt of any lane's transport, or a lane that cannot be built. */
  onHalt: (error?: unknown) => void;
};

/** Whether a session is a consumer's own, on its home lane, or one the consumer's router opened for a follow. */
type SessionRole = 'home' | 'follow';

type Lane = {
  /** Unique among the chain's lanes for the chain's life. */
  readonly id: number;
  readonly pausable: PausableTransport;
  readonly guard: WatchGuard;
  readonly broker: ChainBroker;
  /** Every open session on the lane, by session id. */
  readonly sessions: Map<string, SessionRole>;
  status: ConnectionStatus;
};

// Names the lanes in their log lines.
const LANES_TAG = '[dot.li chain-lanes]';

/** Builds lane 0 at once, and returns null when its transport is null. */
export function createChainLanes({ label, createTransport, warn, paused: initiallyPaused, onStatus, onHalt }: Params) {
  // In id order, the open lanes only, so a lane missing from it is closed.
  const lanes: Lane[] = [];
  let nextLaneId = 0;
  let nextSessionNumber = 0;
  let paused = initiallyPaused;
  let halted = false;
  let closed = false;

  const firstId = takeLaneId();
  const firstTransport = createTransport(createHooks(firstId));
  if (firstTransport === null) {
    return null;
  }
  const followLimit = firstTransport.followLimit;
  lanes.push(createLane(firstId, firstTransport));
  let reported = getStatus();

  function takeLaneId(): number {
    const id = nextLaneId;
    nextLaneId += 1;
    return id;
  }

  /** A lane's transport hooks, which do nothing before the lane is built, once it is closed, or once the chain halted. */
  function createHooks(id: number): ChainTransportHooks {
    return {
      onStatus: status => {
        const lane = findLane(id);
        if (lane === undefined || halted) {
          return;
        }
        setLaneStatus(lane, status);
        reportStatus();
      },
      onHalt: error => {
        if (findLane(id) !== undefined) {
          reportHalt(error);
        }
      },
    };
  }

  function createLane(id: number, transport: ChainTransport): Lane {
    const pausable = createPausableTransport({ transport: transport.provider });
    if (paused) {
      pausable.pause();
    }
    const guard = createWatchGuard({ transport: pausable.provider });
    return {
      id,
      pausable,
      guard,
      broker: createChainBroker({ provider: guard.provider, warn }),
      sessions: new Map(),
      status: paused ? 'disconnected' : 'connecting',
    };
  }

  /** Opens a new lane. Throws when it cannot be built, after reporting it as the chain's halt. */
  function addLane(): Lane {
    const id = takeLaneId();
    let lane: Lane;
    try {
      const transport = createTransport(createHooks(id));
      if (transport === null) {
        throw new Error(`${label} has no transport in this context`);
      }
      lane = createLane(id, transport);
    } catch (cause) {
      const error = new Error(`${label} lane ${String(id)} could not be built`, { cause });
      report.defect(error, {
        step: 'chain_lane_build',
        metric: chainLaneOpenMetric,
        message: `${LANES_TAG} building ${label} lane ${String(id)} failed:`,
      });
      reportHalt(error);
      throw error;
    }
    lanes.push(lane);
    reportStatus();
    return lane;
  }

  function findLane(id: number): Lane | undefined {
    return lanes.find(lane => lane.id === id);
  }

  function hasRoom(lane: Lane): boolean {
    return lane.broker.countFollows() < followLimit;
  }

  function countHomes(lane: Lane): number {
    let homes = 0;
    for (const role of lane.sessions.values()) {
      if (role === 'home') {
        homes += 1;
      }
    }
    return homes;
  }

  function hasConsumer(sessionId: string): boolean {
    return lanes.some(lane => lane.sessions.get(sessionId) === 'home');
  }

  /** Among the lanes with room, the one with the fewest consumers at home, the lowest id on a tie, else a new lane. */
  function pickHomeLane(): Lane {
    let picked: Lane | null = null;
    for (const lane of lanes) {
      if (hasRoom(lane) && (picked === null || countHomes(lane) < countHomes(picked))) {
        picked = lane;
      }
    }
    return picked ?? addLane();
  }

  function pickFollowLane(home: Lane): LaneHandle | null {
    // A consumer whose home lane closed has no session left to follow for.
    if (halted || !lanes.includes(home)) {
      return null;
    }
    const roomy = hasRoom(home) ? home : lanes.find(hasRoom);
    try {
      return createHandle(roomy ?? addLane(), 'follow');
    } catch {
      // A lane that cannot be built leaves no lane for the follow.
      return null;
    }
  }

  function getLaneSessionId(lane: LaneHandle): string {
    const sessionId = `lane:${String(lane.id)}:${String(nextSessionNumber)}`;
    nextSessionNumber += 1;
    return sessionId;
  }

  function createHandle(lane: Lane, role: SessionRole): LaneHandle {
    return {
      id: lane.id,
      hasToken: lane.broker.hasToken,
      connect: params => connectSession(lane, params, role),
    };
  }

  /** Opens a session on the lane and counts it there until it ends, closing an extra lane its end leaves empty. */
  function connectSession(lane: Lane, params: LaneConnectParams, role: SessionRole): BrokerConnection {
    let connection: BrokerConnection;
    try {
      connection = lane.broker.connect(params);
    } catch (error) {
      // A consumer's home session throws to whoever connects it. A follow's failure has no caller to throw to, so it is reported here.
      if (role === 'follow') {
        report.defect(error, {
          step: 'chain_lane_session',
          metric: chainLaneOpenMetric,
          message: `${LANES_TAG} opening ${params.sessionId} on ${label} lane ${String(lane.id)} failed:`,
        });
      }
      closeIfEmpty(lane);
      throw error;
    }
    const { sessionId } = params;
    lane.sessions.set(sessionId, role);
    let open = true;
    return {
      send: connection.send,
      disconnect() {
        if (!open) {
          return;
        }
        open = false;
        lane.sessions.delete(sessionId);
        try {
          connection.disconnect();
        } finally {
          closeIfEmpty(lane);
        }
      },
    };
  }

  function closeIfEmpty(lane: Lane): void {
    if (lane.id === 0 || lane.sessions.size > 0 || !lanes.includes(lane)) {
      return;
    }
    lanes.splice(lanes.indexOf(lane), 1);
    try {
      lane.broker.disconnectAll();
    } catch (error) {
      report.defect(error, {
        step: 'chain_lane_close',
        metric: chainPoolCloseMetric,
        message: `${LANES_TAG} closing ${label} lane ${String(lane.id)} once empty failed:`,
      });
      reportHalt(error);
    }
    reportStatus();
  }

  function setLaneStatus(lane: Lane, status: ConnectionStatus): void {
    if (!lanes.includes(lane)) {
      return;
    }
    lane.guard.onStatus(status);
    lane.status = status;
  }

  /** `connected` when every open lane is, `disconnected` when any is or none is open, `connecting` otherwise. */
  function getStatus(): ConnectionStatus {
    if (lanes.length === 0 || lanes.some(lane => lane.status === 'disconnected')) {
      return 'disconnected';
    }
    return lanes.every(lane => lane.status === 'connected') ? 'connected' : 'connecting';
  }

  function reportStatus(): void {
    const status = getStatus();
    if (status === reported) {
      return;
    }
    reported = status;
    onStatus(status);
  }

  function reportHalt(error: unknown): void {
    if (halted) {
      return;
    }
    halted = true;
    onHalt(error);
  }

  function connect(params: LaneConnectParams): BrokerConnection {
    if (halted) {
      throw new Error(`${label} halted, so ${params.sessionId} cannot connect`);
    }
    if (closed) {
      throw new Error(`${label} closed, so ${params.sessionId} cannot connect`);
    }
    if (hasConsumer(params.sessionId)) {
      throw new Error(`Duplicate ${label} consumer: ${params.sessionId}`);
    }
    const home = pickHomeLane();
    return createLaneRouter({
      ...params,
      home: createHandle(home, 'home'),
      pickFollowLane: () => pickFollowLane(home),
      getLaneSessionId,
    });
  }

  function pause(): void {
    paused = true;
    const pausing = [...lanes];
    try {
      runEvery(
        [
          ...pausing.map(lane => () => {
            lane.pausable.pause();
          }),
          // A consumer may leave while it hears the pause, which closes its lane.
          ...pausing.map(lane => () => {
            setLaneStatus(lane, 'disconnected');
          }),
        ],
        `${label} lanes: pausing every lane failed`,
      );
    } finally {
      reportStatus();
    }
  }

  function resume(): void {
    if (!paused) {
      return;
    }
    paused = false;
    runEvery(
      lanes.map(lane => () => {
        lane.pausable.resume();
      }),
      `${label} lanes: resuming every lane failed`,
    );
  }

  function disconnectAll(): void {
    closed = true;
    const closing = lanes.splice(0);
    try {
      runEvery(
        closing.map(lane => () => {
          lane.broker.disconnectAll();
        }),
        `${label} lanes: closing every lane failed`,
      );
    } finally {
      reportStatus();
    }
  }

  function halt(error?: unknown): void {
    halted = true;
    const halting = lanes.splice(0);
    try {
      runEvery(
        halting.map(lane => () => {
          lane.broker.halt(error);
        }),
        `${label} lanes: halting every lane failed`,
      );
    } finally {
      reportStatus();
    }
  }

  return {
    /**
     * A consumer's connection, which sends its requests on its home lane and each follow on a lane with room. Throws
     * when `sessionId` names an open consumer, after the chain halted or closed, with the build error when the
     * consumer's new home lane cannot be built, after `onHalt` heard it, or with the error of the new home lane's first
     * session when it cannot open.
     */
    connect,
    /** The combined status of the open lanes. Never throws. */
    status: getStatus,
    /**
     * Closes every lane's connection under its sessions, and gives each lane `disconnected`. Tries every lane, then
     * throws what any threw: the one `Error`, or an AggregateError otherwise.
     */
    pause,
    /** Opens every lane's connection again. A call while not paused does nothing. Tries every lane, then throws as `pause` does. */
    resume,
    /**
     * Ends every lane's sessions and closes its connection, lane 0 included. Tries every lane, then throws as `pause`
     * does. The lanes stay closed, so a later `connect` throws.
     */
    disconnectAll,
    /** Halts every lane's broker with `error`, so each session hears it. Tries every lane, then throws as `pause` does. */
    halt,
  };
}
