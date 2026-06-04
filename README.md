# nodehomematic

Node.js/TypeScript port of [aiohomematic](https://github.com/sukramj/aiohomematic) — an asynchronous library to control and monitor Homematic / HomematicIP devices via **CCU3 / RaspberryMatic / OpenCCU**.

> **Status:** 0.x functional. Public API stable in broad strokes, with possible refinements up to 1.0.

## Features

- XML-RPC connection to the CCU interfaces: **HmIP-RF, BidCos-RF, VirtualDevices** (groups, on the `/groups` path).
- JSON-RPC client to the CCU WebUI (names, system variables, programs) + ReGa scripts (rooms/functions, descriptions).
- Callback server to receive event push notifications from the CCU.
- **Rock-solid** reconnection (health-ping + ping/pong + re-init with backoff + value re-sync).
- Automatic discovery of devices, channels and data points + persistent description cache + seeding of initial values at startup.
- Event-driven, system-agnostic public API: global `valueChanged` stream + validated `setValue`.
- Typed **custom entities**: Climate (thermostats and heating groups), Switch, Light/Dimmer, Cover/Blind, Lock.
- **Device configuration** (MASTER paramset): read parameter specs and read/write config values.
- **Hub**: system variables (read/write) and programs (list/run/activate).

## Requirements

- Node.js >= 20

## Installation

```bash
npm install nodehomematic
```

## Usage

```ts
import { Homematic } from 'nodehomematic';

const hm = new Homematic({
  host: '192.168.1.10',
  interfaces: ['HmIP-RF', 'BidCos-RF', 'VirtualDevices'],
  credentials: { username: 'Admin', password: '...' },
  callback: { host: '192.168.1.50', port: 9123 }, // IP of THIS machine, reachable by the CCU
});

// Global stream: live updates of all devices
hm.on('valueChanged', (e) => {
  console.log(
    `${e.device}:${e.channel} ${e.parameter} = ${String(e.value)} (was ${String(e.prevValue)})`,
  );
});
hm.on('connection', (e) => console.log('connection', e.interfaceId, e.state));
hm.on('ready', () => console.log('discovery complete'));

await hm.start();

// Snapshot of the devices (with channels, data points and current values)
for (const d of hm.devices()) {
  console.log(d.address, d.type, d.name);
}

// Read / write a data point (explicit form or by id)
const v = hm.getValue({ device: 'VCU0000001', channel: 1, parameter: 'STATE' });
await hm.setValue({ device: 'VCU0000001', channel: 1, parameter: 'STATE' }, true);

// Custom entities (e.g. thermostats / heating groups)
const climates = hm.customEntities().filter((e) => e.kind === 'climate');
await hm.climateSetTemperature('INT0000001', 1, 21.5);
await hm.climateSetMode('INT0000001', 1, 'auto');

// Device configuration (MASTER paramset) — to build a config UI
const params = hm.getConfigParams('VCU0000001:1'); // parameter specs (type/min/max/valueList/...)
const config = await hm.getConfig('VCU0000001:1'); // current values
await hm.setConfig('VCU0000001:1', { CYCLIC_INFO_MSG_DIS: 28 });

// Hub: system variables and programs
console.log(hm.systemVariables().length, hm.programs().length);
await hm.setSystemVariable('Alarm', true);
await hm.runProgram('WakeUp');

await hm.stop();
```

## Public API (summary)

- **Lifecycle:** `start()`, `stop()`.
- **Events** (`on`/`once`/`off`): `valueChanged`, `deviceAdded`, `deviceRemoved`, `connection`, `ready`, `error`.
- **State:** `devices()`, `getValue(ref)`, `setValue(ref, value)` (`ref` = data point id or `{ device, channel, parameter }`).
- **Custom entities:** `customEntities()` + commands `climateSetTemperature/climateSetMode/climateSetBoost`, `switchTurnOn/Off`, `lightTurnOn/Off/SetBrightness`, `coverOpen/Close/Stop/SetPosition`, `lockLock/Unlock/Open`.
- **Device config:** `getConfigParams(channelAddress)`, `getConfig(channelAddress)`, `setConfig(channelAddress, values)`.
- **Hub:** `systemVariables()`, `getSystemVariable(name)`, `setSystemVariable(name, value)`, `programs()`, `runProgram(idOrName)`, `setProgramActive(idOrName, active)`, `refreshHub()`.

## Notes

- The `callback.host` must be the IP of the machine running nodehomematic, **reachable by the CCU** (the CCU pushes events there).
- Rooms/functions are read via ReGa scripts; they appear only for the channels actually assigned to rooms/functions in the CCU.

## License

MIT — port of aiohomematic (original copyright SukramJ, Daniel Perna preserved). See `LICENSE`.
