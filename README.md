# nodehomematic

Node.js/TypeScript port of [aiohomematic](https://github.com/sukramj/aiohomematic) — an asynchronous library to control and monitor Homematic / HomematicIP devices via **CCU3 / RaspberryMatic / OpenCCU**.

> **Status:** 0.x functional. Public API stable in broad strokes, with possible refinements up to 1.0.

## Features

- XML-RPC connection to the CCU interfaces: **HmIP-RF, BidCos-RF, VirtualDevices** (groups, on the `/groups` path).
- JSON-RPC client to the CCU WebUI (device and channel names, system variables, programs) + ReGa scripts (rooms/functions, descriptions).
- **Central links** for button channels (`reportValueUsage` / `PRESS_SHORT`), so `PRESS_*` events reach the client, plus `getLinks` for direct links.
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

// Snapshot of the devices (with channels, data points and current values).
// `name` is the CCU name, or null when the CCU has none or the read failed.
for (const d of hm.devices()) {
  console.log(d.address, d.type, d.name);
  for (const ch of d.channels) console.log(' ', ch.address, ch.name);
}

// Button channels only push PRESS_* once they have a central link.
const key = '001B9D89A09163:1';
await hm.createCentralLink(key); // no-op if it already exists
console.log(await hm.getChannelLinkState(key)); // { central, links }
await hm.removeCentralLink(key);

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
- **State:** `devices()`, `getValue(ref)`, `setValue(ref, value)` (`ref` = data point id or `{ device, channel, parameter }`). `HmDevice.name` and `HmChannel.name` are `string | null` (CCU `Device.listAllDetail`; `null` if the CCU has no name or the read failed — never the address). A failed name read does not fail `start()`.
- **Key event programs** (_WebUI_, `ReGa.runScript`): `ensureKeyEventProgram({ name, channelAddresses, parameters? })` creates or rewrites a program whose conditions are `PRESS_SHORT` / `PRESS_LONG` (or the given subset) on update of those channels, so a HmIP device sends key presses. `getKeyEventProgram(name)` and `removeKeyEventProgram(name)` read and delete it by name. Two programs with the same name are refused (`ValidationError` with the ids). `deleteProgram(programId)` deletes any one program by its ReGa id (`{ removed: false }` when the id is missing or is not a program).
- **Links:** `getChannelLinkState(channelAddress)` → `{ central, links: { sender, receiver, name }[] }`. `central` is XML-RPC `getMetadata(address, "reportValueUsageData")` with `PRESS_SHORT > 0`. `links` is `getLinks(address, 0)`. `createCentralLink(channelAddress)` sends `reportValueUsage(address, "PRESS_SHORT", 1)` and is a no-op when a central link already exists. `removeCentralLink(channelAddress)` sends ref counter `0` and is a no-op when none exists. The same calls are used on HmIP-RF and BidCos-RF. A refusal is a `ClientError`.
- **Direct links:** `addLink(sender, receiver, name?, description?)` and `removeLink(sender, receiver)` (XML-RPC `addLink` / `removeLink`) are idempotent: an existing link is not added again, and removing an absent link makes no call. `listLinks(deviceOrChannelAddress)` → `{ sender, receiver, name, description, profile }[]`.
- **Switch link profiles** (`KEY_TRANSCEIVER` → `SWITCH_VIRTUAL_RECEIVER` only): `getLinkProfile(sender, receiver)` → `{ kind: 'switch', short, long }` with each press `toggle | on | off | none`, `{ kind: 'custom' }` when the receiver paramset (`getParamset(receiver, sender)`) matches no catalogue entry exactly, or `null` for any other channel pair. `setLinkProfile(sender, receiver, { short, long })` writes exactly the catalogue values with one `putParamset(receiver, sender, …)`; a `custom` link, a non-switch pair or a missing link is refused with a `ValidationError` and never rewritten. Catalogue: eq-3/occu `WebUI/www/config/easymodes/SWITCH_VIRTUAL_RECEIVER/KEY_TRANSCEIVER.tcl` (see `src/api/link-profile.ts`).
- **Names and rooms** (_WebUI_, `ReGa.runScript`): `renameDevice(address, name, { renameChannels })` (channels become `<name>:<channelIndex>`), `renameChannel(address, name)`; `devices()` shows the new names at once. `listRooms()` → `{ id, name, channels }[]` (channel addresses), `createRoom(name)` (a duplicate name is refused), `renameRoom(roomId, name)`, `deleteRoom(roomId)` (an unerasable room is refused), `addChannelToRoom(roomId, channelAddress)`, `removeChannelFromRoom(roomId, channelAddress)`. Names are 1..128 characters without control characters; the CCU stores latin1. `HmDevice.rooms` stays the snapshot taken at `start()`.
- **Custom entities:** `customEntities()` + commands `climateSetTemperature/climateSetMode/climateSetBoost`, `switchTurnOn/Off`, `lightTurnOn/Off/SetBrightness`, `coverOpen/Close/Stop/SetPosition`, `lockLock/Unlock/Open`.
- **Device config:** `getConfigParams(channelAddress)`, `getConfig(channelAddress)`, `setConfig(channelAddress, values)`.
- **Hub:** `systemVariables()`, `getSystemVariable(name)`, `setSystemVariable(name, value)`, `programs()`, `runProgram(idOrName)`, `setProgramActive(idOrName, active)`, `refreshHub()`.

- **CCU management** (call after `start()`; the ones marked _WebUI_ need `credentials`):
  - `listInterfaces()` → per interface `name`, `connected`, `dutyCycle`, `firmware`, `type`, `gateways` (BidCos radios). Anything the CCU did not answer is `null`, never `0`. Per-interface duty cycle, firmware and `connected` come from XML-RPC `listBidcosInterfaces` on both the BidCos-RF and HmIP-RF clients; `Interface.getDutyCycle` (string numbers, one entry, not attributable to HmIP) is only a BidCos-RF fallback.
  - Pairing: `setInstallMode({ interface, on, seconds?, mode? })` (default 60 s, `mode: 'secure'` is BidCos-only), `getInstallMode(interface)` → seconds left.
  - `deleteDevice(address, flags)` with `HM_DELETE_FLAGS.RESET | FORCE | DEFER` (`0` = plain removal).
  - _WebUI:_ `serviceMessages()` (`UNREACH`, `LOWBAT`, `CONFIG_PENDING`, `STICKY_UNREACH`, … with `acknowledgeable`), `acknowledgeServiceMessage(id)`, `ccuInfo()` (version, raw `product`/`platform` such as `ova`, derived `productFamily` `ccu3 | openccu | unknown`, serial, hostname), `groups()` (HmIP / HomeMatic heating groups with member channels).
  - _WebUI, undocumented:_ `createGroup({ name, type, members })`, `updateGroup(id, { name?, members? })`, `deleteGroup(id)`. No CCU API exists for these, so they replay the requests the WebUI's group pages send to the HMServer (`/pages/jpages/group/create|save|delete`, same session) and are firmware-dependent. Each write is verified by reading `groups()` back; a mismatch rejects with `GroupWriteVerificationError`.

## Notes

- The `callback.host` must be the IP of the machine running nodehomematic, **reachable by the CCU** (the CCU pushes events there).
- Rooms/functions are read via ReGa scripts; they appear only for the channels actually assigned to rooms/functions in the CCU.

## License

MIT — port of aiohomematic (original copyright SukramJ, Daniel Perna preserved). See `LICENSE`.
