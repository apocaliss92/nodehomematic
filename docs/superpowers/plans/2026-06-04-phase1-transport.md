# nodehomematic — Fase 1: Transport Implementation Plan

> **For agentic workers:** Implement module-by-module with TDD (test first, RED, GREEN, refactor). Frequent commits. The transport layer has NO domain logic — it speaks raw CCU methods and emits raw normalized events.

**Goal:** Implementare il layer di comunicazione verso una CCU3/RaspberryMatic: client XML-RPC (+ serializer/parser con i quirk Homematic), callback server XML-RPC, client JSON-RPC (sessione), tassonomia errori, e i primitivi di resilienza (circuit-breaker, retry, throttle, request-coalescer, state machine), più un `InterfaceClient` che li compone. Validato con unit test e un finto CCU in-process. NIENTE hardware.

**Architecture:** Tutto sotto `src/transport/` + `src/support/errors.ts`. Ogni modulo è isolato dietro un'interfaccia stretta. Nessuna dipendenza dal `model`/`central`. Conformità ai fatti di protocollo estratti dal sorgente di aiohomematic (vedi sezione "Protocol facts").

**Tech Stack:** TypeScript strict, Node 20+. XML-RPC: serializer/parser custom su `fast-xml-parser` (per controllare encoding ISO-8859-1 in uscita / UTF-8 in ingresso e i tag tipo). HTTP: `undici`/fetch nativo. Server callback: `node:http`. Test: vitest.

---

## Protocol facts (autorevoli, dal sorgente aiohomematic `devel`)

### Interfacce e porte (`const.py`)
- `BidCos-RF` → (2001, 42001 TLS); `HmIP-RF` → (2010, 42010); `BidCos-Wired` → (2000, 42000); `VirtualDevices` → (9292, 49292).
- JSON-RPC: 80 (TLS 443). Path JSON-RPC: `/api/homematic.cgi`.
- `Backend`: CCU | Homegear | PyDevCCU. Encoding: outbound XML-RPC **ISO-8859-1**, inbound callback server **UTF-8**.

### XML-RPC client → CCU (argomenti POSIZIONALI, ordine esatto)
- `init(initUrl, interfaceId)` registra il callback; `init(initUrl)` (UN solo arg) de-registra.
- `ping(callerId)` → bool (la CCU risponde con un callback `pong`/event). `callerId = "{interfaceId}#{token}"`, token = timestamp.
- `listDevices()` → `DeviceDescription[]`.
- `getDeviceDescription(address)` → `DeviceDescription`.
- `getParamsetDescription(channelAddress, paramsetKey)` → `Record<string, ParameterData>`; paramsetKey ∈ `VALUES|MASTER|LINK`.
- `getParamset(channelAddress, paramsetKey)` → dict.
- `getValue(channelAddress, parameter)` → any.
- `setValue(channelAddress, parameter, value)` (+ opzionale `rxMode`).
- `putParamset(channelAddress, paramsetKey, values)` (+ opzionale `rxMode`).
- `getInstallMode()` → int; `setInstallMode(on, time, mode)` o `setInstallMode(on, time, deviceAddress)`.
- `system.listMethods()` → string[]. `getVersion()` (probe). Homegear probe: `clientServerInitialized`.
- `interfaceId = "{centralName}-{interface}"` (es. `MyCCU-HmIP-RF`). Init URL: `http://{callbackHost}:{callbackPort}` (sempre http, nessun path).
- Fault code IntEnum: GENERIC -1, UNKNOWN_DEVICE -2, UNKNOWN_PARAMSET -3, ADDRESS_EXPECTED -4, UNKNOWN_PARAMETER -5, OP_NOT_SUPPORTED -6, UPDATE_NOT_POSSIBLE -7, INSUFFICIENT_DUTYCYCLE -8, DEVICE_OUT_OF_RANGE -9, TRANSMISSION_PENDING -10. Retryable: {-1,-8,-9,-10}. Empty body (HTTP 200, no XML) → ClientException.

