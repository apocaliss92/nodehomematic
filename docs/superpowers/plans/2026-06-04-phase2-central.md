# nodehomematic — Phase 2: Central Implementation Plan

> **For agentic workers:** TDD module-by-module (RED→GREEN→commit). Builds on the Phase 1 transport (already merged to main). The central orchestrates transport + produces the device graph + drives rock-solid reconnection. Validated with a fake CCU; reconnect scenarios tested by making the fake CCU drop/restart.

**Goal:** Central orchestration: typed event bus, persistent description cache (device+paramset, invalidation by schema-version) + dynamic value cache, immutable device registry, discovery (listDevices→paramset→merge names/rooms JSON-RPC→Device/Channel/DataPointSpec graph→initial values), and **rock-solid** reconnect (ping/pong + callback liveness + connection-check + stage progression + backoff + re-init + breaker reset + value re-sync). Everything under `src/central/`, plus additions to `src/support/`.

**Architecture:** `CentralUnit` is the internal facade. It uses N `InterfaceClient` (Phase 1) + one shared `CallbackServer`. The raw callback-server events are normalized and routed onto the typed internal `EventBus`; values flow into the value cache and generate `valueReceived` events. Discovery builds an immutable device/channel/parameter graph. `ConnectionRecovery` makes the reconnection robust. No model/facade domain logic (that is Phase 3): the graph here is typed raw data (descriptions + values).

**Tech Stack:** strict TypeScript, Node 20+. Storage: JSON files via `node:fs/promises` behind an injectable `StorageBackend` abstraction (so the tests use an in-memory store). Tests: vitest + the extended `FakeCcu` (from Phase 1).

---

## Facts (from the aiohomematic `devel` source) — authoritative summary

### Enums (const.py) to add to `src/support/constants.ts`
- `Operations` (bitmask): NONE=0, READ=1, WRITE=2, EVENT=4. Gating: readable=`op&READ`, writable=`op&WRITE`, hasEvents=`op&EVENT`.
- `Flag` (bitmask): VISIBLE=1, INTERNAL=2, TRANSFORM=4, SERVICE=8, STICKY=0x10. visible=`flags&VISIBLE`, service=`flags&SERVICE`.
- `ParameterType` (string): ACTION, BOOL, ENUM, FLOAT, INTEGER, STRING, DUMMY, EMPTY="".
- `ParamsetKey` (string): MASTER, VALUES, LINK, SERVICE, CALCULATED, COMBINED, DUMMY. (Discovery fetches VALUES+MASTER, skips LINK.)
- `RxMode` (bitmask): UNDEFINED=0, ALWAYS=1, BURST=2, CONFIG=4, WAKEUP=8, LAZY_CONFIG=16.
- `DeviceFirmwareState` (string enum) — the report values (UNKNOWN, UP_TO_DATE, NEW_FIRMWARE_AVAILABLE, READY_FOR_UPDATE, PERFORMING_UPDATE, …).
- `ParameterStatus`: NORMAL, UNKNOWN, OVERFLOW, UNDERFLOW, ERROR, INVALID, UNUSED, EXTERNAL.

### DeviceDescription (uppercase fields, already partially in `xmlrpc/types.ts` — extend)
Required: `TYPE, ADDRESS, PARAMSETS: string[], CHILDREN: string[]`. Opt: `PARENT, PARENT_TYPE, SUBTYPE, INTERFACE, INDEX, VERSION, FLAGS, DIRECTION, FIRMWARE, AVAILABLE_FIRMWARE, FIRMWARE_UPDATE_STATE, FIRMWARE_UPDATABLE, RX_MODE, AES_ACTIVE, ROAMING, GROUP, TEAM, TEAM_CHANNELS, RF_ADDRESS`. A device has an empty/absent PARENT; a channel has `ADDRESS="DEV:idx"` and `PARENT=devAddress`.

### ParameterData (per VALUES/MASTER parameter)
`TYPE` (FLOAT|INTEGER|BOOL|ENUM|STRING|ACTION|DUMMY), `OPERATIONS:int`, `FLAGS:int`, `DEFAULT, MIN, MAX, UNIT?, VALUE_LIST?:string[], SPECIAL?, ID?, CONTROL?, TAB_ORDER?`.

### DataPointKey (dpk) — identity of a value point
`{ interfaceId, channelAddress, paramsetKey, parameter }`. Derived `unique_id` string = `${interfaceId}:${channelAddress}:${paramsetKey}:${parameter}` (lowercased/normalized). Used to route the `event(...)` calls to the data points.

