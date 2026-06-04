# nodehomematic — Phase 3: Generic model + Public facade

> **For agentic workers:** TDD module-by-module. Builds on Phase 1 (transport) + Phase 2 (central), both merged to main. This phase delivers the FIRST usable npm release: a public `Homematic` facade with a global `valueChanged` stream + `setValue`, on top of a generic data-point model.

**Goal:** Generic model (GenericDataPoint with CCU↔JS conversion/validation) + public Device/Channel/DataPoint views + event-driven `Homematic` facade (global `valueChanged` stream, `setValue`, lifecycle events). Publishable as npm `0.x`.

**Architecture:** The model subscribes to the `CentralUnit` `EventBus` (Phase 2): each `valueReceived` updates the corresponding `GenericDataPoint` (via dpk) and produces a state change. The `Homematic` facade wraps the `CentralUnit`, exposes a clean, system-agnostic surface (no CCU/XML-RPC type leaks) and re-emits a typed EventEmitter. Writes go through `setValue` with validation against the data point metadata, then delegate to `CentralUnit.setValue` → `InterfaceClient`.

**Tech Stack:** strict TypeScript, Node 20+. Typed EventEmitter (custom, no deps). Internal conversion validation (no zod needed here; the metadata drives validation). Tests: vitest + the existing fakes/fake-CCU; real e2e optional at the end of the phase.

---

## Conversion/validation facts (from aiohomematic)
- `ParameterType`: ACTION, BOOL, ENUM, FLOAT, INTEGER, STRING.
- **Inbound CCU→JS:** empty string `""` → `null` for numeric types; BOOL may have a VALUE_LIST (index↔string); unit cleanup; multiplier for certain units (deferrable). FLOAT/INTEGER → number; BOOL → boolean; ENUM → numeric index (the CCU sends the index) which we can expose as a string via VALUE_LIST; STRING → string.
- **Outbound JS→CCU:** ENUM serialized as an **integer index for HM, a string for HmIP** (decide based on the MIN type: if MIN is numeric → index). For the first release: accept both an index and a string-from-VALUE_LIST; convert to an index if the family is HM-style (numeric MIN/valueList present), otherwise pass the string. Document the heuristic.
- **Write validation:** writable requires `OPERATIONS & WRITE`; MIN/MAX range for numerics; ENUM must be in VALUE_LIST (or a valid index); BOOL coercible; ACTION is a write-only trigger (value typically `true`). Errors → `ValidationError`.
- `available`: the data point is available if the device is online (for now: always true unless the interface connection state is DISCONNECTED → false). `isValid`: has a confirmed value + valid type/range.

---

## File structure (Phase 3)
```
src/model/
  converter.ts        # convertFromCcu(spec, raw) / convertToCcu(spec, value, interfaceFamily) + validate
  data-point.ts       # GenericDataPoint: dpk, spec, current value, write/eventUpdate, readable/writable/hasEvents, subscribe
  device.ts           # ModelDevice: address, type, name, rooms?, channels: ModelChannel[]
  channel.ts          # ModelChannel: address, index, dataPoints: GenericDataPoint[]
  model-builder.ts    # builds ModelDevice[] from DeviceNode[] (Phase 2 graph) creating the GenericDataPoint (one per VALUES parameter with EVENT/READ)
src/api/
  emitter.ts          # minimal TypedEventEmitter<EventMap> (on/off/once/emit)
  events.ts           # HomematicEventMap: valueChanged, deviceAdded, deviceRemoved, connection, ready, error
  types.ts            # public types: HmDevice, HmChannel, HmDataPoint, HmValue, DataPointId, event payloads
  homematic.ts        # class Homematic: facade over CentralUnit
src/index.ts          # public export: Homematic + public types (NO internal transport/central)
tests/unit/model/...  tests/unit/api/...  tests/integration/facade-*.test.ts
```

---

## Tasks (TDD)

### Task 1: converter
- `src/model/converter.ts`:
  - `convertFromCcu(spec: ParameterSpec, raw: unknown): HmValue` — FLOAT/INTEGER: number; `""`→null; BOOL→boolean (and if VALUE_LIST present, normalize); ENUM→ if VALUE_LIST present and raw is a numeric index → map to the VALUE_LIST string (also keep the index accessible? for now expose the string); STRING→string; ACTION→boolean/none.
  - `convertToCcu(spec, value, opts:{enumAsIndex:boolean}): unknown` — numerics: validate MIN/MAX range → number; BOOL→boolean; ENUM: if `enumAsIndex` convert string→index via VALUE_LIST (or accept an index), otherwise pass the string; STRING→string; ACTION→true. Throw `ValidationError` on an invalid value (out of range, unknown enum, incompatible type).
  - `validateWritable(spec)` → throw `UnsupportedError` if not writable.
  - `HmValue = boolean | number | string | null`.
