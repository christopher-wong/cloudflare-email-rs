/**
 * Realtime client behavior. We don't open a real WebSocket here — the
 * value of these tests is the subscribe/unsubscribe lifecycle and the
 * event dispatch logic, not "did the browser successfully WS handshake."
 *
 * Approach: stub the global WebSocket with a controllable in-memory
 * version so we can drive .open/.message/.close events at known times.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as realtime from './realtime';
import type { RealtimeEvent } from './realtime';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  listeners = new Map<string, Set<(e: any) => void>>();
  sentFrames: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (e: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: any) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  send(data: string) {
    this.sentFrames.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }
  emit(type: string, evt: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(evt);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  // @ts-expect-error — replacing the global WebSocket constructor.
  globalThis.WebSocket = FakeWebSocket;
  // Make timers controllable so reconnect backoff doesn't take real time.
  vi.useFakeTimers();
});

afterEach(() => {
  realtime.stop();
  vi.useRealTimers();
});

describe('realtime.subscribe / dispatch', () => {
  it('delivers parsed events to every subscriber', () => {
    realtime.start();
    const got: RealtimeEvent[] = [];
    const unsub = realtime.subscribe((e) => got.push(e));

    const sock = FakeWebSocket.instances[0];
    sock.emit('open', {});
    sock.emit('message', { data: JSON.stringify({ type: 'message.new', direction: 'in', msg_id: 'm1' }) });

    expect(got).toHaveLength(1);
    expect(got[0].type).toBe('message.new');
    unsub();
  });

  it('stops calling a handler after unsubscribe', () => {
    realtime.start();
    const fn = vi.fn();
    const unsub = realtime.subscribe(fn);
    unsub();

    const sock = FakeWebSocket.instances[0];
    sock.emit('open', {});
    sock.emit('message', { data: JSON.stringify({ type: 'message.new', direction: 'out', msg_id: 'x' }) });

    expect(fn).not.toHaveBeenCalled();
  });

  it('ignores non-JSON frames without throwing', () => {
    realtime.start();
    const fn = vi.fn();
    realtime.subscribe(fn);
    const sock = FakeWebSocket.instances[0];
    expect(() => sock.emit('message', { data: 'not json {{{' })).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("doesn't dispatch pong frames as events", () => {
    realtime.start();
    const fn = vi.fn();
    realtime.subscribe(fn);
    const sock = FakeWebSocket.instances[0];
    sock.emit('message', { data: 'pong' });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('realtime heartbeat + reconnect', () => {
  it('sends ping frames on its heartbeat interval', () => {
    realtime.start();
    const sock = FakeWebSocket.instances[0];
    sock.emit('open', {});
    expect(sock.sentFrames).toEqual([]); // before any interval tick
    vi.advanceTimersByTime(25_500);
    expect(sock.sentFrames).toContain('ping');
  });

  it('reconnects (opens a new socket) after the previous one closes', () => {
    realtime.start();
    const first = FakeWebSocket.instances[0];
    first.emit('open', {});
    first.close();
    // First reconnect schedules at ~1s + jitter ≤ 1s, advance generously.
    vi.advanceTimersByTime(3_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('stop() closes the socket and cancels reconnect timers', () => {
    realtime.start();
    const sock = FakeWebSocket.instances[0];
    sock.emit('open', {});
    realtime.stop();
    expect(sock.readyState).toBe(FakeWebSocket.CLOSED);
    vi.advanceTimersByTime(60_000);
    // No new socket should have been created after stop().
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