### JSON-RPC client → CCU WebUI
- POST `/api/homematic.cgi`, envelope `{"method", "params", "jsonrpc": "1.1", "id": 0}`. **Tutti i valori param stringificati** (`String(value)`). Session id iniettato come param `_session_id_` quando `useDefaultParams`.
- Risposta `{"result", "error", "id"}` (UTF-8). Su errore: `error` truthy.
- Sessione: `Session.login{username,password}` → result = sessionId; `Session.renew{_session_id_}` (result===true → ok); `Session.logout{_session_id_}`. Login rate-limit: max 10 tentativi falliti, backoff 1s→60s ×2. `JSON_SESSION_AGE=90`s (skip renew se rinfrescata da poco). Le 3 Session.* bypassano il circuit breaker. Concorrenza HTTP: semaforo `MAX_CONCURRENT_HTTP_SESSIONS=3`.
- Metodi (nomi esatti): `CCU.getAuthEnabled`, `CCU.getHttpsRedirectEnabled`, `Device.listAllDetail`, `Device.setName`, `Channel.setName`, `Interface.listInterfaces`, `Interface.listDevices(interface)`, `Interface.getInstallMode(interface)`, `Interface.setInstallModeHMIP(interface,on,time,installMode,address,...)` (sostituisce XML-RPC setInstallMode SOLO per HmIP-RF), `Program.getAll`, `Program.execute(id)`, `SysVar.getAll`, `SysVar.getValueByName(name)`, `SysVar.setBool`, `SysVar.setFloat`, `Room.getAll`, `Subsection.getAll`, `ReGa.runScript(script)`, `system.listMethods`.
- Error mapping (per CONTENUTO messaggio): `startsWith("access denied")` o code∈{401,-32001} → AuthFailure; `"internal error"` o code∈{-32603,500} → InternalBackendException; altrimenti ClientException.

### Callback server (CCU → noi) — `node:http`, parse/serialize UTF-8
- Method-not-found → Fault -32601; eccezione handler → Fault -32603. **Return `null`/`undefined` → serializza `true`** (Homematic vuole un ack).
- Firme (ordine arg esatto):
  - `event(interfaceId, channelAddress, parameter, value)` → true
  - `newDevices(interfaceId, deviceDescriptions: dict[])` → true
  - `deleteDevices(interfaceId, addresses: string[])` → true
  - `updateDevice(interfaceId, address, hint: number)` → true (hint 0=FIRMWARE, 1=LINKS)
  - `replaceDevice(interfaceId, oldAddress, newAddress)` → true
  - `readdedDevice(interfaceId, addresses: string[])` → true
  - `listDevices(interfaceId)` → `dict[]` (o `[]`)
  - `error(interfaceId, errorCode, msg)` → true
  - `system.listMethods()` → string[]; `system.methodHelp(name)`; `system.multicall(calls)` → list (ogni call `{methodName, params}`; successo `[result]`, fallimento `{faultCode, faultString}`).