### Discovery sequence
1. `client.listDevices()` → entries (devices+channels). Dedup by address (device) or parent (channel).
2. For each NEW device: save descriptions in cache, then for each channel iterate `PARAMSETS` and call `getParamsetDescription(channelAddress, key)` for VALUES and MASTER (SKIP LINK).
3. JSON-RPC details: `Device.listAllDetail` + `Room.getAll` + `Subsection.getAll` → map address→{name, rooms, functions}. Merge into the graph.
4. Initial values: optional `getAllValues`/per-parameter `getValue` → populates the value cache (avoid a storm: during init keep the values anyway).
5. On a `newDevices` callback → same incremental pipeline; `deleteDevices`/`replaceDevice`/`readdedDevice` mutate the registry; `updateDevice` invalidates and reloads the device descriptions.

### Caching / store
- Persistent: device descriptions, paramset descriptions, device details (names/rooms/functions). Invalidation **by schema-version** (NOT by age): if the on-disk version ≠ `SCHEMA_VERSION`, discard BOTH caches (device+paramset) for consistency. File: `{slug(centralName)}_{name}.json` in a configurable data dir.
- Dynamic value cache (`CentralDataCache`): in-memory, age `MAX_CACHE_AGE=10s` (during init ignore the age). `get/add/clear/refresh`.
- Warm start: if the caches load and the version matches, rebuild the devices from cache and reload ONLY the values (no re-discovery of descriptions/paramset).
- Change detection: `contentHash` sha256 vs the last saved one → `saveIfChanged()`.

### Event bus
- `subscribe({ eventType, key?, handler, priority? }) → unsubscribe`; `publish(event)`, `publishBatch(events)`. Dispatch by event CLASS (discriminant `type`), not by topic string; a handler with `key` undefined = wildcard of the type; ordered by priority (CRITICAL>HIGH>NORMAL>LOW) then insertion order; executed concurrently with error isolation (a handler that throws does not block the others; error logged).
- Events (for Phase 2): `valueReceived` {dpk, value, receivedAt}, `deviceAdded` {device}, `deviceRemoved` {address}, `devicesCreated` {addresses}, `connectionStateChanged` {interfaceId, state, reason?}, `recoveryStageChanged` {interfaceId, stage}, `systemError` {interfaceId, code, message}, `ready`.

### Rock-solid reconnect (PRIMARY REQUIREMENT)
- **Loss detection:** (a) ping/pong tracker — `handleSendPing(token)` before the `ping(callerId="{interfaceId}#{token}")` call, `handleReceivedPong(token)` on return via callback; mismatch threshold `PING_PONG_MISMATCH_COUNT=15`, TTL 300s, unknown-pong retry after 15s. (b) callback liveness — compares monotonic now vs the last event received per interface; if `elapsed > callbackWarnInterval=180s` it reports a callback timeout. (c) periodic connection-check (scheduler 15s) + circuit breaker tripped.
- **Stage progression** (`RecoveryStage`): IDLE → COOLDOWN(30s) → TCP_CHECKING(open TCP, timeout 2s) → RPC_CHECKING(`system.listMethods`/json check) → WARMING_UP(delay) → STABILITY_CHECK(re-check RPC) → RECONNECTING(`client.reconnect()` = deinit+init, registers ping token) → DATA_LOADING(re-sync values+hub) → RECOVERED. Startup path (no client): TCP_CHECKING → RECONNECTING → DATA_LOADING → RECOVERED.
- **Backoff & limits:** `nextRetryDelay = min(5s * 2^(failures-1), 60s)` (5,10,20,40,60…); `MAX_RECOVERY_ATTEMPTS=8` then FAILED state + heartbeat loop every 60s; max **2 interfaces** in recovery at the same time (semaphore).
- **Pre-recovery:** `clearJsonRpcSession()` (avoids stale auth). **Re-init:** `client.reconnect()` resets the circuit breaker + error counters on success. **Re-sync:** reloads values (does NOT re-discover descriptions — they stay in cache) + hub data.
- **CCU restart:** TCP up but RPC down distinguishes a restart from a network loss; the callback registration is lost → `reconnect()` (deinit+init) re-establishes it. VirtualDevices quirk: `init` may time out but it is a success if a callback arrives.
- Emit `connectionStateChanged`/`recoveryStageChanged` on every transition so the facade (Phase 3) and the external app always know the real state.

