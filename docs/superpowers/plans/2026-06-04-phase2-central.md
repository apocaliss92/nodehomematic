# nodehomematic — Fase 2: Central Implementation Plan

> **For agentic workers:** TDD module-by-module (RED→GREEN→commit). Builds on the Phase 1 transport (already merged to main). The central orchestrates transport + produces the device graph + drives rock-solid reconnection. Validated with a fake CCU; reconnect scenarios tested by making the fake CCU drop/restart.

**Goal:** Orchestrazione central: event bus tipizzato, cache persistente delle descrizioni (device+paramset, invalidazione per schema-version) + value cache dinamica, device registry immutabile, discovery (listDevices→paramset→merge nomi/stanze JSON-RPC→grafo Device/Channel/DataPointSpec→valori iniziali), e reconnect **rock-solid** (ping/pong + callback liveness + connection-check + stage progression + backoff + re-init + reset breaker + re-sync valori). Tutto sotto `src/central/`, più aggiunte a `src/support/`.

**Architecture:** `CentralUnit` è la facciata interna. Usa N `InterfaceClient` (Fase 1) + un `CallbackServer` condiviso. Gli eventi grezzi del callback server vengono normalizzati e instradati sull'`EventBus` interno tipizzato; i valori confluiscono nella value cache e generano eventi `valueReceived`. La discovery costruisce un grafo immutabile di device/canali/parametri. La `ConnectionRecovery` rende la riconnessione robusta. Niente logica di dominio model/facade (quella è Fase 3): il grafo qui è dati grezzi tipizzati (descrizioni + valori).

**Tech Stack:** TypeScript strict, Node 20+. Storage: file JSON via `node:fs/promises` dietro un'astrazione `StorageBackend` iniettabile (così i test usano uno store in-memory). Test: vitest + il `FakeCcu` esteso (da Fase 1).

---

## Facts (dal sorgente aiohomematic `devel`) — sintesi autorevole

### Enums (const.py) da aggiungere a `src/support/constants.ts`
- `Operations` (bitmask): NONE=0, READ=1, WRITE=2, EVENT=4. Gating: readable=`op&READ`, writable=`op&WRITE`, hasEvents=`op&EVENT`.
- `Flag` (bitmask): VISIBLE=1, INTERNAL=2, TRANSFORM=4, SERVICE=8, STICKY=0x10. visible=`flags&VISIBLE`, service=`flags&SERVICE`.
- `ParameterType` (string): ACTION, BOOL, ENUM, FLOAT, INTEGER, STRING, DUMMY, EMPTY="".
- `ParamsetKey` (string): MASTER, VALUES, LINK, SERVICE, CALCULATED, COMBINED, DUMMY. (Discovery fetcha VALUES+MASTER, salta LINK.)
- `RxMode` (bitmask): UNDEFINED=0, ALWAYS=1, BURST=2, CONFIG=4, WAKEUP=8, LAZY_CONFIG=16.
- `DeviceFirmwareState` (string enum) — i valori del report (UNKNOWN, UP_TO_DATE, NEW_FIRMWARE_AVAILABLE, READY_FOR_UPDATE, PERFORMING_UPDATE, …).
- `ParameterStatus`: NORMAL, UNKNOWN, OVERFLOW, UNDERFLOW, ERROR, INVALID, UNUSED, EXTERNAL.

### DeviceDescription (campi uppercase, già parzialmente in `xmlrpc/types.ts` — estendere)
Required: `TYPE, ADDRESS, PARAMSETS: string[], CHILDREN: string[]`. Opt: `PARENT, PARENT_TYPE, SUBTYPE, INTERFACE, INDEX, VERSION, FLAGS, DIRECTION, FIRMWARE, AVAILABLE_FIRMWARE, FIRMWARE_UPDATE_STATE, FIRMWARE_UPDATABLE, RX_MODE, AES_ACTIVE, ROAMING, GROUP, TEAM, TEAM_CHANNELS, RF_ADDRESS`. Un device ha PARENT vuoto/assente; un canale ha `ADDRESS="DEV:idx"` e `PARENT=devAddress`.

