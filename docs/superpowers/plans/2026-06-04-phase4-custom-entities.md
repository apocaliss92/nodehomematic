# nodehomematic — Phase 4: Custom Entities

> **For agentic workers:** TDD module-by-module. Builds on Phases 1–3 (merged, 0.1.0). Custom entities aggregate multiple generic data points into typed domain objects (Climate/Switch/Light/Cover/Lock…) via a declarative registry + profile config, faithful to aiohomematic's `model/custom`.

**Goal:** Custom-entity framework (device-type→config registry + profile field→parameter→channel + a base class that aggregates the `GenericDataPoint` by `Field`) + the main families (Climate incl. HmIP-HEATING groups, Switch, Light/Dimmer, Cover/Blind, Lock), exposed on the facade. Extensible for the rest.

**Architecture:** A `CustomEntity` owns no value state of its own: it acts as a typed view over the model's `GenericDataPoint` (Phase 3), resolving them by `Field`→`Parameter`→channel. The high-level properties read `dp.value`; the commands convert and route via `Homematic.setValue` (a single validated write path). Recognition is data-driven: a `DeviceProfileRegistry` table maps the device TYPE (normalized, exact match then prefix) to a `DeviceConfig {entityClass, profile, channels}`; a `ProfileConfig` describes the per-channel fields.

