import { describe, it, expect, vi } from 'vitest';
import { TypedEventEmitter } from '../../../src/api/emitter.js';
import type { HomematicEventMap } from '../../../src/api/events.js';

describe('TypedEventEmitter', () => {
  it('delivers an emitted payload to a registered listener', () => {
    const emitter = new TypedEventEmitter<HomematicEventMap>();
    const received: string[] = [];
    emitter.on('deviceAdded', (payload) => {
      received.push(payload.device);
    });
    emitter.emit('deviceAdded', { device: 'VCU0000001' });
    expect(received).toEqual(['VCU0000001']);
  });

  it('returns an unsubscribe function from on() that stops delivery', () => {
    const emitter = new TypedEventEmitter<HomematicEventMap>();
    const cb = vi.fn();
    const off = emitter.on('deviceRemoved', cb);
    emitter.emit('deviceRemoved', { device: 'A' });
    off();
    emitter.emit('deviceRemoved', { device: 'B' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith({ device: 'A' });
  });

  it('off() removes a specific listener', () => {
    const emitter = new TypedEventEmitter<HomematicEventMap>();
    const cb = vi.fn();
    emitter.on('deviceAdded', cb);
    emitter.off('deviceAdded', cb);
    emitter.emit('deviceAdded', { device: 'X' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('once() fires exactly once', () => {
    const emitter = new TypedEventEmitter<HomematicEventMap>();
    const cb = vi.fn();
    emitter.once('deviceAdded', cb);
    emitter.emit('deviceAdded', { device: 'A' });
    emitter.emit('deviceAdded', { device: 'B' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith({ device: 'A' });
  });

  it('once() unsubscribe stops it before it fires', () => {
    const emitter = new TypedEventEmitter<HomematicEventMap>();
    const cb = vi.fn();
    const off = emitter.once('deviceAdded', cb);
    off();
    emitter.emit('deviceAdded', { device: 'A' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('a throwing listener does not stop the others', () => {
    const emitter = new TypedEventEmitter<HomematicEventMap>();
    const good = vi.fn();
    emitter.on('deviceAdded', () => {
      throw new Error('boom');
    });
    emitter.on('deviceAdded', good);
    expect(() => emitter.emit('deviceAdded', { device: 'A' })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('routes a thrown listener error to the injected onError handler', () => {
    const onError = vi.fn();
    const emitter = new TypedEventEmitter<HomematicEventMap>(onError);
    const boom = new Error('boom');
    emitter.on('deviceAdded', () => {
      throw boom;
    });
    emitter.emit('deviceAdded', { device: 'A' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("emits a void event ('ready') with no payload argument", () => {
    const emitter = new TypedEventEmitter<HomematicEventMap>();
    const cb = vi.fn();
    emitter.on('ready', cb);
    emitter.emit('ready');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('carries an Error payload for the error event', () => {
    const emitter = new TypedEventEmitter<HomematicEventMap>();
    const err = new Error('nope');
    let seen: Error | undefined;
    emitter.on('error', (e) => {
      seen = e;
    });
    emitter.emit('error', err);
    expect(seen).toBe(err);
  });

  it('supports multiple listeners on the same event', () => {
    const emitter = new TypedEventEmitter<HomematicEventMap>();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('deviceAdded', a);
    emitter.on('deviceAdded', b);
    emitter.emit('deviceAdded', { device: 'A' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
