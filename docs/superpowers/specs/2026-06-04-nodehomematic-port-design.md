# nodehomematic — Design (porting Node.js/TypeScript di aiohomematic)

- **Data:** 2026-06-04
- **Repo target:** `apocaliss92/nodehomematic`
- **Riferimento:** [sukramj/aiohomematic](https://github.com/sukramj/aiohomematic) (libreria Python async, backend dell'integrazione Home Assistant "Homematic(IP) Local")
- **Stato:** approvato in brainstorming, pronto per writing-plans

## 1. Obiettivo e scope

Libreria **npm standalone** in **TypeScript strict** che porta `aiohomematic` su Node.js, con i seguenti confini concordati:

- **Backend:** solo **CCU3 / RaspberryMatic / OpenCCU** (XML-RPC + JSON-RPC). Homegear/CUxD/CCU-Jack fuori scope iniziale.
- **API pubblica agnostica:** un sistema esterno (app NodeJS dell'utente) interagisce solo con una facade, mai con i dettagli CCU/XML-RPC.
- **Funzionalità:** complete per CCU3 — connessione, discovery, model generico + **tutti i tipi custom** (a fasi), hub (sysvar/programmi).
- **Approccio:** porting a strati **fedele** ad aiohomematic (eredita decisioni collaudate), con API TS idiomatica sopra.

### Non-goal (iniziali)
- Backend diversi da CCU3/RaspberryMatic.
- Sottoscrizioni eventi per singolo device (è sufficiente **uno stream globale**).
- Replica 1:1 dei decoratori/idiomi Python.

## 2. Architettura a strati e layout

Pacchetto npm singolo, TypeScript strict, build ESM+CJS via `tsup`, target Node 20+. File piccoli e focalizzati (200–400 righe, max 800). Stato di dominio **immutabile**.

```
src/
  transport/            # comunicazione, nessuna logica di dominio
    xmlrpc/             # client + parser/serializer XML-RPC (quirk Homematic)
    jsonrpc/            # client JSON-RPC WebUI CCU (auth, names, rooms, programs, sysvars)
    callback-server/    # server XML-RPC che riceve i push dalla CCU
    resilience/         # circuit-breaker, retry, throttle, request-coalescer
    interface-client.ts # un client per interfaccia (BidCos-RF, HmIP-RF, ...)
  central/              # orchestrazione
    central-unit.ts     # facciata interna: client + callback, discovery, reconnect
    device-registry.ts  # fonte di verità dei device scoperti (immutabile)
    discovery.ts        # listDevices/getDeviceDescription/getParamsetDescription + arricchimento JSON-RPC
    cache/              # cache persistente (device/paramset descriptions, names)
    event-bus.ts        # bus eventi interno tipizzato
    connection-state.ts / health.ts / scheduler.ts
  model/
    data-point.ts       # base data point
    device.ts / channel.ts
    generic/            # data point generici (per parametro VALUES)
    custom/             # light, switch, cover, climate, lock, ... (a fasi)
    hub/                # system variables, programmi
    calculated/ combined/   # derivati (fase tarda)
  api/                  # API PUBBLICA agnostica
    homematic.ts        # classe facade: connect/listDevices/getValue/setValue
    events.ts           # tipi eventi + EventEmitter tipizzato
    types.ts            # Device, Channel, DataPoint, CustomEntity, payload eventi
  support/              # const, errori, logger, validazione (zod), i18n opz.
  index.ts              # entrypoint pubblico (ri-esporta solo api/)
tests/
  unit/ integration/ fixtures/ e2e/
```

**Confine pubblico:** `api/` è l'unico import esposto. `transport`/`central`/`model` sono interni.

## 3. Transport layer

Senza logica di dominio: parla "metodi CCU grezzi" ed emette eventi grezzi normalizzati.

### XML-RPC client (`transport/xmlrpc/`)
Verso le interfacce CCU (porte tipiche: BidCos-RF 2001, HmIP-RF 2010, Virtual/Groups 9292; varianti TLS). Metodi: `init`, `getDeviceDescription`, `listDevices`, `getParamsetDescription`, `getParamset`, `getValue`, `setValue`, `putParamset`, `system.multicall`, `ping`.
- **Riuso:** partenza dal pacchetto npm `xmlrpc` (client+server) dietro un nostro `RpcProxy`. Se emergono quirk Homematic (encoding ISO-8859-1, tipi `i8`/`double`, `system.multicall`) si sostituisce il serializer interno con uno custom su `fast-xml-parser` **senza toccare i consumer**.

### JSON-RPC client (`transport/jsonrpc/`)
Verso la WebUI CCU (`/api/homematic.cgi`) per ciò che l'XML-RPC non offre: `Session.login/logout`, nomi device/canali, stanze (`Room`), funzioni (`Subsection`), programmi, system variables. `undici`/fetch nativo, gestione session-id con re-login a scadenza.

### Callback server (`transport/callback-server/`)
Server XML-RPC HTTP richiamato dalla CCU dopo `init(callbackUrl, interfaceId)`. Gestisce `event`, `newDevices`, `deleteDevices`, `updateDevice`, `replaceDevice`, `readdedDevice`, `listDevices`, `system.listMethods`, `system.multicall`. Normalizza ogni push in eventi interni sul bus.

### Resilienza (`transport/resilience/`)
Wrapper componibili attorno al proxy: **circuit-breaker** per interfaccia, **retry** con backoff su errori transitori, **throttle** (rate-limit comandi), **request-coalescer** (deduplica letture concorrenti identiche).

## 4. Central (orchestrazione)

`central-unit.ts` lega transport e model.

- **Lifecycle/connessione:** `start()` crea un `InterfaceClient` per interfaccia abilitata, avvia il callback server, esegue `init` per registrare l'URL di callback, fa proxy-init. `stop()` de-registra con `init(url, "")` e chiude pulito. `connection-state.ts` traccia lo stato per-interfaccia; `health.ts` fa ping periodico; su caduta → backoff, re-`init`, re-sync discovery.
- **Discovery (`discovery.ts`):** `listDevices` → per ogni device/canale `getDeviceDescription` + `getParamsetDescription` (MASTER/VALUES) → arricchimento con nomi/stanze/funzioni via JSON-RPC → grafo `Device → Channel → Parameter`. `deleteDevices`/`replaceDevice` aggiornano il registry in modo immutabile.
- **Caching (`cache/`):** cache **persistente** su disco (path configurabile, default attivo) di device/paramset descriptions e nomi; invalidata da versione firmware/CCU. Avvio caldo senza ri-discovery completa.
- **Event bus (`event-bus.ts`):** bus interno tipizzato; riceve gli eventi grezzi normalizzati dal callback server e li smista (valore data point, device add/remove, lifecycle, diagnostica). Il model si abbona qui.
- **device-registry.ts:** fonte di verità immutabile, lookup per address/interface.

## 5. API pubblica (facade agnostica)

Unico import pubblico: `nodehomematic`.

```ts
const hm = new Homematic({
  host: '192.168.x.x',
  interfaces: ['HmIP-RF', 'BidCos-RF'],
  credentials: { username, password },     // per JSON-RPC
  callback: { host, port },                // url che la CCU richiama
  cache: { dir: '...', enabled: true },    // persistente, default on
  tls: false,
});

await hm.start();                  // connette, discovery, registra callback
await hm.stop();                   // de-registra e chiude pulito

hm.devices();                      // snapshot immutabile di tutti i device/entity
hm.getValue(dpId);                 // lettura (da stato/cache)
await hm.setValue(dpId, value);    // scrittura validata verso la CCU
await hm.setValue({ device, channel, parameter }, value); // forma esplicita
```

**Stream globale tipizzato** (EventEmitter — niente per-device):

```ts
hm.on('valueChanged', (e) => { /* { dpId, device, channel, parameter, value, prevValue, ts } */ });
hm.on('deviceAdded',   (e) => { /* device scoperto */ });
hm.on('deviceRemoved', (e) => { /* ... */ });
hm.on('connection',    (e) => { /* { interface, state } */ });
hm.on('ready',         () => { /* discovery iniziale completata */ });
hm.on('error',         (err) => { /* ... */ });
```

`valueChanged` è il flusso live unico per **tutti** i device connessi. Gli update in uscita passano sempre da `setValue` (validato contro i metadati del data point). Le custom entity espongono metodi comodi (`light.setBrightness(...)`) che internamente usano lo **stesso** percorso `setValue` → un solo cammino di scrittura testabile.

Tipi esportati agnostici: `Device`, `Channel`, `DataPoint`, `CustomEntity`, payload eventi.

## 6. Model layer

Gerarchia immutabile costruita dalla discovery, disaccoppiata dal transport.

- **Base:** `Device` (address, tipo/firmware, interfaccia, nome/stanza/funzione) → `Channel[]` → `DataPoint[]`. `data-point.ts`: identità stabile `interface:address:channel:parameter`, metadati paramset (tipo, min/max, unit, value-list, flag RO/WO/EVENT), valore corrente, timestamp, availability.
- **Generic (`model/generic/`):** un data point per parametro VALUES; lettura (evento/cache) e scrittura (`setValue`/`putParamset`) con validazione contro i metadati e conversione tipi CCU↔JS centralizzata (`converter`). Da solo soddisfa "esponi tutto in modo generico".
- **Custom (`model/custom/`, a fasi):** entità tipizzate di dominio che aggregano data point: `Switch`, `Light`, `Cover`/`Blind`, `Climate`, `Lock`, `Siren`, ecc. Ognuna ha: regola di riconoscimento (per device-type/canali), proprietà di alto livello e metodi che traducono in operazioni sui data point sottostanti.
- **Hub (`model/hub/`):** system variables e programmi CCU (JSON-RPC) come data point/azioni di primo livello.
- **Calculated/Combined:** data point derivati e combinati (fase tarda), senza impatto sul confine pubblico.

Ogni livello si abbona all'event bus, aggiorna lo stato in modo immutabile e ri-emette "valore cambiato" verso la facade.

## 7. Testing

TDD, copertura 80%+, tre livelli.

- **Unit (vitest):** serializer/parser XML-RPC su fixture reali, resilienza (timer fake deterministici), converter tipi, validazione metadati, regole di riconoscimento custom, riduttori immutabili del registry.
- **Integration:** **finto CCU** in-process (HTTP che risponde a XML-RPC + JSON-RPC con fixture registrate dalla CCU reale) per il ciclo `start → discovery → callback → valueChanged → setValue`, incluso il callback server che riceve `event`/`newDevices`.
- **E2E:** contro la CCU3/RaspberryMatic reale — smoke (connessione, discovery, eventi live, una scrittura sicura). Gated da env (`HM_E2E=1` + credenziali), esclusi dalla CI pubblica.
- **Contract/fixtures:** payload reali catturati dalla CCU (discovery + alcuni eventi) versionati come fixture per allineare integration ed e2e al comportamento vero.

## 8. Roadmap a fasi

- **Fase 0 — Scaffold:** repo GitHub `apocaliss92/nodehomematic`, TS strict, `tsup`, vitest, eslint+prettier, CI GitHub Actions, README, LICENSE, struttura cartelle.
- **Fase 1 — Transport:** XML-RPC client + callback server, JSON-RPC client + sessione, resilienza. Test unit + finto CCU.
- **Fase 2 — Central:** discovery, registry immutabile, cache persistente, event bus, lifecycle + reconnect.
- **Fase 3 — Model generic + facade pubblica** (`valueChanged`/`setValue`): primo rilascio end-to-end utile; pubblicazione npm `0.x` (API in evoluzione).
- **Fase 4 — Custom entity:** una famiglia alla volta (switch → light → cover → climate → lock → …), ognuna con test.
- **Fase 5 — Hub** (sysvar/programmi) + calculated/combined.

Ogni fase è un ciclo spec→plan→implementazione testato.

## 9. Decisioni chiuse e rischi

- **Quirk XML-RPC Homematic** (encoding ISO-8859-1, `system.multicall`, tipi numerici): mitigati dal confine `RpcProxy` con fallback a serializer custom.
- **Licenza:** ✅ **MIT** (stessa di aiohomematic). Si mantiene il copyright originale `Copyright (c) 2021-2026 SukramJ, Daniel Perna` e si aggiunge il copyright del porting (richiesto da MIT per la redistribuzione).
- **Nome npm:** ✅ `nodehomematic` disponibile sul registry (verificato 2026-06-04).
- **Reconnect/CCU restart — requisito rock-solid:** la riconnessione è un requisito di primo livello, non best-effort. La CCU perde la registrazione del callback a ogni riavvio/perdita di rete; il sistema deve:
  - rilevare la caduta via **health-ping periodico** per interfaccia + assenza di eventi attesi;
  - ri-eseguire `init(callbackUrl, interfaceId)` con **backoff esponenziale + jitter** finché non riprende;
  - **re-sync** della discovery dopo il re-init (i device possono essere cambiati durante l'outage);
  - emettere eventi `connection` di transizione stato così che l'app esterna sappia sempre lo stato reale;
  - sopravvivere a riavvii prolungati della CCU senza intervento manuale e senza perdere lo stato in cache.
  - Coperto da test integration dedicati (finto CCU che cade/riparte) oltre che e2e.