### Resilienza
- **Circuit breaker:** stati CLOSED/OPEN/HALF_OPEN; `failureThreshold=5`, `recoveryTimeout=30s`, `successThreshold=2`. CLOSED→OPEN a failure≥threshold; OPEN→HALF_OPEN dopo recoveryTimeout; HALF_OPEN→CLOSED dopo successThreshold successi, qualsiasi failure in HALF_OPEN→OPEN. Bypass XML-RPC: {getVersion, clientServerInitialized, init, ping, system.listMethods}; bypass JSON: {Session.login, Session.logout, Session.renew}. Chiamata non-bypass su breaker OPEN → CircuitBreakerOpenException.
- **Retry** (su setValue/putParamset): non-retryable {AuthFailure, CircuitBreakerOpen, CommandSuperseded, Unsupported, Validation}; retryable {TimeoutError, NoConnection, InternalBackend, fault∈{-1,-8,-9,-10}}. `maxAttempts=3`, `baseDelay=2s`, `backoffFactor=2`, `maxDelay=30s`, jitter ±20%. Fault -8 (dutyCycle) delay 40s; fault -10 (transmission pending) delay 5s. maxAttempts≤0 disabilita.
- **Throttle:** coda a priorità CRITICAL/HIGH/LOW; `interval=0` (off default), `burstThreshold=5`, `burstWindow=0.5s` (HIGH→LOW in burst); CRITICAL bypassa.
- **Request coalescer:** dedup chiamate async identiche; chiave = `method + ":" + args.join(":")` (dict con chiavi ordinate), es. `getParamset:VCU001:1:VALUES`. Prima chiamata crea una Promise in `_pending`; le successive identiche l'attendono; entry rimossa nel finally. Nessun TTL.
- **State machine:** stati CREATED, INITIALIZING, INITIALIZED, CONNECTING, CONNECTED, DISCONNECTED, RECONNECTING, STOPPING, STOPPED, FAILED. Transizioni valide (vedi tabella sotto). `transitionTo(target, reason)` valida; emette evento `clientStateChanged`. Reconnect: `initialDelay=2`, `maxDelay=120`, `backoffFactor=2`; delay = `min(initialDelay*backoff^attempts, maxDelay)`. Timeout: rpc 60s, ping 10s.
- Tabella transizioni: CREATED→{INITIALIZING}; INITIALIZING→{INITIALIZED,FAILED}; INITIALIZED→{CONNECTING,DISCONNECTED}; CONNECTING→{CONNECTED,FAILED}; CONNECTED→{DISCONNECTED,RECONNECTING,STOPPING}; DISCONNECTED→{CONNECTING,DISCONNECTED,RECONNECTING,STOPPING}; RECONNECTING→{CONNECTED,DISCONNECTED,FAILED,CONNECTING}; STOPPING→{STOPPED}; STOPPED→{}; FAILED→{INITIALIZING,CONNECTING,RECONNECTING,DISCONNECTED}.

### Errori (`support/errors.ts`)
Gerarchia su `BaseHomematicError`: `ClientError`, `UnsupportedError`, `ValidationError`, `NoConnectionError`, `CircuitBreakerOpenError`, `NoClientsError`, `AuthFailureError`, `InternalBackendError`, `CommandSupersededError`, `DescriptionNotFoundError`. Mapper: `mapXmlRpcFault(code, faultString)` (per STRINGA: "unauthorized"→AuthFailure, "internal"→InternalBackend, else Client); `mapJsonRpcError(error)` (vedi sopra); `mapTransportError(err)` (OSError-like→NoConnection, else Client). `exceptionToFailureReason`: Auth→AUTH, NoConnection→NETWORK, InternalBackend→INTERNAL, CircuitBreakerOpen→CIRCUIT_BREAKER, Timeout→TIMEOUT, else UNKNOWN.

---

## File structure (Fase 1)

```
src/support/
  errors.ts            # tassonomia + mapper
  constants.ts         # Interface enum, porte, paths, encoding, default timeouts
  logger.ts            # logger minimale iniettabile (no dep), redazione segreti
src/transport/xmlrpc/
  types.ts             # XmlRpcValue, DeviceDescription, ParameterData, Fault
  serialize.ts         # value/array/struct → XML (ISO-8859-1), tag i4/double/boolean/string/dateTime/base64/nil
  parse.ts             # XML → value (UTF-8 e ISO-8859-1), methodResponse/fault/methodCall
  fault-codes.ts       # XmlRpcFaultCode enum + retryable set + mapping helper
  client.ts            # XmlRpcClient: call(method, params), auth Basic, TLS, timeout; usa serialize/parse + undici
src/transport/jsonrpc/
  client.ts            # JsonRpcClient: post(method, params), envelope, semaforo conc.
  session.ts           # SessionManager: login/renew/logout, backoff, session-age
  methods.ts           # costanti nomi metodi + key param
src/transport/callback-server/
  server.ts            # CallbackServer: node:http, parse/serialize UTF-8, dispatch, null→true, multicall
  handlers.ts          # mappa metodo→handler che normalizza in RawCallbackEvent
  events.ts            # tipi RawCallbackEvent (event/newDevices/deleteDevices/updateDevice/...)
src/transport/resilience/
  circuit-breaker.ts
  retry.ts
  throttle.ts
  coalescer.ts
  state-machine.ts
src/transport/
  interface-client.ts  # compone client+resilienza+state machine; init/deinit/ping; metodi raw CCU
tests/
  unit/transport/...   # per ogni modulo
  integration/fake-ccu/ # finto CCU XML-RPC+JSON-RPC in-process + test ciclo init/event
  fixtures/             # payload XML-RPC/JSON-RPC reali registrati
```