### ParameterData (per parametro VALUES/MASTER)
`TYPE` (FLOAT|INTEGER|BOOL|ENUM|STRING|ACTION|DUMMY), `OPERATIONS:int`, `FLAGS:int`, `DEFAULT, MIN, MAX, UNIT?, VALUE_LIST?:string[], SPECIAL?, ID?, CONTROL?, TAB_ORDER?`.

### DataPointKey (dpk) — identità di un punto-valore
`{ interfaceId, channelAddress, paramsetKey, parameter }`. `unique_id` stringa derivata = `${interfaceId}:${channelAddress}:${paramsetKey}:${parameter}` (minuscola/normalizzata). Usato per instradare gli `event(...)` ai data point.

### Discovery sequence
1. `client.listDevices()` → entries (device+canali). Dedup per address (device) o parent (canale).
2. Per ogni device NUOVO: salva descrizioni in cache, poi per ogni canale itera `PARAMSETS` e fa `getParamsetDescription(channelAddress, key)` per VALUES e MASTER (SKIP LINK).
3. JSON-RPC details: `Device.listAllDetail` + `Room.getAll` + `Subsection.getAll` → mappa address→{name, rooms, functions}. Merge nel grafo.
4. Valori iniziali: opzionale `getAllValues`/per-parametro `getValue` → popola la value cache (evita storm: durante init tieni i valori comunque).
5. Su `newDevices` callback → stessa pipeline incrementale; `deleteDevices`/`replaceDevice`/`readdedDevice` mutano il registry; `updateDevice` invalida e ricarica le descrizioni del device.

