# nodehomematic — Phase 1: Transport Implementation Plan

> **For agentic workers:** Implement module-by-module with TDD (test first, RED, GREEN, refactor). Frequent commits. The transport layer has NO domain logic — it speaks raw CCU methods and emits raw normalized events.

**Goal:** Implement the communication layer toward a CCU3/RaspberryMatic: XML-RPC client (+ serializer/parser with the Homematic quirks), XML-RPC callback server, JSON-RPC client (session), error taxonomy, and the resilience primitives (circuit-breaker, retry, throttle, request-coalescer, state machine), plus an `InterfaceClient` that composes them. Validated with unit tests and an in-process fake CCU. NO hardware.

**Architecture:** Everything under `src/transport/` + `src/support/errors.ts`. Each module is isolated behind a narrow interface. No dependency on `model`/`central`. Conformance to the protocol facts extracted from the aiohomematic source (see the "Protocol facts" section).

**Tech Stack:** strict TypeScript, Node 20+. XML-RPC: custom serializer/parser on `fast-xml-parser` (to control ISO-8859-1 outbound / UTF-8 inbound encoding and the type tags). HTTP: `undici`/native fetch. Callback server: `node:http`. Tests: vitest.

---

## Protocol facts (authoritative, from the aiohomematic `devel` source)

### Interfaces and ports (`const.py`)
- `BidCos-RF` → (2001, 42001 TLS); `HmIP-RF` → (2010, 42010); `BidCos-Wired` → (2000, 42000); `VirtualDevices` → (9292, 49292).
- JSON-RPC: 80 (TLS 443). JSON-RPC path: `/api/homematic.cgi`.
- `Backend`: CCU | Homegear | PyDevCCU. Encoding: outbound XML-RPC **ISO-8859-1**, inbound callback server **UTF-8**.

### XML-RPC client → CCU (POSITIONAL arguments, exact order)
- `init(initUrl, interfaceId)` registers the callback; `init(initUrl)` (ONE arg only) de-registers.
- `ping(callerId)` → bool (the CCU responds with a `pong`/event callback). `callerId = "{interfaceId}#{token}"`, token = timestamp.
- `listDevices()` → `DeviceDescription[]`.
- `getDeviceDescription(address)` → `DeviceDescription`.
- `getParamsetDescription(channelAddress, paramsetKey)` → `Record<string, ParameterData>`; paramsetKey ∈ `VALUES|MASTER|LINK`.
- `getParamset(channelAddress, paramsetKey)` → dict.
- `getValue(channelAddress, parameter)` → any.
- `setValue(channelAddress, parameter, value)` (+ optional `rxMode`).
- `putParamset(channelAddress, paramsetKey, values)` (+ optional `rxMode`).
- `getInstallMode()` → int; `setInstallMode(on, time, mode)` o `setInstallMode(on, time, deviceAddress)`.
- `system.listMethods()` → string[]. `getVersion()` (probe). Homegear probe: `clientServerInitialized`.
- `interfaceId = "{centralName}-{interface}"` (e.g. `MyCCU-HmIP-RF`). Init URL: `http://{callbackHost}:{callbackPort}` (always http, no path).
- Fault code IntEnum: GENERIC -1, UNKNOWN_DEVICE -2, UNKNOWN_PARAMSET -3, ADDRESS_EXPECTED -4, UNKNOWN_PARAMETER -5, OP_NOT_SUPPORTED -6, UPDATE_NOT_POSSIBLE -7, INSUFFICIENT_DUTYCYCLE -8, DEVICE_OUT_OF_RANGE -9, TRANSMISSION_PENDING -10. Retryable: {-1,-8,-9,-10}. Empty body (HTTP 200, no XML) → ClientException.

### JSON-RPC client → CCU WebUI
- POST `/api/homematic.cgi`, envelope `{"method", "params", "jsonrpc": "1.1", "id": 0}`. **All param values stringified** (`String(value)`). Session id injected as the `_session_id_` param when `useDefaultParams`.
- Response `{"result", "error", "id"}` (UTF-8). On error: `error` truthy.
- Session: `Session.login{username,password}` → result = sessionId; `Session.renew{_session_id_}` (result===true → ok); `Session.logout{_session_id_}`. Login rate-limit: max 10 failed attempts, backoff 1s→60s ×2. `JSON_SESSION_AGE=90`s (skip renew if recently refreshed). The 3 Session.* methods bypass the circuit breaker. HTTP concurrency: semaphore `MAX_CONCURRENT_HTTP_SESSIONS=3`.
- Methods (exact names): `CCU.getAuthEnabled`, `CCU.getHttpsRedirectEnabled`, `Device.listAllDetail`, `Device.setName`, `Channel.setName`, `Interface.listInterfaces`, `Interface.listDevices(interface)`, `Interface.getInstallMode(interface)`, `Interface.setInstallModeHMIP(interface,on,time,installMode,address,...)` (replaces XML-RPC setInstallMode ONLY for HmIP-RF), `Program.getAll`, `Program.execute(id)`, `SysVar.getAll`, `SysVar.getValueByName(name)`, `SysVar.setBool`, `SysVar.setFloat`, `Room.getAll`, `Subsection.getAll`, `ReGa.runScript(script)`, `system.listMethods`.
- Error mapping (by message CONTENT): `startsWith("access denied")` or code∈{401,-32001} → AuthFailure; `"internal error"` or code∈{-32603,500} → InternalBackendException; otherwise ClientException.

