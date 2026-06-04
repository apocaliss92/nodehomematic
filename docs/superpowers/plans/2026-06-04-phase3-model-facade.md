# nodehomematic — Fase 3: Model generico + Facade pubblica

> **For agentic workers:** TDD module-by-module. Builds on Phase 1 (transport) + Phase 2 (central), both merged to main. This phase delivers the FIRST usable npm release: a public `Homematic` facade with a global `valueChanged` stream + `setValue`, on top of a generic data-point model.

**Goal:** Model generico (GenericDataPoint con conversione/validazione CCU↔JS) + viste pubbliche Device/Channel/DataPoint + facade `Homematic` event-driven (stream globale `valueChanged`, `setValue`, eventi lifecycle). Pubblicabile come npm `0.x`.

**Architecture:** Il model si abbona all'`EventBus` del `CentralUnit` (Fase 2): ogni `valueReceived` aggiorna il `GenericDataPoint` corrispondente (via dpk) e produce un cambio di stato. La facade `Homematic` wrappa il `CentralUnit`, espone una superficie pulita e agnostica (nessun tipo CCU/XML-RPC trapela) e ri-emette un EventEmitter tipizzato. Le scritture passano da `setValue` con validazione contro i metadati del data point, poi delegano a `CentralUnit.setValue` → `InterfaceClient`.

**Tech Stack:** TypeScript strict, Node 20+. EventEmitter tipizzato (custom, no dep). Validazione conversione interna (no zod necessario qui; i metadati guidano la validazione). Test: vitest + i fake/fake-CCU esistenti; e2e reale opzionale a fine fase.

---

