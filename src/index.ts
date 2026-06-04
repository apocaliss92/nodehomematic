// Public API surface of nodehomematic.
//
// Only the facade + its public types are exported here; transport, central and
// model internals stay private to keep the published surface small and stable.

export { LIBRARY_NAME } from './support/version.js';

export { Homematic } from './api/homematic.js';
export type {
  HomematicOptions,
  HomematicCallback,
  HomematicCredentials,
  HomematicCache,
} from './api/homematic.js';

export type {
  HmDevice,
  HmChannel,
  HmDataPoint,
  HmValue,
  HmConfigParam,
  HmChannelConfig,
  DataPointRef,
  HmCustomEntity,
  HmClimate,
  HmSwitch,
  HmLight,
  HmCover,
  HmLock,
  HmSysVar,
  HmProgram,
} from './api/types.js';

export type {
  HomematicEventMap,
  ValueChangedEvent,
  DeviceEvent,
  ConnectionEvent,
} from './api/events.js';