### Scheduler (prod intervals)
connection-check 15s, periodic value refresh 15s, sysvar/program 30s, firmware-check 6h. During connection problems, suspend all jobs except the connection-check. Cache saving: via `saveIfChanged()`/`saveDelayed()` on mutation + at `stop()`.

---

## File structure (Phase 2)

```
src/support/constants.ts        # + Operations, Flag, ParameterType, ParamsetKey, RxMode, DeviceFirmwareState, ParameterStatus
src/support/dpk.ts              # DataPointKey + uniqueId() + makeDpk()
src/central/
  events.ts                     # event types (discriminated union) + CentralEvent
  event-bus.ts                  # typed EventBus (subscribe/publish/priority/error-isolation)
  store/
    storage-backend.ts          # interface StorageBackend (load/save/remove) + FileStorageBackend + InMemoryStorageBackend
    description-cache.ts         # DeviceDescriptionCache + ParamsetDescriptionCache (schema-version, contentHash, saveIfChanged)
    value-cache.ts              # dynamic value cache (MAX_CACHE_AGE=10s)
  device-registry.ts            # immutable registry (Map address→DeviceNode), lookup, immutable mutations
  graph.ts                      # DeviceNode/ChannelNode/ParameterSpec types (descriptions + meta merge)
  discovery.ts                  # buildFromInterface(client): listDevices→paramset→details merge→DeviceNode[]; warm-start from cache
  connection/
    ping-pong.ts                # PingPongTracker (mismatch threshold, TTL, unknown retry)
    connection-state.ts         # per-interface ConnectionStatus + issues
    recovery.ts                 # ConnectionRecovery: stage machine, backoff, semaphore, re-init, re-sync hook
    scheduler.ts                # Scheduler: periodic jobs with intervals, pause during issue
  central-unit.ts               # CentralUnit: start/stop, wiring callback→bus→value, discovery, recovery
tests/
  unit/central/...              # per module
  integration/central-*.test.ts # discovery + value routing + reconnect (fake CCU drop/restart)
```

---

## Tasks (TDD per module)

### Task 1: constants + dpk
- Add the enums above to `src/support/constants.ts` (do NOT break the existing exports). Create `src/support/dpk.ts`: `interface DataPointKey {interfaceId; channelAddress; paramsetKey; parameter}`, `makeDpk(...)`, `dpkToUniqueId(dpk): string` (= lowercased `interfaceId:channelAddress:paramsetKey:parameter`), `uniqueIdToDpk(s)` (tolerant inverse parsing).
- Test: gating helpers `isReadable(op)/isWritable(op)/hasEvents(op)`; `isVisible(flags)`; dpk round-trip.
- Commit: `feat(central): protocol enums + DataPointKey`.

### Task 2: event bus + event types
- `src/central/events.ts`: discriminated union `CentralEvent` with the listed members (`type` field). For each an optional `key?: string` (for `valueReceived` the key = dpk uniqueId; for device events the key = address; for connection events the key = interfaceId).
- `src/central/event-bus.ts`: `EventBus` with `subscribe<T extends CentralEvent['type']>({type, key?, handler, priority?}): () => void`, `publish(event)`, `publishBatch(events)`. Priority enum (CRITICAL=0,HIGH=1,NORMAL=2,LOW=3). Handlers ordered by priority+insertion; wildcard (no key) + key-specific both invoked; execution with `Promise.allSettled`, errors logged (injectable logger) and NOT rethrown. `subscriptionCount`, `clear()`.
- Test: subscribe by type receives the event; key-specific receives only its key + the wildcards; priority respected (invocation order recorded); a handler that throws does not prevent the others from running; unsubscribe works.
- Commit: `feat(central): typed event bus`.