---

## Tasks (TDD per modulo — RED → GREEN → commit)

### Task 1: `support/errors.ts` + `support/constants.ts`
**Files:** Create `src/support/errors.ts`, `src/support/constants.ts`; Test `tests/unit/support/errors.test.ts`.
- TDD: testare che ogni classe estende `BaseHomematicError` e ha `name` corretto; `mapXmlRpcFault(-1,"unauthorized access")` → `AuthFailureError`; `mapXmlRpcFault(0,"internal blah")` → `InternalBackendError`; `mapXmlRpcFault(0,"weird")` → `ClientError`; `mapJsonRpcError({code:-32001,message:"access denied"})` → `AuthFailureError`; `mapJsonRpcError({code:-32603})` → `InternalBackendError`; `exceptionToFailureReason(new NoConnectionError())` → `"NETWORK"`.
- `constants.ts`: `Interface` (string enum), `INTERFACE_PORTS` map → {nonTls, tls}, `JSON_RPC_PATH="/api/homematic.cgi"`, `ENCODING_OUT="iso-8859-1"`, `ENCODING_IN="utf-8"`, default `TIMEOUTS` (rpc 60000, ping 10000, etc.), `interfaceId(centralName, iface)` helper.
- Commit: `feat(transport): error taxonomy + protocol constants`.

### Task 2: XML-RPC serialize/parse (`xmlrpc/types.ts`, `serialize.ts`, `parse.ts`, `fault-codes.ts`)
**Files:** Create the four files; Test `tests/unit/transport/xmlrpc/{serialize,parse}.test.ts`.
- TDD serialize: `serializeMethodCall("getValue", ["VCU001:1","STATE"])` → XML con `<methodCall><methodName>getValue</methodName><params>...`; int→`<i4>`, float→`<double>`, bool→`<boolean>1/0`, string→`<string>` (escaping & encoding ISO-8859-1 per caratteri accentati), array→`<array><data>`, struct (object)→`<struct><member><name>`, null→`<nil/>`. Verificare l'header XML con encoding iso-8859-1.
- TDD parse: parse di `<methodResponse><params>` ritorna il valore JS corretto per ogni tipo (i4/i8/int→number, double→number, boolean→bool, string, array, struct, dateTime.iso8601→string o Date, base64). Parse di `<methodResponse><fault>` ritorna/throwa un oggetto `{faultCode, faultString}`. Parse di un `<methodCall>` (per il callback server) ritorna `{methodName, params}`. Tolleranza all'assenza di tag tipo (default string). Empty body → errore dedicato.
- `fault-codes.ts`: enum + `RETRYABLE_FAULT_CODES = new Set([-1,-8,-9,-10])`.
- Commit: `feat(transport): XML-RPC serializer/parser con quirk Homematic`.

### Task 3: `xmlrpc/client.ts`
**Files:** Create `src/transport/xmlrpc/client.ts`; Test `tests/unit/transport/xmlrpc/client.test.ts` (con un server http locale effimero o undici MockAgent).
- `XmlRpcClient({url, auth?, tls?, timeoutMs})` con metodo `call(method: string, params: XmlRpcValue[]): Promise<XmlRpcValue>`. POST body = serializeMethodCall, header `Content-Type: text/xml`, Basic auth se presente, timeout, parse della risposta; su `<fault>` → throw via `mapXmlRpcFault`; su errore di rete → `NoConnectionError`; su body vuoto → `ClientError`.
- TDD: server di test risponde con methodResponse → ritorna valore; risponde con fault unauthorized → throw AuthFailureError; non risponde/refused → NoConnectionError; body vuoto → ClientError.
- Commit: `feat(transport): XML-RPC client (auth/TLS/timeout/fault mapping)`.