### Callback server (CCU → us) — `node:http`, UTF-8 parse/serialize
- Method-not-found → Fault -32601; handler exception → Fault -32603. **Return `null`/`undefined` → serialize `true`** (Homematic wants an ack).
- Signatures (exact arg order):
  - `event(interfaceId, channelAddress, parameter, value)` → true
  - `newDevices(interfaceId, deviceDescriptions: dict[])` → true
  - `deleteDevices(interfaceId, addresses: string[])` → true
  - `updateDevice(interfaceId, address, hint: number)` → true (hint 0=FIRMWARE, 1=LINKS)
  - `replaceDevice(interfaceId, oldAddress, newAddress)` → true
  - `readdedDevice(interfaceId, addresses: string[])` → true
  - `listDevices(interfaceId)` → `dict[]` (o `[]`)
  - `error(interfaceId, errorCode, msg)` → true
  - `system.listMethods()` → string[]; `system.methodHelp(name)`; `system.multicall(calls)` → list (each call `{methodName, params}`; success `[result]`, failure `{faultCode, faultString}`).

### Resilience
- **Circuit breaker:** states CLOSED/OPEN/HALF_OPEN; `failureThreshold=5`, `recoveryTimeout=30s`, `successThreshold=2`. CLOSED→OPEN at failures≥threshold; OPEN→HALF_OPEN after recoveryTimeout; HALF_OPEN→CLOSED after successThreshold successes, any failure in HALF_OPEN→OPEN. XML-RPC bypass: {getVersion, clientServerInitialized, init, ping, system.listMethods}; JSON bypass: {Session.login, Session.logout, Session.renew}. Non-bypass call on an OPEN breaker → CircuitBreakerOpenException.
- **Retry** (on setValue/putParamset): non-retryable {AuthFailure, CircuitBreakerOpen, CommandSuperseded, Unsupported, Validation}; retryable {TimeoutError, NoConnection, InternalBackend, fault∈{-1,-8,-9,-10}}. `maxAttempts=3`, `baseDelay=2s`, `backoffFactor=2`, `maxDelay=30s`, jitter ±20%. Fault -8 (dutyCycle) delay 40s; fault -10 (transmission pending) delay 5s. maxAttempts≤0 disables it.
- **Throttle:** CRITICAL/HIGH/LOW priority queue; `interval=0` (off by default), `burstThreshold=5`, `burstWindow=0.5s` (HIGH→LOW under burst); CRITICAL bypasses.
- **Request coalescer:** dedup identical async calls; key = `method + ":" + args.join(":")` (dict with ordered keys), e.g. `getParamset:VCU001:1:VALUES`. The first call creates a Promise in `_pending`; subsequent identical ones await it; the entry is removed in the finally. No TTL.
- **State machine:** states CREATED, INITIALIZING, INITIALIZED, CONNECTING, CONNECTED, DISCONNECTED, RECONNECTING, STOPPING, STOPPED, FAILED. Valid transitions (see the table below). `transitionTo(target, reason)` validates; emits a `clientStateChanged` event. Reconnect: `initialDelay=2`, `maxDelay=120`, `backoffFactor=2`; delay = `min(initialDelay*backoff^attempts, maxDelay)`. Timeouts: rpc 60s, ping 10s.
- Transition table: CREATED→{INITIALIZING}; INITIALIZING→{INITIALIZED,FAILED}; INITIALIZED→{CONNECTING,DISCONNECTED}; CONNECTING→{CONNECTED,FAILED}; CONNECTED→{DISCONNECTED,RECONNECTING,STOPPING}; DISCONNECTED→{CONNECTING,DISCONNECTED,RECONNECTING,STOPPING}; RECONNECTING→{CONNECTED,DISCONNECTED,FAILED,CONNECTING}; STOPPING→{STOPPED}; STOPPED→{}; FAILED→{INITIALIZING,CONNECTING,RECONNECTING,DISCONNECTED}.

