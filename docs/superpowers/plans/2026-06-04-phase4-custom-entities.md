# nodehomematic — Fase 4: Custom Entities

> **For agentic workers:** TDD module-by-module. Builds on Phases 1–3 (merged, 0.1.0). Custom entities aggregate multiple generic data points into typed domain objects (Climate/Switch/Light/Cover/Lock…) via a declarative registry + profile config, faithful to aiohomematic's `model/custom`.

**Goal:** Framework custom-entity (registry device-type→config + profile field→parameter→canale + base class che aggrega i `GenericDataPoint` per `Field`) + le famiglie principali (Climate incl. gruppi HmIP-HEATING, Switch, Light/Dimmer, Cover/Blind, Lock), esposte sulla facade. Estensibile per il resto.

**Architecture:** Una `CustomEntity` non possiede stato proprio dei valori: fa da vista tipizzata sopra i `GenericDataPoint` del modello (Fase 3), risolvendoli per `Field`→`Parameter`→canale. Le proprietà di alto livello leggono `dp.value`; i comandi convertono e instradano via `Homematic.setValue` (un solo cammino di scrittura validato). Il riconoscimento è data-driven: una tabella `DeviceProfileRegistry` mappa il TYPE del device (normalizzato, match esatto poi prefisso) a un `DeviceConfig {entityClass, profile, channels}`; un `ProfileConfig` descrive i field per canale.