### Task 4: callback server (`callback-server/events.ts`, `handlers.ts`, `server.ts`)
**Files:** Create the three files; Test `tests/unit/transport/callback-server/server.test.ts`.
- `RawCallbackEvent` discriminated union: `{type:'event', interfaceId, channelAddress, parameter, value}`, `{type:'newDevices', interfaceId, descriptions}`, `{type:'deleteDevices', interfaceId, addresses}`, `{type:'updateDevice', interfaceId, address, hint}`, `{type:'replaceDevice',...}`, `{type:'readdedDevice',...}`, `{type:'error', interfaceId, code, message}`.
- `CallbackServer` su `node:http`: ascolta su host/port, parse del `<methodCall>` (UTF-8), dispatch; `listDevices` ritorna l'elenco fornito da un provider iniettato (default `[]`); altri metodi noti emettono un `RawCallbackEvent` via callback `onEvent` e ritornano `true`; metodo ignoto → Fault -32601; eccezione → Fault -32603; `null`/`undefined` → serializza `true`; `system.multicall` itera le call. Espone `start()/stop()/port`.
- TDD: POST di un `event(...)` methodCall → `onEvent` riceve l'evento corretto e la risposta XML è `<boolean>1`; `system.multicall` con 2 call → risposta array; metodo sconosciuto → fault -32601.
- Commit: `feat(transport): XML-RPC callback server (event normalization, multicall)`.

### Task 5: JSON-RPC (`jsonrpc/methods.ts`, `client.ts`, `session.ts`)
**Files:** Create the three files; Test `tests/unit/transport/jsonrpc/{client,session}.test.ts`.
- `JsonRpcClient({url, tls?, maxConcurrent=3})`: `post(method, params, {useSession=true}): Promise<unknown>` costruisce envelope `{method, params: stringifyParams(params), jsonrpc:"1.1", id:0}`, semaforo di concorrenza, parse `{result,error}`, su `error` truthy → `mapJsonRpcError`. `stringifyParams` → tutte le chiavi/valori a stringa, inietta `_session_id_` se sessione attiva e useSession.
- `SessionManager`: `login(user,pass)`, `renew()`, `logout()`, `ensureSession()`; rate-limit login (max 10, backoff 1→60 ×2), `JSON_SESSION_AGE=90s` (skip renew recente); su AuthFailure in renew → logout+login.
- TDD (undici MockAgent o server effimero): login ok → sessionId memorizzato; post inietta `_session_id_`; risposta con `error.message="access denied: ..."` → AuthFailureError; renew entro 90s → no-op.
- Commit: `feat(transport): JSON-RPC client + session manager`.

### Task 6: resilienza (`resilience/circuit-breaker.ts`, `retry.ts`, `throttle.ts`, `coalescer.ts`, `state-machine.ts`)
**Files:** Create the five files; Test uno per file in `tests/unit/transport/resilience/`.
- Usare timer fake di vitest (`vi.useFakeTimers()`), niente sleep reali.
- **circuit-breaker:** `CircuitBreaker(config)` con `isAvailable()`, `recordSuccess()`, `recordFailure()`, `recordRejection()`, `state`. TDD le transizioni dei fatti di protocollo (5 failure→OPEN; dopo 30s→HALF_OPEN; 2 successi→CLOSED; failure in HALF_OPEN→OPEN).
- **retry:** `withRetry(fn, config, {isRetryable})` backoff esponenziale + jitter; classificazione retryable/non-retryable e delay speciali fault -8/-10. TDD: errore retryable riprova fino a maxAttempts poi rilancia; non-retryable rilancia subito; successo al 2° tentativo ok.
- **throttle:** coda priorità; con `interval=0` passa subito; CRITICAL bypassa. TDD base ordine/bypass.
- **coalescer:** `coalesce(key, fn)`; due chiamate concorrenti stessa key → `fn` invocata una volta, entrambe ottengono lo stesso risultato; dopo il completamento la key è di nuovo libera; errore propagato a tutti gli attendenti. `makeKey(method, args)`.
- **state-machine:** `ConnectionStateMachine(initial=CREATED)` con `transitionTo(target, reason?)` che valida contro la tabella e throwa su transizione invalida; `onChange(cb)`; `reconnectDelay(attempt)` = min(2*2^attempt,120)*1000. TDD: transizione valida ok+evento; invalida throwa.
- Commit (uno per file o raggruppati per coerenza): `feat(transport): resilience primitives (circuit breaker, retry, throttle, coalescer, state machine)`.