### Errors (`support/errors.ts`)
Hierarchy on `BaseHomematicError`: `ClientError`, `UnsupportedError`, `ValidationError`, `NoConnectionError`, `CircuitBreakerOpenError`, `NoClientsError`, `AuthFailureError`, `InternalBackendError`, `CommandSupersededError`, `DescriptionNotFoundError`. Mappers: `mapXmlRpcFault(code, faultString)` (by STRING: "unauthorized"→AuthFailure, "internal"→InternalBackend, else Client); `mapJsonRpcError(error)` (see above); `mapTransportError(err)` (OSError-like→NoConnection, else Client). `exceptionToFailureReason`: Auth→AUTH, NoConnection→NETWORK, InternalBackend→INTERNAL, CircuitBreakerOpen→CIRCUIT_BREAKER, Timeout→TIMEOUT, else UNKNOWN.

---

## File structure (Phase 1)

```
src/support/
  errors.ts            # taxonomy + mappers
  constants.ts         # Interface enum, ports, paths, encoding, default timeouts
  logger.ts            # minimal injectable logger (no deps), secret redaction
src/transport/xmlrpc/
  types.ts             # XmlRpcValue, DeviceDescription, ParameterData, Fault
  serialize.ts         # value/array/struct → XML (ISO-8859-1), tags i4/double/boolean/string/dateTime/base64/nil
  parse.ts             # XML → value (UTF-8 and ISO-8859-1), methodResponse/fault/methodCall
  fault-codes.ts       # XmlRpcFaultCode enum + retryable set + mapping helper
  client.ts            # XmlRpcClient: call(method, params), Basic auth, TLS, timeout; uses serialize/parse + undici
src/transport/jsonrpc/
  client.ts            # JsonRpcClient: post(method, params), envelope, concurrency semaphore
  session.ts           # SessionManager: login/renew/logout, backoff, session-age
  methods.ts           # method-name constants + param keys
src/transport/callback-server/
  server.ts            # CallbackServer: node:http, parse/serialize UTF-8, dispatch, null→true, multicall
  handlers.ts          # method→handler map that normalizes into RawCallbackEvent
  events.ts            # RawCallbackEvent types (event/newDevices/deleteDevices/updateDevice/...)
src/transport/resilience/
  circuit-breaker.ts
  retry.ts
  throttle.ts
  coalescer.ts
  state-machine.ts
src/transport/
  interface-client.ts  # composes client+resilience+state machine; init/deinit/ping; raw CCU methods
tests/
  unit/transport/...   # one per module
  integration/fake-ccu/ # in-process fake CCU XML-RPC+JSON-RPC + init/event cycle test
  fixtures/             # real recorded XML-RPC/JSON-RPC payloads
```

---

## Tasks (TDD per module — RED → GREEN → commit)

### Task 1: `support/errors.ts` + `support/constants.ts`
**Files:** Create `src/support/errors.ts`, `src/support/constants.ts`; Test `tests/unit/support/errors.test.ts`.
- TDD: test that each class extends `BaseHomematicError` and has the correct `name`; `mapXmlRpcFault(-1,"unauthorized access")` → `AuthFailureError`; `mapXmlRpcFault(0,"internal blah")` → `InternalBackendError`; `mapXmlRpcFault(0,"weird")` → `ClientError`; `mapJsonRpcError({code:-32001,message:"access denied"})` → `AuthFailureError`; `mapJsonRpcError({code:-32603})` → `InternalBackendError`; `exceptionToFailureReason(new NoConnectionError())` → `"NETWORK"`.
- `constants.ts`: `Interface` (string enum), `INTERFACE_PORTS` map → {nonTls, tls}, `JSON_RPC_PATH="/api/homematic.cgi"`, `ENCODING_OUT="iso-8859-1"`, `ENCODING_IN="utf-8"`, default `TIMEOUTS` (rpc 60000, ping 10000, etc.), `interfaceId(centralName, iface)` helper.
- Commit: `feat(transport): error taxonomy + protocol constants`.

