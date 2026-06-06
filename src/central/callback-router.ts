/**
 * Routes raw {@link RawCallbackEvent}s from the {@link CallbackServer} onto the
 * central's typed {@link EventBus}, value cache and device registry.
 *
 * The router owns NO transport: it is a pure dispatcher fed normalized callback
 * events. Side effects that need transport access (incremental discovery, value
 * re-sync) are delegated back to the {@link CentralUnit} via the injected
 * {@link RouterHooks}. Keeping it here keeps {@link CentralUnit} focused on
 * lifecycle wiring.
 */

import { makeDpk } from '../support/dpk.js';
import { ParamsetKey } from '../support/constants.js';
import type { RawCallbackEvent } from '../transport/callback-server/events.js';
import type { XmlRpcValue } from '../transport/xmlrpc/types.js';
import type { EventBus } from './event-bus.js';
import type { ValueCache } from './store/value-cache.js';
import type { DeviceRegistry } from './device-registry.js';
import type { ConnectionStateTracker } from './connection/connection-state.js';
import type { PingPongTracker } from './connection/ping-pong.js';

/** The parameter name a CCU uses for a ping/pong reconciliation event. */
export const PONG_PARAMETER = 'PONG';

/** Side effects the router delegates back to the central (transport access). */
export interface RouterHooks {
  /** Incrementally discover device addresses pushed via `newDevices`. */
  onNewDevices(interfaceId: string, addresses: readonly string[]): Promise<void>;
  /** Re-discover a single device whose description changed (`updateDevice`). */
  onUpdateDevice(interfaceId: string, address: string): Promise<void>;
  /** Re-discover after a `replaceDevice`/`readdedDevice` (old removed, new added). */
  onReaddDevices(interfaceId: string, addresses: readonly string[]): Promise<void>;
}

/** Construction dependencies for the {@link CallbackRouter}. */
export interface CallbackRouterOptions {
  readonly eventBus: EventBus;
  readonly valueCache: ValueCache;
  readonly registry: DeviceRegistry;
  readonly connectionState: ConnectionStateTracker;
  /** Resolve the {@link PingPongTracker} for an interface id (undefined if unknown). */
  readonly pingPongFor: (interfaceId: string) => PingPongTracker | undefined;
  readonly hooks: RouterHooks;
  /** Injectable clock for `receivedAt` stamping. */
  readonly now?: () => number;
}

/** Address of the device that owns a channel address (`DEV:idx` → `DEV`). */
function deviceAddressOf(channelAddress: string): string {
  const colon = channelAddress.lastIndexOf(':');
  return colon === -1 ? channelAddress : channelAddress.slice(0, colon);
}

/** Extract the `ADDRESS` field from a raw device-description struct, if present. */
function addressOf(description: Record<string, unknown>): string | undefined {
  const address = description['ADDRESS'];
  return typeof address === 'string' && address !== '' ? address : undefined;
}

export class CallbackRouter {
  private readonly eventBus: EventBus;
  private readonly valueCache: ValueCache;
  private readonly registry: DeviceRegistry;
  private readonly connectionState: ConnectionStateTracker;
  private readonly pingPongFor: (interfaceId: string) => PingPongTracker | undefined;
  private readonly hooks: RouterHooks;
  private readonly now: () => number;

  public constructor(options: CallbackRouterOptions) {
    this.eventBus = options.eventBus;
    this.valueCache = options.valueCache;
    this.registry = options.registry;
    this.connectionState = options.connectionState;
    this.pingPongFor = options.pingPongFor;
    this.hooks = options.hooks;
    this.now = options.now ?? Date.now;
  }

  /**
   * Handle one normalized callback event. Returns a promise that resolves once
   * any async side effect (discovery, publish) has completed, so the caller can
   * await ordering in tests; transport errors are surfaced to the caller.
   */
  public async route(raw: RawCallbackEvent): Promise<void> {
    switch (raw.type) {
      case 'event':
        await this.routeEvent(raw.interfaceId, raw.channelAddress, raw.parameter, raw.value);
        return;
      case 'newDevices':
        await this.routeNewDevices(raw.interfaceId, raw.descriptions);
        return;
      case 'deleteDevices':
        await this.routeDeleteDevices(raw.interfaceId, raw.addresses);
        return;
      case 'updateDevice':
        await this.hooks.onUpdateDevice(raw.interfaceId, raw.address);
        return;
      case 'replaceDevice':
        await this.routeReadd(raw.interfaceId, [raw.oldAddress], [raw.newAddress]);
        return;
      case 'readdedDevice':
        await this.routeReadd(raw.interfaceId, raw.addresses, raw.addresses);
        return;
      case 'error':
        await this.eventBus.publish({
          type: 'systemError',
          interfaceId: raw.interfaceId,
          code: raw.code,
          message: raw.message,
        });
        return;
    }
  }

  private async routeEvent(
    interfaceId: string,
    channelAddress: string,
    parameter: string,
    value: XmlRpcValue,
  ): Promise<void> {
    // Any inbound event is also evidence the callback channel is alive.
    this.connectionState.recordEvent(interfaceId);

    // A PONG event echoes a ping token in its value; reconcile it instead of
    // treating it as a data point value.
    if (parameter === PONG_PARAMETER) {
      const tracker = this.pingPongFor(interfaceId);
      // The CCU broadcasts PONGs to EVERY registered client; only reconcile pongs
      // whose token is ours (`${interfaceId}#<seq>`). Foreign clients' pongs
      // (e.g. another central pinging the same CCU) are ignored so they don't
      // pollute the mismatch tracker and trigger spurious reconnects.
      if (
        tracker !== undefined &&
        typeof value === 'string' &&
        value.startsWith(`${interfaceId}#`)
      ) {
        tracker.handleReceivedPong(value);
      }
      return;
    }

    const dpk = makeDpk(interfaceId, channelAddress, ParamsetKey.VALUES, parameter);
    const receivedAt = this.now();
    this.valueCache.add(dpk, value, receivedAt);
    await this.eventBus.publish({ type: 'valueReceived', dpk, value, receivedAt });
  }

  private async routeNewDevices(
    interfaceId: string,
    descriptions: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    const addresses = descriptions
      .map(addressOf)
      .filter((address): address is string => address !== undefined);
    if (addresses.length === 0) return;
    await this.hooks.onNewDevices(interfaceId, addresses);
  }

  private async routeDeleteDevices(
    interfaceId: string,
    addresses: readonly string[],
  ): Promise<void> {
    for (const address of addresses) {
      // The CCU may delete channels or whole devices; resolve to the owning
      // device so the registry drops the full node.
      const deviceAddress = this.registry.get(address) ? address : deviceAddressOf(address);
      this.registry.removeDevice(deviceAddress);
      await this.eventBus.publish({ type: 'deviceRemoved', address: deviceAddress });
    }
  }

  private async routeReadd(
    interfaceId: string,
    removed: readonly string[],
    added: readonly string[],
  ): Promise<void> {
    for (const address of removed) {
      const deviceAddress = this.registry.get(address) ? address : deviceAddressOf(address);
      this.registry.removeDevice(deviceAddress);
      await this.eventBus.publish({ type: 'deviceRemoved', address: deviceAddress });
    }
    await this.hooks.onReaddDevices(interfaceId, added);
  }
}
