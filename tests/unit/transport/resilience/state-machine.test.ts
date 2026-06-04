import { describe, it, expect, vi } from 'vitest';
import {
  ConnectionStateMachine,
  ClientState,
  VALID_TRANSITIONS,
} from '../../../../src/transport/resilience/state-machine.js';
import { InvalidStateTransitionError } from '../../../../src/support/errors.js';

describe('ConnectionStateMachine', () => {
  it('starts in CREATED by default', () => {
    expect(new ConnectionStateMachine().state).toBe(ClientState.CREATED);
  });

  it('accepts a custom initial state', () => {
    expect(new ConnectionStateMachine(ClientState.CONNECTED).state).toBe(ClientState.CONNECTED);
  });

  it('a valid transition updates the state and notifies onChange', () => {
    const sm = new ConnectionStateMachine();
    const events: Array<{ from: ClientState; to: ClientState; reason?: string }> = [];
    sm.onChange((e) => events.push(e));

    sm.transitionTo(ClientState.INITIALIZING, 'boot');
    expect(sm.state).toBe(ClientState.INITIALIZING);
    expect(events).toEqual([
      { from: ClientState.CREATED, to: ClientState.INITIALIZING, reason: 'boot' },
    ]);
  });

  it('an invalid transition throws and does not change state', () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transitionTo(ClientState.CONNECTED)).toThrow(InvalidStateTransitionError);
    expect(sm.state).toBe(ClientState.CREATED);
  });

  it('tracks failureReason when entering FAILED', () => {
    const sm = new ConnectionStateMachine(ClientState.INITIALIZING);
    sm.transitionTo(ClientState.FAILED, 'auth blew up');
    expect(sm.state).toBe(ClientState.FAILED);
    expect(sm.failureReason).toBe('auth blew up');
  });

  it('onChange returns a working unsubscribe', () => {
    const sm = new ConnectionStateMachine();
    const cb = vi.fn();
    const off = sm.onChange(cb);
    sm.transitionTo(ClientState.INITIALIZING);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    sm.transitionTo(ClientState.INITIALIZED);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('VALID_TRANSITIONS matches the protocol table', () => {
    expect(VALID_TRANSITIONS[ClientState.CREATED]).toEqual([ClientState.INITIALIZING]);
    expect(VALID_TRANSITIONS[ClientState.STOPPED]).toEqual([]);
    expect(VALID_TRANSITIONS[ClientState.CONNECTED]).toEqual(
      expect.arrayContaining([
        ClientState.DISCONNECTED,
        ClientState.RECONNECTING,
        ClientState.STOPPING,
      ]),
    );
  });

  it('a full connect/disconnect/reconnect path is valid', () => {
    const sm = new ConnectionStateMachine();
    sm.transitionTo(ClientState.INITIALIZING);
    sm.transitionTo(ClientState.INITIALIZED);
    sm.transitionTo(ClientState.CONNECTING);
    sm.transitionTo(ClientState.CONNECTED);
    sm.transitionTo(ClientState.RECONNECTING);
    sm.transitionTo(ClientState.CONNECTED);
    sm.transitionTo(ClientState.STOPPING);
    sm.transitionTo(ClientState.STOPPED);
    expect(sm.state).toBe(ClientState.STOPPED);
  });

  describe('reconnectDelay', () => {
    it('reconnectDelay(0) = 2000', () => {
      expect(new ConnectionStateMachine().reconnectDelay(0)).toBe(2000);
    });

    it('grows exponentially', () => {
      const sm = new ConnectionStateMachine();
      expect(sm.reconnectDelay(1)).toBe(4000);
      expect(sm.reconnectDelay(2)).toBe(8000);
      expect(sm.reconnectDelay(3)).toBe(16000);
    });

    it('is capped at 120000', () => {
      const sm = new ConnectionStateMachine();
      expect(sm.reconnectDelay(20)).toBe(120000);
    });
  });
});