### Task 2: XML-RPC serialize/parse (`xmlrpc/types.ts`, `serialize.ts`, `parse.ts`, `fault-codes.ts`)
**Files:** Create the four files; Test `tests/unit/transport/xmlrpc/{serialize,parse}.test.ts`.
- TDD serialize: `serializeMethodCall("getValue", ["VCU001:1","STATE"])` → XML with `<methodCall><methodName>getValue</methodName><params>...`; int→`<i4>`, float→`<double>`, bool→`<boolean>1/0`, string→`<string>` (escaping & ISO-8859-1 encoding for accented characters), array→`<array><data>`, struct (object)→`<struct><member><name>`, null→`<nil/>`. Verify the XML header with iso-8859-1 encoding.
- TDD parse: parsing `<methodResponse><params>` returns the correct JS value for each type (i4/i8/int→number, double→number, boolean→bool, string, array, struct, dateTime.iso8601→string or Date, base64). Parsing `<methodResponse><fault>` returns/throws a `{faultCode, faultString}` object. Parsing a `<methodCall>` (for the callback server) returns `{methodName, params}`. Tolerance for missing type tags (default string). Empty body → dedicated error.
- `fault-codes.ts`: enum + `RETRYABLE_FAULT_CODES = new Set([-1,-8,-9,-10])`.
- Commit: `feat(transport): XML-RPC serializer/parser with Homematic quirks`.

### Task 3: `xmlrpc/client.ts`
**Files:** Create `src/transport/xmlrpc/client.ts`; Test `tests/unit/transport/xmlrpc/client.test.ts` (with an ephemeral local http server or undici MockAgent).
- `XmlRpcClient({url, auth?, tls?, timeoutMs})` with method `call(method: string, params: XmlRpcValue[]): Promise<XmlRpcValue>`. POST body = serializeMethodCall, header `Content-Type: text/xml`, Basic auth if present, timeout, parse the response; on `<fault>` → throw via `mapXmlRpcFault`; on network error → `NoConnectionError`; on empty body → `ClientError`.
- TDD: test server responds with methodResponse → returns value; responds with unauthorized fault → throw AuthFailureError; no response/refused → NoConnectionError; empty body → ClientError.
- Commit: `feat(transport): XML-RPC client (auth/TLS/timeout/fault mapping)`.

### Task 4: callback server (`callback-server/events.ts`, `handlers.ts`, `server.ts`)
**Files:** Create the three files; Test `tests/unit/transport/callback-server/server.test.ts`.
- `RawCallbackEvent` discriminated union: `{type:'event', interfaceId, channelAddress, parameter, value}`, `{type:'newDevices', interfaceId, descriptions}`, `{type:'deleteDevices', interfaceId, addresses}`, `{type:'updateDevice', interfaceId, address, hint}`, `{type:'replaceDevice',...}`, `{type:'readdedDevice',...}`, `{type:'error', interfaceId, code, message}`.
- `CallbackServer` on `node:http`: listens on host/port, parses the `<methodCall>` (UTF-8), dispatch; `listDevices` returns the list provided by an injected provider (default `[]`); other known methods emit a `RawCallbackEvent` via the `onEvent` callback and return `true`; unknown method → Fault -32601; exception → Fault -32603; `null`/`undefined` → serialize `true`; `system.multicall` iterates the calls. Exposes `start()/stop()/port`.
- TDD: POST of an `event(...)` methodCall → `onEvent` receives the correct event and the XML response is `<boolean>1`; `system.multicall` with 2 calls → array response; unknown method → fault -32601.
- Commit: `feat(transport): XML-RPC callback server (event normalization, multicall)`.

### Task 5: JSON-RPC (`jsonrpc/methods.ts`, `client.ts`, `session.ts`)
**Files:** Create the three files; Test `tests/unit/transport/jsonrpc/{client,session}.test.ts`.
- `JsonRpcClient({url, tls?, maxConcurrent=3})`: `post(method, params, {useSession=true}): Promise<unknown>` builds the envelope `{method, params: stringifyParams(params), jsonrpc:"1.1", id:0}`, concurrency semaphore, parse `{result,error}`, on truthy `error` → `mapJsonRpcError`. `stringifyParams` → all keys/values to string, injects `_session_id_` if a session is active and useSession.
- `SessionManager`: `login(user,pass)`, `renew()`, `logout()`, `ensureSession()`; login rate-limit (max 10, backoff 1→60 ×2), `JSON_SESSION_AGE=90s` (skip recent renew); on AuthFailure during renew → logout+login.
- TDD (undici MockAgent or ephemeral server): login ok → sessionId stored; post injects `_session_id_`; response with `error.message="access denied: ..."` → AuthFailureError; renew within 90s → no-op.
- Commit: `feat(transport): JSON-RPC client + session manager`.