### Task 3: storage + description caches + value cache
- `storage-backend.ts`: `interface StorageBackend { load(name): Promise<string|null>; save(name, content): Promise<void>; remove(name): Promise<void> }`. `FileStorageBackend(dir)` (uses `node:fs/promises`, creates dir, file `{slug(centralName)}_{name}.json`), `InMemoryStorageBackend` (Map, for tests).
- `description-cache.ts`: `DeviceDescriptionCache` and `ParamsetDescriptionCache`. Both: numeric `SCHEMA_VERSION`; `load()` returns `'loaded'|'empty'|'version-mismatch'|'fail'`; on mismatch/fail → empty. Paramset structure: `Map<interfaceId, Map<channelAddress, Map<paramsetKey, Record<parameter, ParameterData>>>>`. `add(...)`, getters, `removeDevice(address)` (also removes the `address:*` channels). `contentHash()` sha256 of the serialized content; `hasUnsavedChanges`; `saveIfChanged()`; `saveAll()`. Deterministic JSON serialization (ordered keys) for a stable hash.
- `value-cache.ts`: `ValueCache` with `add(dpk, value, at)`, `get(dpk): {value, at}|undefined`, `isStale(dpk, maxAgeMs=10000, now)`, `clear()`, `entries()`.
- Test: round-trip save/load with InMemoryStorageBackend; SCHEMA_VERSION change → version-mismatch → empty cache; `removeDevice` removes device+channels; `saveIfChanged` saves only if the hash changes; value cache staleness with an injected clock.
- Commit: `feat(central): persistent description caches + dynamic value cache`.

### Task 4: device registry + graph types
- `graph.ts`: `ParameterSpec` (from ParameterData: type, operations, flags, min, max, unit, valueList, default, special, + helpers `readable/writable/hasEvents/visible`), `ChannelNode {address, index, type, direction?, parameters: Map<parameter, {VALUES?: ParameterSpec; MASTER?: ParameterSpec}>}`, `DeviceNode {address, type, interfaceId, firmware?, name?, rooms?: string[], functions?: string[], channels: ChannelNode[], raw: DeviceDescription}`. Everything readonly/immutable.
- `device-registry.ts`: `DeviceRegistry` with immutable state (Map address→DeviceNode). `getAll()`, `get(address)`, `getChannel(channelAddress)`, `findByDpk(dpk)`/`resolveParameter(dpk)`; mutations that return a new instance or update an internal map in a controlled way (choose an approach consistent with the user immutability rules: prefer returning new state; for performance a private internal map with per-device copy-on-write is acceptable — document it).
- Test: add/get device; resolveParameter via dpk; removeDevice; channel lookup.
- Commit: `feat(central): device registry + graph model`.

### Task 5: discovery
- `discovery.ts`: `discoverInterface({client, jsonClient, sessionId?, deviceCache, paramsetCache}): Promise<DeviceNode[]>`:
  - `listDevices()` → separate devices/channels; for new devices save into deviceCache; for each channel fetch `getParamsetDescription(VALUES)` and (if present in PARAMSETS) `getParamsetDescription(MASTER)`, skip LINK; save into paramsetCache.
  - `fetchDetails(jsonClient)` → `Device.listAllDetail` + `Room.getAll` + `Subsection.getAll` → map address→{name, rooms, functions}; merge.
  - build `DeviceNode[]` from the graph. `warmStart(deviceCache, paramsetCache)` → rebuilds `DeviceNode[]` from cache without RPC.
  - Handle dedup and orphan channels defensively.
- Test (with the extended FakeCcu): discoverInterface on a canned set (1 device, 2 channels, VALUES parameters) → DeviceNode with channels+parameters+name from JSON-RPC; warmStart from a populated cache → same graph without RPC calls (verify the client is not called).
- Commit: `feat(central): device discovery (paramset + JSON-RPC details merge + warm start)`.

### Task 6: ping-pong + connection-state + recovery + scheduler
- `ping-pong.ts`: `PingPongTracker` with `handleSendPing(token)`, `handleReceivedPong(token)`, thresholds (mismatch 15, TTL 300s, unknown retry 15s, max size 100), `pendingCount`, `isMismatch()`. Injectable clock + timer.
- `connection-state.ts`: per-interface `ConnectionStateTracker`: `setState(interfaceId, status)`, issues add/remove, `lastEventAt(interfaceId)`, `isCallbackAlive(interfaceId, now, warnIntervalMs=180000)`.
- `recovery.ts`: `ConnectionRecovery` with the stage machine (RecoveryStage enum), `recover(interfaceId)` that runs COOLDOWN→TCP→RPC→WARMUP→STABILITY→RECONNECT→DATA_LOAD→RECOVERED with injectable hooks: `tcpCheck(host,port)`, `rpcCheck(client)`, `doReconnect(client)` (= deinit+init), `reloadData(interfaceId)`. Backoff `min(5000*2^(failures-1), 60000)`, `maxAttempts=8` → FAILED + heartbeat 60s, semaphore of 2 concurrent. All delays via an injectable `sleep`; emits `recoveryStageChanged` on the EventBus. Injectable timer/clock (tested with fake timers).
- `scheduler.ts`: `Scheduler` with registrable jobs `{name, intervalMs, run}`; `start()/stop()`; `pauseAllExcept(name)` / `resume()` (to suspend during an issue). Uses real timers but testable with fake timers.
- Test: ping/pong mismatch when pending exceeds the threshold; callback liveness false after the warn interval; recovery goes through the stages in order and calls the hooks; backoff computes the sequence 5/10/20/40/60; after 8 failures → FAILED + heartbeat; scheduler invokes the jobs at the interval (fake timers) and pause/resume works.
- Commit: `feat(central): ping-pong, connection-state, rock-solid recovery, scheduler`.