- Test: range out-of-bounds → ValidationError; enum string↔index round-trip; empty string→null for FLOAT; BOOL coercion; ACTION→true; write on a non-writable spec → UnsupportedError.
- Commit: `feat(model): value converter + validation (CCU↔JS)`.

### Task 2: GenericDataPoint
- `src/model/data-point.ts`: `GenericDataPoint`:
  - built from `{ dpk, spec, interfaceFamily }`. Getters: `id` (=dpkToUniqueId), `parameter`, `type`, `readable/writable/hasEvents/visible`, `unit`, `valueList`, `min/max`.
  - state: `value: HmValue` (current, default null), `lastUpdatedAt?: number`.
  - `applyCcuValue(raw, at)`: converts via the converter and updates `value` + timestamp; returns `{changed, prev, next}`.
  - `prepareWrite(value): unknown`: validates writable + converts to CCU (enumAsIndex decided by interfaceFamily/spec).
  - `subscribe(cb: (next, prev) => void): () => void` (local notification; the facade will use the global event bus, but the DP can notify).
- Test: applyCcuValue updates and signals changed/prev/next; prepareWrite validates and converts; hasEvents/readable/writable from spec.
- Commit: `feat(model): GenericDataPoint`.

### Task 3: device/channel + model-builder
- `device.ts`/`channel.ts`: `ModelDevice {address, type, interfaceId, name?, rooms?, channels: ModelChannel[]; dataPoint(channelAddress, parameter)}`, `ModelChannel {address, index, type?, dataPoints: GenericDataPoint[]}`. Immutable after construction (the DPs have internal state but the structure is fixed).
- `model-builder.ts`: `buildModel(devices: DeviceNode[], interfaceFamilyOf): ModelDevice[]` — for each DeviceNode create a ModelChannel per channel and a `GenericDataPoint` for each VALUES parameter that is readable or hasEvents (skip purely internal/SERVICE parameters if you want, but for the first release include all VALUES). `interfaceFamilyOf(interfaceId)` → 'HM' | 'HMIP' (heuristic: contains 'HmIP' → HMIP).
- Test: buildModel from a canned DeviceNode → ModelDevice with correct channels and DPs; dataPoint(channel,param) lookup.
- Commit: `feat(model): device/channel views + model builder`.

### Task 4: typed emitter + public events/types
- `api/emitter.ts`: `TypedEventEmitter<TMap extends Record<string, unknown>>` with type-safe `on/off/once/emit` (wraps `node:events` or its own implementation). 
- `api/events.ts`: `HomematicEventMap`:
  - `valueChanged: { dpId: string; device: string; channel: string; parameter: string; value: HmValue; prevValue: HmValue; ts: number }`
  - `deviceAdded: { device: string }`, `deviceRemoved: { device: string }`
  - `connection: { interfaceId: string; state: string }`
  - `ready: void`, `error: Error`
- `api/types.ts`: `HmDevice {address, type, name?, rooms?, channels: HmChannel[]}`, `HmChannel {address, index, dataPoints: HmDataPoint[]}`, `HmDataPoint {id, parameter, type, value, unit?, readable, writable, hasEvents, valueList?, min?, max?}`, `DataPointId = string`, `DataPointRef = string | { device: string; channel: number|string; parameter: string }`.
- Test: emitter on/off/once/emit type-safe; once fires only once.
- Commit: `feat(api): typed event emitter + public types`.

### Task 5: Homematic facade
- `api/homematic.ts`: `class Homematic`:
  - constructor `{ host, interfaces: ('HmIP-RF'|'BidCos-RF'|...)[], credentials?, callback:{host,port}, cache?:{dir?,enabled?}, tls?, centralName? }` → builds a `CentralUnit` internally (maps the interface strings to `Interface`).
  - extends/contains a `TypedEventEmitter<HomematicEventMap>` (expose `on/off/once`).
  - `async start()`: `central.start()`; build the model from `central.registry`; **subscribe** to `central.eventBus`:
    - `valueReceived` → find the GenericDataPoint via dpk, `applyCcuValue`, if changed emit `valueChanged` (with prev/next, device/channel/parameter extracted from the dpk).
    - `deviceAdded`/`deviceRemoved` → update the model + emit the public events.
    - `connectionStateChanged` → emit `connection`.
    - `ready` → emit `ready`.
    - `systemError` → emit `error`.
  - `async stop()`: `central.stop()`.
  - `devices(): HmDevice[]` (immutable public snapshot from the model).
  - `getValue(ref: DataPointRef): HmValue` (from the model/value cache).
  - `async setValue(ref: DataPointRef, value: HmValue): Promise<void>`: resolve the GenericDataPoint, `prepareWrite(value)` (validate+convert), then `central.setValue(dpk, ccuValue)`.
  - `DataPointRef` resolution: string = dpId (uniqueId) → dpk; object {device, channel, parameter} → build channelAddress `device:channel` and a VALUES dpk.
  - No internal types exposed in the public signatures.