### Task 6: resilience (`resilience/circuit-breaker.ts`, `retry.ts`, `throttle.ts`, `coalescer.ts`, `state-machine.ts`)
**Files:** Create the five files; Test one per file in `tests/unit/transport/resilience/`.
- Use vitest fake timers (`vi.useFakeTimers()`), no real sleeps.
- **circuit-breaker:** `CircuitBreaker(config)` with `isAvailable()`, `recordSuccess()`, `recordFailure()`, `recordRejection()`, `state`. TDD the protocol-fact transitions (5 failures→OPEN; after 30s→HALF_OPEN; 2 successes→CLOSED; failure in HALF_OPEN→OPEN).
- **retry:** `withRetry(fn, config, {isRetryable})` exponential backoff + jitter; retryable/non-retryable classification and special fault -8/-10 delays. TDD: a retryable error retries up to maxAttempts then rethrows; non-retryable rethrows immediately; success on the 2nd attempt is fine.
- **throttle:** priority queue; with `interval=0` it passes immediately; CRITICAL bypasses. Basic order/bypass TDD.
- **coalescer:** `coalesce(key, fn)`; two concurrent calls with the same key → `fn` invoked once, both get the same result; after completion the key is free again; error propagated to all waiters. `makeKey(method, args)`.
- **state-machine:** `ConnectionStateMachine(initial=CREATED)` with `transitionTo(target, reason?)` that validates against the table and throws on an invalid transition; `onChange(cb)`; `reconnectDelay(attempt)` = min(2*2^attempt,120)*1000. TDD: valid transition ok+event; invalid throws.
- Commit (one per file or grouped for coherence): `feat(transport): resilience primitives (circuit breaker, retry, throttle, coalescer, state machine)`.

### Task 7: `interface-client.ts`
**Files:** Create `src/transport/interface-client.ts`; Test `tests/unit/transport/interface-client.test.ts`.
- `InterfaceClient({centralName, interface, host, port, tls?, auth?, callbackUrlProvider, circuitBreaker, ...})` composes: `XmlRpcClient` (read+write), state machine, circuit breaker, retry/coalescer. Exposes the typed raw CCU methods: `initProxy()` → `init(callbackUrl, interfaceId)`; `deinitProxy()` → `init(callbackUrl)`; `ping()`; `listDevices()`; `getDeviceDescription(addr)` (coalesced); `getParamsetDescription(addr, key)` (coalesced); `getParamset`; `getValue`; `setValue` (retry); `putParamset` (retry); `getInstallMode`. `interfaceId = "{centralName}-{interface}"`. The breaker-bypass calls (init/ping/listMethods/getVersion) do not go through the breaker. Updates the state machine state on connect/disconnect.
- TDD with a mocked fake XmlRpcClient: `initProxy` calls `init` with `(callbackUrl, "{centralName}-{interface}")`; `deinitProxy` calls `init(callbackUrl)`; `setValue` on a -8 error retries; `getDeviceDescription` called 2× concurrently → only 1 underlying call.
- Commit: `feat(transport): InterfaceClient composes proxy + resilience + state machine`.

### Task 8: fake CCU + integration test
**Files:** Create `tests/integration/fake-ccu/fake-ccu.ts` (HTTP server that responds to XML-RPC `listDevices`/`getDeviceDescription`/`getValue`/`setValue`/`init`/`ping`/`system.listMethods` and JSON-RPC `Session.login`/`Device.listAllDetail`/`Room.getAll` with fixtures), and `tests/integration/transport-cycle.test.ts`.
- TDD end-to-end cycle without hardware: start fake-ccu + CallbackServer + InterfaceClient; `initProxy()` registers; the fake-ccu sends an `event(...)` to the CallbackServer; verify that the normalized event arrives via `onEvent`; `setValue` reaches the fake-ccu; `deinitProxy()` de-registers. Also verify a JSON-RPC round-trip (login + listAllDetail).
- Commit: `test(transport): in-process fake CCU + init/event/setValue cycle`.

---

## Phase 1 final gate
`npm run lint && npm run format:check && npm run typecheck && npm run test:cov && npm run build` green, coverage ≥ 80%.

## npm dependencies to add
- runtime: `fast-xml-parser` (XML parse), `undici` (HTTP; or native fetch on Node 20). `iconv-lite` if robust ISO-8859-1 encoding is needed in serialize/parse (to evaluate; Node `Buffer`/`TextDecoder` supports `latin1`).

## Self-review (post-drafting)
- Spec §3 transport coverage: XML-RPC client (Task 2-3), callback server (Task 4), JSON-RPC (Task 5), resilience (Task 6), interface-client (Task 7), fake CCU/test (Task 8), errors/constants (Task 1). ✅
- Reconnect "rock-solid": the state machine + reconnectDelay + circuit breaker are here; the reconnect orchestration LOGIC (health-ping loop, re-init, re-sync) lives in Phase 2 (central), which uses these primitives. Noted.