### Task 7: CentralUnit + integration
- `central-unit.ts`: `CentralUnit({centralName, interfaces: InterfaceConfig[], host, credentials, callback:{host,port}, cache:{dir,enabled}, storageBackend?, tls?})`:
  - `async start()`: load cache (warm start if version ok), create one `InterfaceClient` per interface + `JsonRpcClient`/`SessionManager`, start `CallbackServer` (host/port), for each client `initProxy()`, run discovery (or warm start + value refresh), populate registry+value cache, register the scheduler jobs, emit `ready`.
  - Callback wiring: `CallbackServer.onEvent` → normalize → for `event` route into the value cache + `publish(valueReceived)`, handle `newDevices`/`deleteDevices`/`updateDevice`/`replaceDevice` by updating registry+cache, `error`→`systemError`. The `pong` (event with parameter PONG) → `pingPong.handleReceivedPong`.
  - Health/recovery: scheduler connection-check 15s → ping per interface + callback-liveness; on loss → `ConnectionRecovery.recover(interfaceId)`; on recover → value re-sync (refresh) and `connectionStateChanged`.
  - `async stop()`: save cache, stop scheduler+recovery, `deinitProxy()` for each client, JSON-RPC logout, stop CallbackServer.
  - Exposes (for Phase 3): `registry`, `eventBus`, `getValue(dpk)`, `setValue(dpk, value)` (delegates to InterfaceClient.setValue/putParamset), `devices()`.
- Integration test (extended FakeCcu): 
  1. `start()` → discovery builds the registry (devices+channels), `ready` emitted, value cache populated.
  2. FakeCcu emits `event` → `valueReceived` published + value cache updated.
  3. `setValue(dpk, v)` → reaches FakeCcu.
  4. **Reconnect:** FakeCcu "drops" (close/RPC down) → connection-check detects the loss → recovery goes through the stages → FakeCcu "restarts" → re-init (callback re-registration) → value re-sync; `connectionStateChanged` reflects CONNECTED→…→CONNECTED. Verify that after the restart a new `event` still arrives (callback re-registered).
  5. `stop()` → cache saved, deinit called.
- Commit: `feat(central): CentralUnit lifecycle + integration (discovery, value routing, reconnect)`.

## Phase 2 final gate
`npm run lint && npm run format:check && npm run typecheck && npm run test:cov && npm run build` green, coverage ≥ 80%. (Real e2e optional at the end of the phase, gated by HM_E2E.)

## Known follow-up (post real e2e 2026-06-04)
- **Rooms/functions:** on a real RaspberryMatic `Room.getAll`/`Subsection.getAll` return empty `channelIds: []` → the channel→room mapping is NOT exposed via these JSON-RPC methods. aiohomematic retrieves rooms/functions via **ReGa scripts** (`ReGa.runScript`). The device/channel NAMES (`Device.listAllDetail`) work (41/41 devices named in the e2e). TODO Phase 3: implement the rooms/functions fetch via ReGa scripts. The channelId→address join in `mergeDetails` remains as correct defensive logic for CCUs that populate channelIds.

## Self-review
- Spec §4 central coverage: event bus (T2), persistent+value cache (T3), registry+graph (T4), discovery+warm start (T5), rock-solid reconnect+scheduler+ping/pong (T6), CentralUnit lifecycle+wiring+integration reconnect (T7), enums/dpk (T1). ✅
- The "rock-solid reconnect" requirement has a dedicated integration test (FakeCcu drop/restart) in addition to the stage-machine unit tests. ✅
- Boundary: no DataPoint class / public facade here (Phase 3). The graph is typed raw data; value routing uses dpk. ✅
