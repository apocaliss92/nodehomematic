# Changelog

## [Unreleased]

## [0.9.3] - 2026-11-21

### Added

- `Homematic.keyProgramReferences(keyAddresses)` reads, in one ReGa scan of all programs, which CCU programs reference a key channel (`PRESS_SHORT` / `PRESS_LONG`), including programs written by hand on the CCU. It rejects when the CCU cannot be read.
- `Homematic.refreshNames()` re-reads device and channel names from the CCU WebUI, so a rename done on the CCU shows in `devices()`.

### Fixed

- A `newDevices` / re-added device is named from a fresh WebUI read, not the snapshot taken at `start()`, so a device named after pairing no longer shows without its name.

## [0.9.1] - 2026-11-16

### Fixed

- JSON-RPC logins are never locked out: a refused login backs off (1 s doubling, up to 5 min) and all callers share one login attempt; `LoginBackoffError` names the wait.
- The session heals after a CCU reboot: a call that fails on an expired session logs in again and retries once; a reconnect resets the backoff.
- A JSON-RPC call that a booting CCU answers with HTTP 5xx is retried after 0.5, 1 and 2 s, then fails with `BackendUnavailableError`.

## [0.9.0] - 2026-11-14

### Added

- `deleteProgram(programId)` deletes one CCU program by its ReGa id (digits only). A missing id, or an id that is not a program, returns `{ removed: false }` and deletes nothing. Needs WebUI credentials. The script deletes only an id listed by `ID_PROGRAMS.EnumUsedIDs()`, then `dom.DeleteObject` (`programs.fn` `DeleteProgram`).

### Fixed

- `ensureKeyEventProgram`, `getKeyEventProgram` and `removeKeyEventProgram` no longer follow the last program when several share a name. They throw `ValidationError` naming the program and its ids; `deleteProgram(id)` removes one of them.

## 0.8.1

### Fixed

- A key press (`PRESS_SHORT`, `PRESS_LONG`, any ACTION parameter) pushed by the CCU is emitted as `valueChanged` every time. Each press carries the same `true`, so the "value unchanged" check swallowed every press after the first until something reset the value. A value read back from a VALUES paramset (start-up seeding) is never emitted as a press.

## 0.8.0

### Added

- `diagnoseKeyEvents(deviceAddress)`: a read-only diagnosis of "why does a HmIP key not deliver `PRESS_SHORT`?". For the device's key channels it reads the central link counter, direct links, VALUES and MASTER over XML-RPC, the maintenance channel `:0` (`CONFIG_PENDING`, `UNREACH`, `RSSI_DEVICE`, `RSSI_PEER`, `UPDATE_PENDING`), the ReGa channel and `PRESS_*` data point objects (value, last update) and every program whose condition references them (needs WebUI credentials; otherwise `rega.available` is `false`), plus when this client last received an event per parameter and the interface's connection state. Each section fails on its own with `{ ok: false, error }`. ReGa properties are cited in `src/central/rega/key-diagnosis.ts`; unverified against a live CCU.

## 0.7.0

### Added

- Key event programs for HmIP: `ensureKeyEventProgram`, `getKeyEventProgram` and `removeKeyEventProgram`. A HmIP device sends key presses to the access point only while a CCU program uses the key; `ensureKeyEventProgram` creates (or rewrites, idempotent by name) a program whose conditions are `PRESS_SHORT` / `PRESS_LONG` on update of the given channels, with no destination. ReGa scripts modelled on eq-3/occu `WebUI/bin/hm_autoconf` and `rega/esp/{sico,programs}.fn`; unverified against a live CCU.

## 0.6.0

### Added

- Direct links: `addLink`, `removeLink` (both idempotent) and `listLinks`, which returns each link's name, description and resolved profile.
- Switch link profiles for `KEY_TRANSCEIVER` → `SWITCH_VIRTUAL_RECEIVER` links: `getLinkProfile` reads short and long press as `toggle | on | off | none`, or `custom` when the paramset matches no catalogue entry exactly; `setLinkProfile` writes exactly the catalogue values and never rewrites a `custom` link. The catalogue comes from eq-3/occu `WebUI/www/config/easymodes/SWITCH_VIRTUAL_RECEIVER/KEY_TRANSCEIVER.tcl`.
- Renames over ReGa: `renameDevice` (optionally every channel to `<name>:<channelIndex>`) and `renameChannel`; `devices()` reflects the new names.
- Rooms over ReGa: `listRooms`, `createRoom`, `renameRoom`, `deleteRoom`, `addChannelToRoom`, `removeChannelFromRoom`.

### Changed

- `getParamset` / `putParamset` on the interface client accept a peer channel address as the paramset key (link paramsets).