### Task 7: `interface-client.ts`
**Files:** Create `src/transport/interface-client.ts`; Test `tests/unit/transport/interface-client.test.ts`.
- `InterfaceClient({centralName, interface, host, port, tls?, auth?, callbackUrlProvider, circuitBreaker, ...})` compone: `XmlRpcClient` (read+write), state machine, circuit breaker, retry/coalescer. Espone i metodi raw CCU tipizzati: `initProxy()` → `init(callbackUrl, interfaceId)`; `deinitProxy()` → `init(callbackUrl)`; `ping()`; `listDevices()`; `getDeviceDescription(addr)` (coalesced); `getParamsetDescription(addr, key)` (coalesced); `getParamset`; `getValue`; `setValue` (retry); `putParamset` (retry); `getInstallMode`. `interfaceId = "{centralName}-{interface}"`. Le chiamate bypass-breaker (init/ping/listMethods/getVersion) non passano dal breaker. Aggiorna lo stato della state machine su connect/disconnect.
- TDD con un finto XmlRpcClient mockato: `initProxy` chiama `init` con `(callbackUrl, "{centralName}-{interface}")`; `deinitProxy` chiama `init(callbackUrl)`; `setValue` su errore -8 ritenta; `getDeviceDescription` chiamato 2× concorrente → 1 sola call sottostante.
- Commit: `feat(transport): InterfaceClient compone proxy + resilienza + state machine`.

### Task 8: finto CCU + integration test
**Files:** Create `tests/integration/fake-ccu/fake-ccu.ts` (HTTP server che risponde a XML-RPC `listDevices`/`getDeviceDescription`/`getValue`/`setValue`/`init`/`ping`/`system.listMethods` e JSON-RPC `Session.login`/`Device.listAllDetail`/`Room.getAll` con fixture), e `tests/integration/transport-cycle.test.ts`.
- TDD ciclo end-to-end senza hardware: avvia fake-ccu + CallbackServer + InterfaceClient; `initProxy()` registra; il fake-ccu invia un `event(...)` al CallbackServer; verifica che l'evento normalizzato arrivi via `onEvent`; `setValue` raggiunge il fake-ccu; `deinitProxy()` de-registra. Verifica anche un giro JSON-RPC (login + listAllDetail).
- Commit: `test(transport): finto CCU in-process + ciclo init/event/setValue`.

---

## Gate finale Fase 1
`npm run lint && npm run format:check && npm run typecheck && npm run test:cov && npm run build` verde, coverage ≥ 80%.

## Dipendenze npm da aggiungere
- runtime: `fast-xml-parser` (parse XML), `undici` (HTTP; o fetch nativo Node 20). `iconv-lite` se serve encoding ISO-8859-1 robusto in serializzazione/parse (valutare; Node `Buffer`/`TextDecoder` supporta `latin1`).

## Self-review (post-stesura)
- Copertura spec §3 transport: XML-RPC client (Task 2-3), callback server (Task 4), JSON-RPC (Task 5), resilienza (Task 6), interface-client (Task 7), finto CCU/test (Task 8), errori/costanti (Task 1). ✅
- Reconnect "rock-solid": la state machine + reconnectDelay + circuit breaker sono qui; la LOGICA di orchestrazione del reconnect (health-ping loop, re-init, re-sync) vive in Fase 2 (central), che usa questi primitivi. Annotato.