**Tech Stack:** TypeScript strict, Node 20+. Test: vitest + fake model + e2e reale (i 9 gruppi HmIP-HEATING dell'utente → Climate).

---

## Facts (da aiohomematic model/custom — autorevoli)
- **Field** = chiave stabile interna; **Parameter** = nome CCU sul canale (il valore enum == stringa CCU). Esempi climate IP: SETPOINT→`SET_POINT_TEMPERATURE`, TEMPERATURE→`ACTUAL_TEMPERATURE`, HUMIDITY→`HUMIDITY`, SET_POINT_MODE→`SET_POINT_MODE` (0 AUTO/1 MANU/2 AWAY), CONTROL_MODE→`CONTROL_MODE` (action write), BOOST_MODE→`BOOST_MODE`, ACTIVE_PROFILE→`ACTIVE_PROFILE`, LEVEL→`LEVEL` (valvola %), STATE→`STATE`.
- **Riconoscimento:** normalizza `model.toLowerCase().replace('hb-','hm-')`; match ESATTO poi PREFISSO; un model può mappare più config (es. lock+button-lock). Channels base default `(1,)`; primary_channel relativo (default 0); secondary/state offset.
- **Climate:** classi Simple/RF/IP thermostat. IP usato anche per i GRUPPI (`HmIP-HEATING`): stessa classe `CustomDpIpThermostat`, profilo `IP_THERMOSTAT_GROUP` con `include_default_data_points=false` (i gruppi non hanno ch0 battery/RSSI), channel_fields `0→{LEVEL}`, `3→{STATE}`. Modi: target≤4.5→OFF; SET_POINT_MODE MANU→HEAT; AUTO→AUTO. Preset: BOOST se boost_mode, AWAY se SET_POINT_MODE=2, else week program (ACTIVE_PROFILE). Step 0.5, unit °C.
- **Switch:** STATE→`STATE`, turn_on/off, on_time opz.; additional DP energia (POWER/VOLTAGE/CURRENT/ENERGY_COUNTER) su canale dedicato.
- **Light/Dimmer:** LEVEL→`LEVEL` (0..1 float). brightness 0–255: `level=brightness/255`. Colore (COLOR/HUE/SATURATION/COLOR_TEMPERATURE) per i RGB/tunable. is_on = level>0.
- **Cover/Blind:** LEVEL→`LEVEL`, STOP→`STOP`, DIRECTION→`ACTIVITY_STATE`(IP)/`DIRECTION`(RF). position 0–100: `level=position/100`. Blind: LEVEL_2 (slat tilt). open=1.0/close=0.0/stop(critical).
- **Lock:** IP: LOCK_STATE→`LOCK_STATE` (LOCKED/UNLOCKED), LOCK_TARGET_LEVEL→`LOCK_TARGET_LEVEL` (LOCKED/UNLOCKED/OPEN). RF: STATE→`STATE` (lock=false/unlock=true), OPEN→`OPEN`. Comandi CRITICAL.
- **DataPointUsage:** la custom entity marca i DP sottostanti: visible→mostrato; default-consumed→nascosto (owned). Per il nostro port: i GenericDataPoint restano tutti nel modello; la custom entity è una VISTA aggiuntiva (non rimuoviamo i DP). Esponiamo opzionalmente `hidden` flag sui DP consumati.

---

## File structure (Fase 4)
```
src/model/custom/
  fields.ts            # enum Field (chiavi stabili) + Parameter consts CCU usati
  profile.ts           # tipi ProfileConfig/ChannelGroupConfig/FieldValue + PROFILE_CONFIGS (IP_THERMOSTAT, IP_THERMOSTAT_GROUP, IP_SWITCH, IP_DIMMER, IP_COVER, IP_BLIND, IP_LOCK, RF_*…)
  registry.ts          # DeviceProfileRegistry: DeviceConfig + register/getConfigs(model) (exact→prefix, normalize)
  base.ts              # CustomEntity base: risolve Field→GenericDataPoint dal ModelDevice, field access, subscribe, command routing via writer
  resolve.ts           # buildCustomEntities(device: ModelDevice, writer): CustomEntity[] (applica registry+profilo, rebase canali)
  helpers.ts           # brightnessToLevel/levelToBrightness, positionToLevel/levelToPosition
  climate.ts           # ClimateEntity (IP thermostat + group): target/current temp, humidity, mode, preset, setTemperature/setMode/setPreset/boost
  switch.ts            # SwitchEntity: on/off, turnOn(onTime?)/turnOff
  light.ts             # LightEntity/DimmerEntity: brightness, isOn, turnOn/turnOff/setBrightness (+ColorLight se trivial)
  cover.ts             # CoverEntity/BlindEntity: position, isClosed, open/close/stop/setPosition (+tilt)
  lock.ts              # LockEntity (IP+RF): isLocked, lock/unlock/open
  index.ts             # registra tutte le famiglie (side-effect import) + export tipi
src/api/
  types.ts             # + tipi pubblici custom: HmCustomEntity union (HmClimate/HmSwitch/HmLight/HmCover/HmLock) con campi/azioni
  homematic.ts         # + customEntities(): HmCustomEntity[]; + per-azione: entity command methods o un metodo generico
tests/unit/model/custom/...  tests/e2e/custom-*.test.ts
```

---

## Tasks (TDD)

### Task 1: fields + profile types + registry (framework, no families yet)
- `fields.ts`: `enum Field` (le chiavi del report: STATE, LEVEL, LEVEL_2, STOP, DIRECTION, SETPOINT, TEMPERATURE, HUMIDITY, SET_POINT_MODE, CONTROL_MODE, BOOST_MODE, ACTIVE_PROFILE, LOCK_STATE, LOCK_TARGET_LEVEL, OPEN, COLOR, HUE, SATURATION, COLOR_TEMPERATURE, ON_TIME_VALUE, …). `Parameter` const map (Field non basta: serve la stringa CCU). Per semplicità un `FieldMapping { field: Field; parameter: string; visible?: boolean; channelOffset?: number }`.
- `profile.ts`: tipi `ChannelGroupConfig { primaryChannel?: number; secondaryChannels?: number[]; stateChannelOffset?: number; fields: FieldMapping[]; channelFields?: Record<number, FieldMapping[]>; additionalParameters?: Record<number, string[]>; includeDefaultDataPoints?: boolean }`, `ProfileConfig` (alias). `DeviceProfile` enum (IP_THERMOSTAT, IP_THERMOSTAT_GROUP, IP_SWITCH, IP_DIMMER, IP_COVER, IP_BLIND, IP_LOCK, RF_THERMOSTAT, RF_SWITCH, …). `PROFILE_CONFIGS: Record<DeviceProfile, ChannelGroupConfig>` (popolato man mano dalle famiglie, o qui per le principali).
- `registry.ts`: `DeviceConfig { entityClass: CustomEntityCtor; profile: DeviceProfile; channels: number[] }`. `DeviceProfileRegistry` con `register(model, config)`, `registerMultiple(model, configs[])`, `getConfigs(model): DeviceConfig[]` (normalize lower + `hb-`→`hm-`; exact poi prefix). Singleton esportato.
- Test: normalize+match esatto e prefisso; registerMultiple; getConfigs ritorna [] per model sconosciuto.
- Commit: `feat(custom): framework — fields, profile config, device registry`.

### Task 2: CustomEntity base + resolve + helpers + Switch (reference family)
- `base.ts`: `abstract class CustomEntity` `{ readonly deviceAddress; readonly primaryChannelAddress; readonly type: string; protected dp(field: Field): GenericDataPoint | undefined; protected requireDp(field): GenericDataPoint; protected async write(field, value): Promise<void> /* via injected writer = (dpk,value)=>Promise */; subscribe(cb): ()=>void /* aggrega le subscribe dei DP */; get available(): boolean }`. Risolve i Field→GenericDataPoint usando una mappa costruita in `resolve.ts`.
- `resolve.ts`: `buildCustomEntities(device: ModelDevice, writer): CustomEntity[]` — per il device, `registry.getConfigs(device.type)`; per ogni config, per ogni base channel applica il ProfileConfig (rebase relativo→assoluto), risolve i `GenericDataPoint` dal `ModelDevice` (per channelAddress+parameter), istanzia la entityClass con la mappa Field→DP + writer. Difensivo: field mancante → DP assente (i getter ritornano undefined/null).
- `helpers.ts`: `brightnessToLevel(0..255)→0..1`, `levelToBrightness`, `positionToLevel(0..100)→0..1`, `levelToPosition`.
- `switch.ts`: `class SwitchEntity extends CustomEntity` — `get isOn(): boolean` (= dp(STATE).value===true), `async turnOn(): Promise<void>`, `async turnOff()`. Registra in `index.ts` per i model switch principali (HmIP-PS ch3, HmIP-BSM ch4, HM-LC-Sw* ch1).
- Test: con un ModelDevice fake (switch, canale con STATE writable) → SwitchEntity.isOn riflette il DP; turnOn chiama il writer con il dpk STATE e valore true (convertito); resolve costruisce la SwitchEntity dal registry.
- Commit: `feat(custom): CustomEntity base + resolver + Switch family`.

### Task 3: Climate (IP thermostat + heating group) — PRIORITÀ
- `climate.ts`: `class ClimateEntity extends CustomEntity`:
  - getters: `currentTemperature` (TEMPERATURE/ACTUAL_TEMPERATURE), `targetTemperature` (SETPOINT/SET_POINT_TEMPERATURE), `currentHumidity` (HUMIDITY), `minTemp`/`maxTemp` (dai metadati dp), `targetTemperatureStep`=0.5, `mode` ('auto'|'heat'|'off' via SET_POINT_MODE + soglia 4.5), `preset` ('boost'|'away'|'none'|week-program via BOOST_MODE/SET_POINT_MODE/ACTIVE_PROFILE), `activity` ('heating'|'idle'|'off' da LEVEL/STATE).
  - comandi: `async setTemperature(t)`, `async setMode('auto'|'heat'|'off')` (AUTO→CONTROL_MODE=0; HEAT→CONTROL_MODE=1; OFF→temp 4.5), `async setBoost(on)`, `async setProfile(weekProgramIndex)`.
- `profile.ts`: aggiungi `IP_THERMOSTAT_CONFIG` e `IP_THERMOSTAT_GROUP_CONFIG` (group: includeDefaultDataPoints=false, channelFields 0→LEVEL, 3→STATE). Registra: `HmIP-eTRV*`, `HmIP-(B)WTH*`, `HmIP-HEATING` (group, channels (1,)), `HmIP-STH*`, `HmIP-FALMOT*` (valve actuator — verifica: FALMOT è un attuatore valvole multi-canale; potrebbe NON essere climate ma esporre LEVEL per canale → trattare come valve/climate per canale; se incerto, registralo come thermostat group-like o lascialo generico e annota).
- Test: ClimateEntity con DP fake (SET_POINT_TEMPERATURE=21, ACTUAL_TEMPERATURE=20.5, HUMIDITY=45, SET_POINT_MODE=1) → targetTemperature 21, currentTemperature 20.5, mode 'heat'; setTemperature(22) → writer su SET_POINT_TEMPERATURE; setMode('off') → CONTROL_MODE write + temp 4.5; setBoost(true) → BOOST_MODE write.
- Commit: `feat(custom): Climate (IP thermostat + heating group)`.

### Task 4: Light, Cover, Lock
- `light.ts`: `DimmerEntity` — `brightness` (0..255 da LEVEL), `isOn`, `turnOn(brightness?)`, `turnOff()`, `setBrightness(0..255)`. (Color opzionale: se trivial aggiungi `ColorLightEntity` con HUE/SATURATION; altrimenti rimanda.)
- `cover.ts`: `CoverEntity` — `currentPosition` (0..100 da LEVEL), `isClosed`, `open()`, `close()`, `stop()`, `setPosition(0..100)`. `BlindEntity extends CoverEntity` con `currentTiltPosition` (LEVEL_2) + `setPosition(pos, tilt?)`.
- `lock.ts`: `LockEntity` — IP: `isLocked` (LOCK_STATE), `lock/unlock/open` (LOCK_TARGET_LEVEL). RF variante (STATE/OPEN). 
- Registra i model principali in `index.ts`.
- Test per ciascuna: getters dai DP fake + comandi che instradano i valori convertiti corretti al writer.
- Commit: `feat(custom): Light, Cover, Lock families`.

### Task 5: facade integration + tipi pubblici
- `api/types.ts`: tipi pubblici custom. Approccio pragmatico: `HmCustomEntity` discriminated union per `kind` ('climate'|'switch'|'light'|'cover'|'lock') con i campi di stato + (per i comandi) NON mettere funzioni nei tipi snapshot; i comandi si fanno via metodi della facade. Es. `HmClimate { kind:'climate'; device; channel; currentTemperature; targetTemperature; currentHumidity?; mode; preset; minTemp?; maxTemp? }`, ecc. Snapshot immutabile.
- `homematic.ts`: in `start()`, dopo aver costruito il model, costruisci le custom entities (`buildCustomEntities` per ogni device, writer = `(dpk,val)=>this.#central.setValue(dpk,val)` oppure il percorso prepareWrite). Tieni una mappa `Map<deviceAddress, CustomEntity[]>`.
  - `customEntities(): HmCustomEntity[]` — snapshot pubblico.
  - `customEntity(deviceAddress, channel?): CustomEntity | undefined` — accesso all'oggetto vivo (per i comandi). MA per non esporre tipi interni: esporre metodi di comando sulla facade: `async climateSetTemperature(deviceAddress, channelOrAddress, t)`, `async climateSetMode(...)`, `async switchTurnOn/Off(...)`, `async coverSetPosition(...)`, `async lockLock/Unlock(...)`, ecc. OPPURE un metodo generico `async command(ref, action, args)`. Scegli l'approccio metodi-espliciti per ergonomia e type-safety; documenta.
  - aggiorna le custom entities su `deviceAdded`/`deviceRemoved`.
  - le entity emettono via i DP sottostanti → la facade può emettere un evento `customEntityChanged` (opzionale; lo stream `valueChanged` già copre i cambi grezzi). Per il primo taglio: NON aggiungere un nuovo evento, basta lo snapshot + valueChanged.
- `index.ts`: esporta i tipi pubblici custom (`HmCustomEntity` e i membri). NON esportare le classi interne CustomEntity.
- Test unit: facade costruisce le custom entities; `customEntities()` snapshot corretto; `climateSetTemperature(addr, ch, 22)` instrada al setValue con SET_POINT_TEMPERATURE convertito.
- Commit: `feat(api): expose custom entities + command methods on facade`.

### Task 6: e2e reale + integrazione
- e2e `tests/e2e/custom-smoke.test.ts` (gated HM_E2E): `Homematic` con tutte le interfacce; `start()`; trova i 9 `HmIP-HEATING` → asserisci che siano ClimateEntity con `targetTemperature`/`currentTemperature` numerici e `mode` valorizzato; log un esempio. READ-ONLY (NIENTE setTemperature reale, o al più leggi). Verifica che `customEntities()` contenga climate. Conta le custom entities per kind.
- Integration (fake CCU): un device switch + un climate group canned → customEntities popolate; un comando instrada al fake.
- Commit: `test(custom): e2e + integration custom entities`.

## Gate finale Fase 4
`npm run lint && npm run format:check && npm run typecheck && npm run test:cov && npm run build` verde, coverage ≥ 80%. e2e reale: i 9 gruppi riconosciuti come Climate.

## Note / scope
- "Tutti i tipi custom" è un catalogo enorme: questa fase consegna il FRAMEWORK + Climate/Switch/Light/Cover/Lock con le registrazioni dei model principali. Altre famiglie (siren, valve, garage, RGBW, fixed-color, button-lock, smoke) si aggiungono con nuove registrazioni nel registry senza toccare il core — annotare come estensioni successive.
- Le custom entity sono VISTE: non rimuovono i GenericDataPoint dal modello (lo stream `valueChanged` resta completo).

## Self-review
- §spec custom entities: framework (T1), base+switch (T2), climate (T3), light/cover/lock (T4), facade (T5), e2e (T6). ✅ Catalogo completo = estensioni incrementali via registry. ✅
