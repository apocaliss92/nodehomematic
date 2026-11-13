# Changelog

## Unreleased

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