- `src/index.ts`: exports `Homematic`, `HmDevice`, `HmChannel`, `HmDataPoint`, `HmValue`, `DataPointRef`, the event payloads. Does NOT export transport/central.
- Test (unit with a mocked/fake CentralUnit that exposes eventBus+registry+setValue): start builds the model and subscribes; a `valueReceived` published on the bus → the facade emits `valueChanged` with correct prev/next; `setValue({device,channel,parameter}, v)` validates and calls `central.setValue` with the converted value; `setValue` out of range → ValidationError (does not call central).
- Commit: `feat(api): Homematic public facade (valueChanged stream + setValue)`.

### Task 6: facade integration + (opt.) e2e
- Integration test (with the real FakeCcu, reusing the Phase 2 wiring but through the `Homematic` facade): `start()` → `devices()` populated; FakeCcu `emitEvent` → the facade emits `valueChanged`; `setValue` reaches the FakeCcu; clean `stop()`.
- Update/add a real e2e `tests/e2e/facade-smoke.test.ts` (gated HM_E2E): `new Homematic({...from env})`, `start()`, assert `devices().length>0` and that the DPs have metadata (type/readable), short `valueChanged` wait, `stop()`. READ-ONLY.
- Commit: `test(api): facade integration + e2e smoke`.

### Task 7: Device configuration (MASTER paramset) on the facade — to build a config UI
Goal: expose the building blocks for a device configuration UI (like the native HA `homematicip_local` panel): device → channels → MASTER parameters with metadata to generate the forms, + read/write of the MASTER values.
- The `model-builder`/`GenericDataPoint` concern the VALUES (live state). The MASTER configuration is SEPARATE: it uses the MASTER descriptions already in `ParamsetDescriptionCache` (discovered in Phase 2) + `InterfaceClient`'s `getParamset`/`putParamset`.
- Public types (`api/types.ts`): `HmConfigParam { parameter, type, min?, max?, default?, unit?, valueList?, flags, writable }` and `HmChannelConfig { channelAddress, params: HmConfigParam[] }`.
- On the `Homematic` facade:
  - `getConfigParams(channelAddress: string): HmConfigParam[]` — the channel's MASTER parameter SPECs (from the paramset cache via `central`), to generate the forms. (Expose from CentralUnit a read-only accessor to the `ParamsetDescriptionCache` or a `central.getParamsetSpec(interfaceId, channelAddress, 'MASTER')` method.)
  - `async getConfig(channelAddress: string): Promise<Record<string, HmValue>>` — current MASTER values (delegates to `central` → `InterfaceClient.getParamset(channelAddress, 'MASTER')`, converts via the converter).
  - `async setConfig(channelAddress: string, values: Record<string, HmValue>): Promise<void>` — validates each value against the MASTER spec (range/enum/type, writable) and writes in a single `putParamset(channelAddress, 'MASTER', ccuValues)`.
- Extend `CentralUnit` with: `getParamsetSpec(interfaceId, channelAddress, paramsetKey): Record<string, ParameterData> | undefined` (read from the paramset cache) and `getParamset(dpkOrChannel, paramsetKey)` / `putParamset(channelAddress, paramsetKey, values)` that route to the right `InterfaceClient` by interfaceId.
- Test: `getConfigParams` returns the channel's MASTER specs; `getConfig` reads and converts; `setConfig` validates (an out-of-range value → ValidationError, does NOT write) and on valid values calls `putParamset` only once with the converted values.
- Commit: `feat(api): device configuration (MASTER paramset) on the facade`.

## Phase 3 final gate
`npm run lint && npm run format:check && npm run typecheck && npm run test:cov && npm run build` green, coverage ≥ 80%. Bump `package.json` to `0.1.0` (first functional release) in a dedicated commit at the end of the phase (do NOT publish to npm without user approval).

## Self-review
- Spec §5 (public API) + §6 (generic model+hub) coverage: converter (T1), GenericDataPoint (T2), device/channel/builder (T3), emitter/events/types (T4), facade (T5), integration+e2e (T6). Hub (sysvar/programs) and custom entities remain Phases 4/5. ✅
- Public boundary: `index.ts` exports only `api/` + public types; transport/central internal. ✅
- Single global `valueChanged` stream (no per-device), validated `setValue`. ✅