**Tech Stack:** strict TypeScript, Node 20+. Tests: vitest + fake model + real e2e (the user's 9 HmIP-HEATING groups → Climate).

---

## Facts (from aiohomematic model/custom — authoritative)
- **Field** = stable internal key; **Parameter** = CCU name on the channel (the enum value == CCU string). IP climate examples: SETPOINT→`SET_POINT_TEMPERATURE`, TEMPERATURE→`ACTUAL_TEMPERATURE`, HUMIDITY→`HUMIDITY`, SET_POINT_MODE→`SET_POINT_MODE` (0 AUTO/1 MANU/2 AWAY), CONTROL_MODE→`CONTROL_MODE` (action write), BOOST_MODE→`BOOST_MODE`, ACTIVE_PROFILE→`ACTIVE_PROFILE`, LEVEL→`LEVEL` (valve %), STATE→`STATE`.
- **Recognition:** normalize `model.toLowerCase().replace('hb-','hm-')`; EXACT match then PREFIX; a model may map to multiple configs (e.g. lock+button-lock). Base channels default `(1,)`; relative primary_channel (default 0); secondary/state offset.
- **Climate:** Simple/RF/IP thermostat classes. IP is also used for the GROUPS (`HmIP-HEATING`): same class `CustomDpIpThermostat`, profile `IP_THERMOSTAT_GROUP` with `include_default_data_points=false` (the groups have no ch0 battery/RSSI), channel_fields `0→{LEVEL}`, `3→{STATE}`. Modes: target≤4.5→OFF; SET_POINT_MODE MANU→HEAT; AUTO→AUTO. Preset: BOOST if boost_mode, AWAY if SET_POINT_MODE=2, else week program (ACTIVE_PROFILE). Step 0.5, unit °C.
- **Switch:** STATE→`STATE`, turn_on/off, on_time opt.; additional energy DP (POWER/VOLTAGE/CURRENT/ENERGY_COUNTER) on a dedicated channel.
- **Light/Dimmer:** LEVEL→`LEVEL` (0..1 float). brightness 0–255: `level=brightness/255`. Color (COLOR/HUE/SATURATION/COLOR_TEMPERATURE) for RGB/tunable. is_on = level>0.
- **Cover/Blind:** LEVEL→`LEVEL`, STOP→`STOP`, DIRECTION→`ACTIVITY_STATE`(IP)/`DIRECTION`(RF). position 0–100: `level=position/100`. Blind: LEVEL_2 (slat tilt). open=1.0/close=0.0/stop(critical).
- **Lock:** IP: LOCK_STATE→`LOCK_STATE` (LOCKED/UNLOCKED), LOCK_TARGET_LEVEL→`LOCK_TARGET_LEVEL` (LOCKED/UNLOCKED/OPEN). RF: STATE→`STATE` (lock=false/unlock=true), OPEN→`OPEN`. CRITICAL commands.
- **DataPointUsage:** the custom entity marks the underlying DPs: visible→shown; default-consumed→hidden (owned). For our port: all GenericDataPoint stay in the model; the custom entity is an additional VIEW (we do not remove the DPs). We optionally expose a `hidden` flag on the consumed DPs.

---

## File structure (Phase 4)
```
src/model/custom/
  fields.ts            # enum Field (stable keys) + the CCU Parameter consts used
  profile.ts           # ProfileConfig/ChannelGroupConfig/FieldValue types + PROFILE_CONFIGS (IP_THERMOSTAT, IP_THERMOSTAT_GROUP, IP_SWITCH, IP_DIMMER, IP_COVER, IP_BLIND, IP_LOCK, RF_*…)
  registry.ts          # DeviceProfileRegistry: DeviceConfig + register/getConfigs(model) (exact→prefix, normalize)
  base.ts              # CustomEntity base: resolves Field→GenericDataPoint from the ModelDevice, field access, subscribe, command routing via writer
  resolve.ts           # buildCustomEntities(device: ModelDevice, writer): CustomEntity[] (applies registry+profile, rebases channels)
  helpers.ts           # brightnessToLevel/levelToBrightness, positionToLevel/levelToPosition
  climate.ts           # ClimateEntity (IP thermostat + group): target/current temp, humidity, mode, preset, setTemperature/setMode/setPreset/boost
  switch.ts            # SwitchEntity: on/off, turnOn(onTime?)/turnOff
  light.ts             # LightEntity/DimmerEntity: brightness, isOn, turnOn/turnOff/setBrightness (+ColorLight if trivial)
  cover.ts             # CoverEntity/BlindEntity: position, isClosed, open/close/stop/setPosition (+tilt)
  lock.ts              # LockEntity (IP+RF): isLocked, lock/unlock/open
  index.ts             # registers all families (side-effect import) + type exports
src/api/
  types.ts             # + custom public types: HmCustomEntity union (HmClimate/HmSwitch/HmLight/HmCover/HmLock) with fields/actions
  homematic.ts         # + customEntities(): HmCustomEntity[]; + per-action: entity command methods or a generic method
tests/unit/model/custom/...  tests/e2e/custom-*.test.ts
```

---

## Tasks (TDD)

### Task 1: fields + profile types + registry (framework, no families yet)
- `fields.ts`: `enum Field` (the report keys: STATE, LEVEL, LEVEL_2, STOP, DIRECTION, SETPOINT, TEMPERATURE, HUMIDITY, SET_POINT_MODE, CONTROL_MODE, BOOST_MODE, ACTIVE_PROFILE, LOCK_STATE, LOCK_TARGET_LEVEL, OPEN, COLOR, HUE, SATURATION, COLOR_TEMPERATURE, ON_TIME_VALUE, …). `Parameter` const map (Field is not enough: the CCU string is needed). For simplicity a `FieldMapping { field: Field; parameter: string; visible?: boolean; channelOffset?: number }`.
- `profile.ts`: types `ChannelGroupConfig { primaryChannel?: number; secondaryChannels?: number[]; stateChannelOffset?: number; fields: FieldMapping[]; channelFields?: Record<number, FieldMapping[]>; additionalParameters?: Record<number, string[]>; includeDefaultDataPoints?: boolean }`, `ProfileConfig` (alias). `DeviceProfile` enum (IP_THERMOSTAT, IP_THERMOSTAT_GROUP, IP_SWITCH, IP_DIMMER, IP_COVER, IP_BLIND, IP_LOCK, RF_THERMOSTAT, RF_SWITCH, …). `PROFILE_CONFIGS: Record<DeviceProfile, ChannelGroupConfig>` (populated incrementally by the families, or here for the main ones).
- `registry.ts`: `DeviceConfig { entityClass: CustomEntityCtor; profile: DeviceProfile; channels: number[] }`. `DeviceProfileRegistry` with `register(model, config)`, `registerMultiple(model, configs[])`, `getConfigs(model): DeviceConfig[]` (normalize lower + `hb-`→`hm-`; exact then prefix). Exported singleton.
- Test: normalize+exact and prefix match; registerMultiple; getConfigs returns [] for an unknown model.
- Commit: `feat(custom): framework — fields, profile config, device registry`.

### Task 2: CustomEntity base + resolve + helpers + Switch (reference family)
- `base.ts`: `abstract class CustomEntity` `{ readonly deviceAddress; readonly primaryChannelAddress; readonly type: string; protected dp(field: Field): GenericDataPoint | undefined; protected requireDp(field): GenericDataPoint; protected async write(field, value): Promise<void> /* via injected writer = (dpk,value)=>Promise */; subscribe(cb): ()=>void /* aggregates the DP subscriptions */; get available(): boolean }`. Resolves the Field→GenericDataPoint using a map built in `resolve.ts`.
- `resolve.ts`: `buildCustomEntities(device: ModelDevice, writer): CustomEntity[]` — for the device, `registry.getConfigs(device.type)`; for each config, for each base channel apply the ProfileConfig (rebase relative→absolute), resolve the `GenericDataPoint` from the `ModelDevice` (by channelAddress+parameter), instantiate the entityClass with the Field→DP map + writer. Defensive: a missing field → absent DP (the getters return undefined/null).
- `helpers.ts`: `brightnessToLevel(0..255)→0..1`, `levelToBrightness`, `positionToLevel(0..100)→0..1`, `levelToPosition`.
- `switch.ts`: `class SwitchEntity extends CustomEntity` — `get isOn(): boolean` (= dp(STATE).value===true), `async turnOn(): Promise<void>`, `async turnOff()`. Registers in `index.ts` for the main switch models (HmIP-PS ch3, HmIP-BSM ch4, HM-LC-Sw* ch1).
- Test: with a fake ModelDevice (switch, channel with writable STATE) → SwitchEntity.isOn reflects the DP; turnOn calls the writer with the STATE dpk and value true (converted); resolve builds the SwitchEntity from the registry.
- Commit: `feat(custom): CustomEntity base + resolver + Switch family`.

### Task 3: Climate (IP thermostat + heating group) — PRIORITY
- `climate.ts`: `class ClimateEntity extends CustomEntity`:
  - getters: `currentTemperature` (TEMPERATURE/ACTUAL_TEMPERATURE), `targetTemperature` (SETPOINT/SET_POINT_TEMPERATURE), `currentHumidity` (HUMIDITY), `minTemp`/`maxTemp` (from the dp metadata), `targetTemperatureStep`=0.5, `mode` ('auto'|'heat'|'off' via SET_POINT_MODE + 4.5 threshold), `preset` ('boost'|'away'|'none'|week-program via BOOST_MODE/SET_POINT_MODE/ACTIVE_PROFILE), `activity` ('heating'|'idle'|'off' from LEVEL/STATE).
  - commands: `async setTemperature(t)`, `async setMode('auto'|'heat'|'off')` (AUTO→CONTROL_MODE=0; HEAT→CONTROL_MODE=1; OFF→temp 4.5), `async setBoost(on)`, `async setProfile(weekProgramIndex)`.
- `profile.ts`: add `IP_THERMOSTAT_CONFIG` and `IP_THERMOSTAT_GROUP_CONFIG` (group: includeDefaultDataPoints=false, channelFields 0→LEVEL, 3→STATE). Register: `HmIP-eTRV*`, `HmIP-(B)WTH*`, `HmIP-HEATING` (group, channels (1,)), `HmIP-STH*`, `HmIP-FALMOT*` (valve actuator — verify: FALMOT is a multi-channel valve actuator; it might NOT be climate but expose LEVEL per channel → treat as valve/climate per channel; if uncertain, register it as thermostat group-like or leave it generic and note it).
- Test: ClimateEntity with fake DPs (SET_POINT_TEMPERATURE=21, ACTUAL_TEMPERATURE=20.5, HUMIDITY=45, SET_POINT_MODE=1) → targetTemperature 21, currentTemperature 20.5, mode 'heat'; setTemperature(22) → writer on SET_POINT_TEMPERATURE; setMode('off') → CONTROL_MODE write + temp 4.5; setBoost(true) → BOOST_MODE write.
- Commit: `feat(custom): Climate (IP thermostat + heating group)`.

### Task 4: Light, Cover, Lock
- `light.ts`: `DimmerEntity` — `brightness` (0..255 from LEVEL), `isOn`, `turnOn(brightness?)`, `turnOff()`, `setBrightness(0..255)`. (Color optional: if trivial add `ColorLightEntity` with HUE/SATURATION; otherwise defer.)
- `cover.ts`: `CoverEntity` — `currentPosition` (0..100 from LEVEL), `isClosed`, `open()`, `close()`, `stop()`, `setPosition(0..100)`. `BlindEntity extends CoverEntity` with `currentTiltPosition` (LEVEL_2) + `setPosition(pos, tilt?)`.
- `lock.ts`: `LockEntity` — IP: `isLocked` (LOCK_STATE), `lock/unlock/open` (LOCK_TARGET_LEVEL). RF variant (STATE/OPEN). 
- Register the main models in `index.ts`.
- Test for each: getters from the fake DPs + commands that route the correct converted values to the writer.
- Commit: `feat(custom): Light, Cover, Lock families`.

### Task 5: facade integration + public types
- `api/types.ts`: custom public types. Pragmatic approach: `HmCustomEntity` discriminated union by `kind` ('climate'|'switch'|'light'|'cover'|'lock') with the state fields + (for the commands) do NOT put functions in the snapshot types; commands are done via facade methods. E.g. `HmClimate { kind:'climate'; device; channel; currentTemperature; targetTemperature; currentHumidity?; mode; preset; minTemp?; maxTemp? }`, etc. Immutable snapshot.
- `homematic.ts`: in `start()`, after building the model, build the custom entities (`buildCustomEntities` for each device, writer = `(dpk,val)=>this.#central.setValue(dpk,val)` or the prepareWrite path). Keep a `Map<deviceAddress, CustomEntity[]>`.
  - `customEntities(): HmCustomEntity[]` — public snapshot.
  - `customEntity(deviceAddress, channel?): CustomEntity | undefined` — access to the live object (for the commands). BUT to avoid exposing internal types: expose command methods on the facade: `async climateSetTemperature(deviceAddress, channelOrAddress, t)`, `async climateSetMode(...)`, `async switchTurnOn/Off(...)`, `async coverSetPosition(...)`, `async lockLock/Unlock(...)`, etc. OR a generic `async command(ref, action, args)` method. Choose the explicit-methods approach for ergonomics and type-safety; document it.
  - update the custom entities on `deviceAdded`/`deviceRemoved`.
  - the entities emit via the underlying DPs → the facade can emit a `customEntityChanged` event (optional; the `valueChanged` stream already covers the raw changes). For the first cut: do NOT add a new event, the snapshot + valueChanged is enough.
- `index.ts`: exports the custom public types (`HmCustomEntity` and the members). Does NOT export the internal CustomEntity classes.
- Unit test: the facade builds the custom entities; `customEntities()` correct snapshot; `climateSetTemperature(addr, ch, 22)` routes to setValue with SET_POINT_TEMPERATURE converted.
- Commit: `feat(api): expose custom entities + command methods on facade`.

### Task 6: real e2e + integration
- e2e `tests/e2e/custom-smoke.test.ts` (gated HM_E2E): `Homematic` with all interfaces; `start()`; find the 9 `HmIP-HEATING` → assert they are ClimateEntity with numeric `targetTemperature`/`currentTemperature` and a populated `mode`; log an example. READ-ONLY (NO real setTemperature, or at most reads). Verify that `customEntities()` contains climate. Count the custom entities by kind.
- Integration (fake CCU): a switch device + a canned climate group → populated customEntities; a command routes to the fake.
- Commit: `test(custom): e2e + integration custom entities`.

## Phase 4 final gate
`npm run lint && npm run format:check && npm run typecheck && npm run test:cov && npm run build` green, coverage ≥ 80%. Real e2e: the 9 groups recognized as Climate.

## Notes / scope
- "All custom types" is a huge catalog: this phase delivers the FRAMEWORK + Climate/Switch/Light/Cover/Lock with the registrations of the main models. Other families (siren, valve, garage, RGBW, fixed-color, button-lock, smoke) are added with new registrations in the registry without touching the core — to be noted as later extensions.
- The custom entities are VIEWS: they do not remove the GenericDataPoint from the model (the `valueChanged` stream stays complete).

## Self-review
- §spec custom entities: framework (T1), base+switch (T2), climate (T3), light/cover/lock (T4), facade (T5), e2e (T6). ✅ Full catalog = incremental extensions via the registry. ✅