## Facts conversione/validazione (da aiohomematic)
- `ParameterType`: ACTION, BOOL, ENUM, FLOAT, INTEGER, STRING.
- **Inbound CCU→JS:** empty string `""` → `null` per tipi numerici; BOOL può avere VALUE_LIST (index↔string); cleanup unità; moltiplicatore per certe unità (rinviabile). FLOAT/INTEGER → number; BOOL → boolean; ENUM → indice numerico (la CCU manda l'indice) che possiamo esporre come stringa via VALUE_LIST; STRING → string.
- **Outbound JS→CCU:** ENUM serializzato come **indice intero per HM, stringa per HmIP** (decidere in base al tipo di MIN: se MIN numerico → indice). Per il primo rilascio: accetta sia indice che stringa-da-VALUE_LIST; converti in indice se la famiglia è HM-style (MIN numerico/valueList presente), altrimenti passa la stringa. Documenta l'euristica.
- **Validazione write:** writable richiede `OPERATIONS & WRITE`; range MIN/MAX per numerici; ENUM deve essere in VALUE_LIST (o indice valido); BOOL coercibile; ACTION è trigger write-only (valore tipicamente `true`). Errori → `ValidationError`.
- `available`: il data point è disponibile se il device è online (per ora: sempre true salvo stato connessione interfaccia DISCONNECTED → false). `isValid`: ha un valore confermato + tipo/range validi.

---

## File structure (Fase 3)
```
src/model/
  converter.ts        # convertFromCcu(spec, raw) / convertToCcu(spec, value, interfaceFamily) + validate
  data-point.ts       # GenericDataPoint: dpk, spec, value corrente, write/eventUpdate, readable/writable/hasEvents, subscribe
  device.ts           # ModelDevice: address, type, name, rooms?, channels: ModelChannel[]
  channel.ts          # ModelChannel: address, index, dataPoints: GenericDataPoint[]
  model-builder.ts    # costruisce ModelDevice[] da DeviceNode[] (graph Fase 2) creando i GenericDataPoint (uno per parametro VALUES con EVENT/READ)
src/api/
  emitter.ts          # TypedEventEmitter<EventMap> minimale (on/off/once/emit)
  events.ts           # HomematicEventMap: valueChanged, deviceAdded, deviceRemoved, connection, ready, error
  types.ts            # tipi pubblici: HmDevice, HmChannel, HmDataPoint, HmValue, DataPointId, payload eventi
  homematic.ts        # class Homematic: facade su CentralUnit
src/index.ts          # export pubblico: Homematic + tipi pubblici (NO transport/central interni)
tests/unit/model/...  tests/unit/api/...  tests/integration/facade-*.test.ts
```

---

## Tasks (TDD)

### Task 1: converter
- `src/model/converter.ts`:
  - `convertFromCcu(spec: ParameterSpec, raw: unknown): HmValue` — FLOAT/INTEGER: number; `""`→null; BOOL→boolean (e se VALUE_LIST presente, normalizza); ENUM→ se VALUE_LIST presente e raw è indice numerico → mappa a stringa del VALUE_LIST (mantieni anche l'indice accessibile? per ora esponi la stringa); STRING→string; ACTION→boolean/none.
  - `convertToCcu(spec, value, opts:{enumAsIndex:boolean}): unknown` — numerici: valida range MIN/MAX → number; BOOL→boolean; ENUM: se `enumAsIndex` converti stringa→indice via VALUE_LIST (o accetta indice), altrimenti passa la stringa; STRING→string; ACTION→true. Throw `ValidationError` su valore non valido (fuori range, enum sconosciuto, tipo incompatibile).
  - `validateWritable(spec)` → throw `UnsupportedError` se non writable.
  - `HmValue = boolean | number | string | null`.
- Test: range out-of-bounds → ValidationError; enum string↔index round-trip; empty string→null per FLOAT; BOOL coercion; ACTION→true; write su spec non-writable → UnsupportedError.
- Commit: `feat(model): value converter + validation (CCU↔JS)`.

### Task 2: GenericDataPoint
- `src/model/data-point.ts`: `GenericDataPoint`:
  - costruito da `{ dpk, spec, interfaceFamily }`. Getter: `id` (=dpkToUniqueId), `parameter`, `type`, `readable/writable/hasEvents/visible`, `unit`, `valueList`, `min/max`.
  - stato: `value: HmValue` (corrente, default null), `lastUpdatedAt?: number`.
  - `applyCcuValue(raw, at)`: converte via converter e aggiorna `value` + timestamp; ritorna `{changed, prev, next}`.
  - `prepareWrite(value): unknown`: valida writable + converte a CCU (enumAsIndex deciso da interfaceFamily/spec).
  - `subscribe(cb: (next, prev) => void): () => void` (notifica locale; la facade userà l'event bus globale, ma il DP può notificare).
- Test: applyCcuValue aggiorna e segnala changed/prev/next; prepareWrite valida e converte; hasEvents/readable/writable da spec.
- Commit: `feat(model): GenericDataPoint`.

### Task 3: device/channel + model-builder
- `device.ts`/`channel.ts`: `ModelDevice {address, type, interfaceId, name?, rooms?, channels: ModelChannel[]; dataPoint(channelAddress, parameter)}`, `ModelChannel {address, index, type?, dataPoints: GenericDataPoint[]}`. Immutabili dopo costruzione (i DP hanno stato interno ma la struttura è fissa).
- `model-builder.ts`: `buildModel(devices: DeviceNode[], interfaceFamilyOf): ModelDevice[]` — per ogni DeviceNode crea ModelChannel per canale e un `GenericDataPoint` per ogni parametro VALUES che è readable o hasEvents (salta parametri puramente interni/SERVICE se vuoi, ma per il primo rilascio includi tutti i VALUES). `interfaceFamilyOf(interfaceId)` → 'HM' | 'HMIP' (euristica: contiene 'HmIP' → HMIP).
- Test: buildModel da un DeviceNode canned → ModelDevice con canali e DP corretti; lookup dataPoint(channel,param).
- Commit: `feat(model): device/channel views + model builder`.

### Task 4: typed emitter + public events/types
- `api/emitter.ts`: `TypedEventEmitter<TMap extends Record<string, unknown>>` con `on/off/once/emit` type-safe (wrappa `node:events` o implementazione propria). 
- `api/events.ts`: `HomematicEventMap`:
  - `valueChanged: { dpId: string; device: string; channel: string; parameter: string; value: HmValue; prevValue: HmValue; ts: number }`
  - `deviceAdded: { device: string }`, `deviceRemoved: { device: string }`
  - `connection: { interfaceId: string; state: string }`
  - `ready: void`, `error: Error`
- `api/types.ts`: `HmDevice {address, type, name?, rooms?, channels: HmChannel[]}`, `HmChannel {address, index, dataPoints: HmDataPoint[]}`, `HmDataPoint {id, parameter, type, value, unit?, readable, writable, hasEvents, valueList?, min?, max?}`, `DataPointId = string`, `DataPointRef = string | { device: string; channel: number|string; parameter: string }`.
- Test: emitter on/off/once/emit type-safe; once fires una sola volta.
- Commit: `feat(api): typed event emitter + public types`.

### Task 5: Homematic facade
- `api/homematic.ts`: `class Homematic`:
  - constructor `{ host, interfaces: ('HmIP-RF'|'BidCos-RF'|...)[], credentials?, callback:{host,port}, cache?:{dir?,enabled?}, tls?, centralName? }` → costruisce internamente un `CentralUnit` (mappa le stringhe interfaccia a `Interface`).
  - estende/contiene un `TypedEventEmitter<HomematicEventMap>` (esporre `on/off/once`).
  - `async start()`: `central.start()`; costruisci il model da `central.registry`; **sottoscrivi** `central.eventBus`:
    - `valueReceived` → trova il GenericDataPoint via dpk, `applyCcuValue`, se changed emetti `valueChanged` (con prev/next, device/channel/parameter estratti dal dpk).
    - `deviceAdded`/`deviceRemoved` → aggiorna il model + emetti gli eventi pubblici.
    - `connectionStateChanged` → emetti `connection`.
    - `ready` → emetti `ready`.
    - `systemError` → emetti `error`.
  - `async stop()`: `central.stop()`.
  - `devices(): HmDevice[]` (snapshot pubblico immutabile dal model).
  - `getValue(ref: DataPointRef): HmValue` (dal model/value cache).
  - `async setValue(ref: DataPointRef, value: HmValue): Promise<void>`: risolvi il GenericDataPoint, `prepareWrite(value)` (valida+converte), poi `central.setValue(dpk, ccuValue)`.
  - Risoluzione `DataPointRef`: stringa = dpId (uniqueId) → dpk; oggetto {device, channel, parameter} → costruisci channelAddress `device:channel` e dpk VALUES.
  - Niente tipi interni esposti nelle firme pubbliche.
- `src/index.ts`: esporta `Homematic`, `HmDevice`, `HmChannel`, `HmDataPoint`, `HmValue`, `DataPointRef`, i payload eventi. NON esporta transport/central.
- Test (unit con un CentralUnit mockato/fake che espone eventBus+registry+setValue): start costruisce il model e sottoscrive; un `valueReceived` pubblicato sul bus → la facade emette `valueChanged` con prev/next corretti; `setValue({device,channel,parameter}, v)` valida e chiama `central.setValue` con il valore convertito; `setValue` fuori range → ValidationError (non chiama central).
- Commit: `feat(api): Homematic public facade (valueChanged stream + setValue)`.

### Task 6: integrazione facade + (opz.) e2e
- Integration test (con FakeCcu reale, riusando il wiring di Fase 2 ma attraverso la facade `Homematic`): `start()` → `devices()` popolato; FakeCcu `emitEvent` → la facade emette `valueChanged`; `setValue` raggiunge il FakeCcu; `stop()` pulito.
- Aggiorna/aggiungi un e2e reale `tests/e2e/facade-smoke.test.ts` (gated HM_E2E): `new Homematic({...da env})`, `start()`, assert `devices().length>0` e che i DP abbiano metadati (type/readable), attesa breve `valueChanged`, `stop()`. READ-ONLY.
- Commit: `test(api): facade integration + e2e smoke`.

### Task 7: Device configuration (paramset MASTER) sulla facade — per costruire una UI di config
Obiettivo: esporre i building-block per una UI di configurazione dispositivi (tipo il pannello nativo di HA `homematicip_local`): device → canali → parametri MASTER con metadati per generare i form, + lettura/scrittura dei valori MASTER.
- Il `model-builder`/`GenericDataPoint` riguardano i VALUES (stato live). La configurazione MASTER è SEPARATA: usa le descrizioni MASTER già in `ParamsetDescriptionCache` (scoperte in Fase 2) + `getParamset`/`putParamset` di `InterfaceClient`.
- Tipi pubblici (`api/types.ts`): `HmConfigParam { parameter, type, min?, max?, default?, unit?, valueList?, flags, writable }` e `HmChannelConfig { channelAddress, params: HmConfigParam[] }`.
- Sulla facade `Homematic`:
  - `getConfigParams(channelAddress: string): HmConfigParam[]` — gli SPEC dei parametri MASTER del canale (dalla paramset cache via `central`), per generare i form. (Esporre dal CentralUnit un accessor read-only alla `ParamsetDescriptionCache` o un metodo `central.getParamsetSpec(interfaceId, channelAddress, 'MASTER')`.)
  - `async getConfig(channelAddress: string): Promise<Record<string, HmValue>>` — valori MASTER correnti (delega a `central` → `InterfaceClient.getParamset(channelAddress, 'MASTER')`, converte via converter).
  - `async setConfig(channelAddress: string, values: Record<string, HmValue>): Promise<void>` — valida ogni valore contro lo spec MASTER (range/enum/tipo, writable) e scrive in un solo `putParamset(channelAddress, 'MASTER', ccuValues)`.
- Estendere `CentralUnit` con: `getParamsetSpec(interfaceId, channelAddress, paramsetKey): Record<string, ParameterData> | undefined` (read della paramset cache) e `getParamset(dpkOrChannel, paramsetKey)` / `putParamset(channelAddress, paramsetKey, values)` che instradano all'`InterfaceClient` giusto per interfaceId.
- Test: `getConfigParams` ritorna gli spec MASTER del canale; `getConfig` legge e converte; `setConfig` valida (un valore fuori range → ValidationError, NON scrive) e su valori validi chiama `putParamset` una sola volta con i valori convertiti.
- Commit: `feat(api): device configuration (MASTER paramset) sulla facade`.

## Gate finale Fase 3
`npm run lint && npm run format:check && npm run typecheck && npm run test:cov && npm run build` verde, coverage ≥ 80%. Bump `package.json` a `0.1.0` (primo rilascio funzionale) in un commit dedicato a fine fase (NON pubblicare su npm senza ok utente).

## Self-review
- Copertura spec §5 (API pubblica) + §6 (model generic+hub): converter (T1), GenericDataPoint (T2), device/channel/builder (T3), emitter/events/types (T4), facade (T5), integrazione+e2e (T6). Hub (sysvar/programmi) e custom entities restano Fasi 4/5. ✅
- Confine pubblico: `index.ts` esporta solo `api/` + tipi pubblici; transport/central interni. ✅
- Stream globale unico `valueChanged` (no per-device), `setValue` validato. ✅