### Caching / store
- Persistenti: device descriptions, paramset descriptions, device details (nomi/stanze/funzioni). Invalidazione **per schema-version** (NON per età): se la versione su disco ≠ `SCHEMA_VERSION`, scarta ENTRAMBE le cache (device+paramset) per coerenza. File: `{slug(centralName)}_{name}.json` in una dir dati configurabile.
- Value cache dinamica (`CentralDataCache`): in-memory, età `MAX_CACHE_AGE=10s` (durante init ignora l'età). `get/add/clear/refresh`.
- Warm start: se le cache caricano e la versione combacia, ricostruisci i device dalla cache e ricarica SOLO i valori (niente re-discovery di descrizioni/paramset).
- Change detection: `contentHash` sha256 vs ultimo salvato → `saveIfChanged()`.

### Event bus
- `subscribe({ eventType, key?, handler, priority? }) → unsubscribe`; `publish(event)`, `publishBatch(events)`. Dispatch per CLASSE di evento (discriminant `type`), non per topic string; handler con `key` undefined = wildcard del tipo; ordinati per priorità (CRITICAL>HIGH>NORMAL>LOW) poi insertion order; eseguiti concorrenti con isolamento errori (un handler che lancia non blocca gli altri; errore loggato).
- Eventi (per Fase 2): `valueReceived` {dpk, value, receivedAt}, `deviceAdded` {device}, `deviceRemoved` {address}, `devicesCreated` {addresses}, `connectionStateChanged` {interfaceId, state, reason?}, `recoveryStageChanged` {interfaceId, stage}, `systemError` {interfaceId, code, message}, `ready`.

### Reconnect rock-solid (REQUISITO PRIMARIO)
- **Loss detection:** (a) ping/pong tracker — `handleSendPing(token)` prima della call `ping(callerId="{interfaceId}#{token}")`, `handleReceivedPong(token)` al ritorno via callback; soglia mismatch `PING_PONG_MISMATCH_COUNT=15`, TTL 300s, retry unknown-pong dopo 15s. (b) callback liveness — confronta monotonic now vs ultimo evento ricevuto per interfaccia; se `elapsed > callbackWarnInterval=180s` segnala callback timeout. (c) connection-check periodico (scheduler 15s) + circuit breaker tripped.
- **Stage progression** (`RecoveryStage`): IDLE → COOLDOWN(30s) → TCP_CHECKING(open TCP, timeout 2s) → RPC_CHECKING(`system.listMethods`/json check) → WARMING_UP(delay) → STABILITY_CHECK(re-check RPC) → RECONNECTING(`client.reconnect()` = deinit+init, registra ping token) → DATA_LOADING(re-sync valori+hub) → RECOVERED. Startup path (nessun client): TCP_CHECKING → RECONNECTING → DATA_LOADING → RECOVERED.
- **Backoff & limiti:** `nextRetryDelay = min(5s * 2^(failures-1), 60s)` (5,10,20,40,60…); `MAX_RECOVERY_ATTEMPTS=8` poi stato FAILED + heartbeat loop ogni 60s; max **2 interfacce** in recovery contemporanea (semaforo).
- **Pre-recovery:** `clearJsonRpcSession()` (evita auth stantia). **Re-init:** `client.reconnect()` resetta circuit breaker + contatori errori su successo. **Re-sync:** ricarica valori (NON ri-scopre descrizioni — restano in cache) + dati hub.
- **CCU restart:** TCP up ma RPC down distingue restart da perdita rete; la registrazione callback è persa → `reconnect()` (deinit+init) la ristabilisce. Quirk VirtualDevices: `init` può andare in timeout ma è successo se arriva un callback.
- Emetti `connectionStateChanged`/`recoveryStageChanged` ad ogni transizione così la facade (Fase 3) e l'app esterna sanno sempre lo stato reale.

### Scheduler (intervalli prod)
connection-check 15s, periodic value refresh 15s, sysvar/program 30s, firmware-check 6h. Durante problemi di connessione, sospendi tutti i job tranne il connection-check. Salvataggio cache: via `saveIfChanged()`/`saveDelayed()` su mutazione + a `stop()`.

---

## File structure (Fase 2)

```
src/support/constants.ts        # + Operations, Flag, ParameterType, ParamsetKey, RxMode, DeviceFirmwareState, ParameterStatus
src/support/dpk.ts              # DataPointKey + uniqueId() + makeDpk()
src/central/
  events.ts                     # tipi evento (discriminated union) + CentralEvent
  event-bus.ts                  # EventBus tipizzato (subscribe/publish/priority/error-isolation)
  store/
    storage-backend.ts          # interface StorageBackend (load/save/remove) + FileStorageBackend + InMemoryStorageBackend
    description-cache.ts         # DeviceDescriptionCache + ParamsetDescriptionCache (schema-version, contentHash, saveIfChanged)
    value-cache.ts              # value cache dinamica (MAX_CACHE_AGE=10s)
  device-registry.ts            # registry immutabile (Map address→DeviceNode), lookup, mutazioni immutabili
  graph.ts                      # tipi DeviceNode/ChannelNode/ParameterSpec (descrizioni + meta merge)
  discovery.ts                  # buildFromInterface(client): listDevices→paramset→details merge→DeviceNode[]; warm-start from cache
  connection/
    ping-pong.ts                # PingPongTracker (mismatch threshold, TTL, unknown retry)
    connection-state.ts         # per-interface ConnectionStatus + issues
    recovery.ts                 # ConnectionRecovery: stage machine, backoff, semaforo, re-init, re-sync hook
    scheduler.ts                # Scheduler: job periodici con intervalli, pausa durante issue
  central-unit.ts               # CentralUnit: start/stop, wiring callback→bus→value, discovery, recovery
tests/
  unit/central/...              # per modulo
  integration/central-*.test.ts # discovery + value routing + reconnect (fake CCU drop/restart)
```

---

## Tasks (TDD per modulo)

### Task 1: constants + dpk
- Aggiungi gli enum sopra a `src/support/constants.ts` (NON rompere gli export esistenti). Crea `src/support/dpk.ts`: `interface DataPointKey {interfaceId; channelAddress; paramsetKey; parameter}`, `makeDpk(...)`, `dpkToUniqueId(dpk): string` (= lowercased `interfaceId:channelAddress:paramsetKey:parameter`), `uniqueIdToDpk(s)` (parsing inverso tollerante).
- Test: gating helpers `isReadable(op)/isWritable(op)/hasEvents(op)`; `isVisible(flags)`; dpk round-trip.
- Commit: `feat(central): protocol enums + DataPointKey`.

### Task 2: event bus + event types
- `src/central/events.ts`: discriminated union `CentralEvent` con i membri elencati (campo `type`). Per ognuno una `key?: string` opzionale (per `valueReceived` la key = dpk uniqueId; per device events la key = address; per connection events la key = interfaceId).
- `src/central/event-bus.ts`: `EventBus` con `subscribe<T extends CentralEvent['type']>({type, key?, handler, priority?}): () => void`, `publish(event)`, `publishBatch(events)`. Priorità enum (CRITICAL=0,HIGH=1,NORMAL=2,LOW=3). Handler ordinati per priorità+insertion; wildcard (key assente) + key-specific entrambi invocati; esecuzione con `Promise.allSettled`, errori loggati (logger iniettabile) e NON ri-lanciati. `subscriptionCount`, `clear()`.
- Test: subscribe per tipo riceve l'evento; key-specific riceve solo la sua key + i wildcard; priorità rispettata (ordine di invocazione registrato); un handler che lancia non impedisce agli altri di girare; unsubscribe funziona.
- Commit: `feat(central): typed event bus`.

### Task 3: storage + description caches + value cache
- `storage-backend.ts`: `interface StorageBackend { load(name): Promise<string|null>; save(name, content): Promise<void>; remove(name): Promise<void> }`. `FileStorageBackend(dir)` (usa `node:fs/promises`, crea dir, file `{slug(centralName)}_{name}.json`), `InMemoryStorageBackend` (Map, per test).
- `description-cache.ts`: `DeviceDescriptionCache` e `ParamsetDescriptionCache`. Entrambe: `SCHEMA_VERSION` numerico; `load()` ritorna `'loaded'|'empty'|'version-mismatch'|'fail'`; su mismatch/fail → vuota. Struttura paramset: `Map<interfaceId, Map<channelAddress, Map<paramsetKey, Record<parameter, ParameterData>>>>`. `add(...)`, getters, `removeDevice(address)` (rimuove anche i canali `address:*`). `contentHash()` sha256 del contenuto serializzato; `hasUnsavedChanges`; `saveIfChanged()`; `saveAll()`. Serializzazione JSON deterministica (chiavi ordinate) per hash stabile.
- `value-cache.ts`: `ValueCache` con `add(dpk, value, at)`, `get(dpk): {value, at}|undefined`, `isStale(dpk, maxAgeMs=10000, now)`, `clear()`, `entries()`.
- Test: round-trip save/load con InMemoryStorageBackend; cambio SCHEMA_VERSION → version-mismatch → cache vuota; `removeDevice` toglie device+canali; `saveIfChanged` salva solo se l'hash cambia; value cache staleness con clock iniettato.
- Commit: `feat(central): persistent description caches + dynamic value cache`.

### Task 4: device registry + graph types
- `graph.ts`: `ParameterSpec` (da ParameterData: type, operations, flags, min, max, unit, valueList, default, special, + helper `readable/writable/hasEvents/visible`), `ChannelNode {address, index, type, direction?, parameters: Map<parameter, {VALUES?: ParameterSpec; MASTER?: ParameterSpec}>}`, `DeviceNode {address, type, interfaceId, firmware?, name?, rooms?: string[], functions?: string[], channels: ChannelNode[], raw: DeviceDescription}`. Tutto readonly/immutabile.
- `device-registry.ts`: `DeviceRegistry` con stato immutabile (Map address→DeviceNode). `getAll()`, `get(address)`, `getChannel(channelAddress)`, `findByDpk(dpk)`/`resolveParameter(dpk)`; mutazioni che ritornano nuova istanza o aggiornano una mappa interna in modo controllato (scegli un approccio coerente con le regole utente sull'immutabilità: preferire ritorno di nuovo stato; per performance una mappa interna privata con copy-on-write per device è accettabile — documenta).
- Test: add/get device; resolveParameter via dpk; removeDevice; lookup canale.
- Commit: `feat(central): device registry + graph model`.

### Task 5: discovery
- `discovery.ts`: `discoverInterface({client, jsonClient, sessionId?, deviceCache, paramsetCache}): Promise<DeviceNode[]>`:
  - `listDevices()` → separa device/canali; per device nuovi salva in deviceCache; per ogni canale fetch `getParamsetDescription(VALUES)` e (se presente in PARAMSETS) `getParamsetDescription(MASTER)`, salta LINK; salva in paramsetCache.
  - `fetchDetails(jsonClient)` → `Device.listAllDetail` + `Room.getAll` + `Subsection.getAll` → mappa address→{name, rooms, functions}; merge.
  - costruisci `DeviceNode[]` dal grafo. `warmStart(deviceCache, paramsetCache)` → ricostruisce `DeviceNode[]` dalla cache senza RPC.
  - Gestisci la dedup e i canali orfani in modo difensivo.
- Test (con FakeCcu esteso): discoverInterface su un set canned (1 device, 2 canali, parametri VALUES) → DeviceNode con canali+parametri+nome dal JSON-RPC; warmStart da cache popolata → stesso grafo senza chiamate RPC (verifica che il client non venga chiamato).
- Commit: `feat(central): device discovery (paramset + JSON-RPC details merge + warm start)`.

### Task 6: ping-pong + connection-state + recovery + scheduler
- `ping-pong.ts`: `PingPongTracker` con `handleSendPing(token)`, `handleReceivedPong(token)`, soglie (mismatch 15, TTL 300s, unknown retry 15s, max size 100), `pendingCount`, `isMismatch()`. Clock + timer iniettabili.
- `connection-state.ts`: `ConnectionStateTracker` per-interfaccia: `setState(interfaceId, status)`, issues add/remove, `lastEventAt(interfaceId)`, `isCallbackAlive(interfaceId, now, warnIntervalMs=180000)`.
- `recovery.ts`: `ConnectionRecovery` con la stage machine (RecoveryStage enum), `recover(interfaceId)` che esegue COOLDOWN→TCP→RPC→WARMUP→STABILITY→RECONNECT→DATA_LOAD→RECOVERED con hook iniettabili: `tcpCheck(host,port)`, `rpcCheck(client)`, `doReconnect(client)` (= deinit+init), `reloadData(interfaceId)`. Backoff `min(5000*2^(failures-1), 60000)`, `maxAttempts=8` → FAILED + heartbeat 60s, semaforo 2 concorrenti. Tutti i delay via `sleep` iniettabile; emette `recoveryStageChanged` sull'EventBus. Timer/clock iniettabili (test con fake timers).
- `scheduler.ts`: `Scheduler` con job registrabili `{name, intervalMs, run}`; `start()/stop()`; `pauseAllExcept(name)` / `resume()` (per sospendere durante issue). Usa timer reali ma testabile con fake timers.
- Test: ping/pong mismatch quando pending supera soglia; callback liveness false dopo warn interval; recovery percorre gli stage in ordine e chiama gli hook; backoff calcola la sequenza 5/10/20/40/60; dopo 8 fallimenti → FAILED + heartbeat; scheduler invoca i job all'intervallo (fake timers) e pause/resume funziona.
- Commit: `feat(central): ping-pong, connection-state, rock-solid recovery, scheduler`.

### Task 7: CentralUnit + integration
- `central-unit.ts`: `CentralUnit({centralName, interfaces: InterfaceConfig[], host, credentials, callback:{host,port}, cache:{dir,enabled}, storageBackend?, tls?})`:
  - `async start()`: carica cache (warm start se versione ok), crea un `InterfaceClient` per interfaccia + `JsonRpcClient`/`SessionManager`, avvia `CallbackServer` (host/port), per ogni client `initProxy()`, esegui discovery (o warm start + refresh valori), popola registry+value cache, registra i job dello scheduler, emetti `ready`.
  - Wiring callback: `CallbackServer.onEvent` → normalizza → per `event` instrada in value cache + `publish(valueReceived)`, gestisce `newDevices`/`deleteDevices`/`updateDevice`/`replaceDevice` aggiornando registry+cache, `error`→`systemError`. I `pong` (event con parameter PONG) → `pingPong.handleReceivedPong`.
  - Health/recovery: scheduler connection-check 15s → ping per interfaccia + callback-liveness; su perdita → `ConnectionRecovery.recover(interfaceId)`; su recover → re-sync valori (refresh) e `connectionStateChanged`.
  - `async stop()`: salva cache, ferma scheduler+recovery, `deinitProxy()` per ogni client, logout JSON-RPC, stop CallbackServer.
  - Espone (per Fase 3): `registry`, `eventBus`, `getValue(dpk)`, `setValue(dpk, value)` (delega a InterfaceClient.setValue/putParamset), `devices()`.
- Integration test (FakeCcu esteso): 
  1. `start()` → discovery costruisce il registry (device+canali), `ready` emesso, value cache popolata.
  2. FakeCcu emette `event` → `valueReceived` pubblicato + value cache aggiornata.
  3. `setValue(dpk, v)` → raggiunge FakeCcu.
  4. **Reconnect:** FakeCcu "cade" (chiudi/RPC down) → connection-check rileva perdita → recovery percorre gli stage → FakeCcu "riparte" → re-init (re-registrazione callback) → re-sync valori; `connectionStateChanged` riflette CONNECTED→…→CONNECTED. Verifica che dopo il restart un nuovo `event` arrivi ancora (callback ri-registrato).
  5. `stop()` → cache salvata, deinit chiamato.
- Commit: `feat(central): CentralUnit lifecycle + integration (discovery, value routing, reconnect)`.

## Gate finale Fase 2
`npm run lint && npm run format:check && npm run typecheck && npm run test:cov && npm run build` verde, coverage ≥ 80%. (e2e reale opzionale a fine fase, gated HM_E2E.)

## Follow-up noto (post-e2e reale 2026-06-04)
- **Stanze/funzioni:** su RaspberryMatic reale `Room.getAll`/`Subsection.getAll` restituiscono `channelIds: []` vuoti → la mappatura canale→stanza NON è esposta via questi metodi JSON-RPC. aiohomematic recupera stanze/funzioni via **script ReGa** (`ReGa.runScript`). I NOMI device/canale (`Device.listAllDetail`) funzionano (41/41 device nominati nell'e2e). TODO Fase 3: implementare il fetch stanze/funzioni via script ReGa. Il join channelId→address in `mergeDetails` resta come logica difensiva corretta per CCU che popolano channelIds.

## Self-review
- Copertura spec §4 central: event bus (T2), cache persistente+value (T3), registry+graph (T4), discovery+warm start (T5), reconnect rock-solid+scheduler+ping/pong (T6), CentralUnit lifecycle+wiring+integration reconnect (T7), enums/dpk (T1). ✅
- Il requisito "reconnect rock-solid" ha test di integrazione dedicato (FakeCcu drop/restart) oltre agli unit della stage machine. ✅
- Confine: nessun DataPoint class / facade pubblica qui (Fase 3). Il grafo è dati grezzi tipizzati; il routing valori usa dpk. ✅
