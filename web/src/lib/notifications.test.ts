/**
 * The Notifications wrapper has three branches worth exercising on real
 * logic (not the underlying Notification API itself):
 * 1. permission-state mapping ('unsupported' when Notification is missing)
 * 2. show() suppresses when the document is focused
 * 3. show() no-ops when permission isn't 'granted'
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as notifications from './notifications';

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static instances: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  title: string;
  options: NotificationOptions | undefined;
  onclick: (() => void) | null = null;

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeNotification.instances.push(this);
  }
  close() { /* no-op for the test */ }
}

const originalNotification = (globalThis as any).Notification;

beforeEach(() => {
  FakeNotification.permission = 'default';
  FakeNotification.instances = [];
  (globalThis as any).Notification = FakeNotification;
  // jsdom defaults visibilityState to 'visible'; let tests override.
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
});

afterEach(() => {
  (globalThis as any).Notification = originalNotification;
});

describe('notifications.permissionState', () => {
  it("returns 'unsupported' when Notification is undefined", () => {
    delete (globalThis as any).Notification;
    expect(notifications.permissionState()).toBe('unsupported');
  });

  it('reflects the underlying Notification.permission', () => {
    FakeNotification.permission = 'granted';
    expect(notifications.permissionState()).toBe('granted');
    FakeNotification.permission = 'denied';
    expect(notifications.permissionState()).toBe('denied');
  });
});

describe('notifications.show', () => {
  it('does nothing without permission', () => {
    FakeNotification.permission = 'default';
    const ok = notifications.show({ title: 'x' });
    expect(ok).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('suppresses when the document is focused', () => {
    FakeNotification.permission = 'granted';
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const ok = notifications.show({ title: 'x' });
    expect(ok).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('shows when granted + tab backgrounded', () => {
    FakeNotification.permission = 'granted';
    const ok = notifications.show({ title: 'New mail', body: 'subject', tag: 'msg1' });
    expect(ok).toBe(true);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0].title).toBe('New mail');
    expect(FakeNotification.instances[0].options?.body).toBe('subject');
    expect(FakeNotification.instances[0].options?.tag).toBe('msg1');
  });

  it('wires the click handler so it fires the caller callback', () => {
    FakeNotification.permission = 'granted';
    const onClick = vi.fn();
    notifications.show({ title: 't', onClick });
    const inst = FakeNotification.instances[0];
    inst.onclick?.();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
