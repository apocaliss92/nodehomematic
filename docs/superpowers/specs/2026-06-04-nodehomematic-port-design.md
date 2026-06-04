# nodehomematic — Design (Node.js/TypeScript port of aiohomematic)

- **Date:** 2026-06-04
- **Target repo:** `apocaliss92/nodehomematic`
- **Reference:** [sukramj/aiohomematic](https://github.com/sukramj/aiohomematic) (async Python library, backend of the Home Assistant "Homematic(IP) Local" integration)
- **Status:** approved in brainstorming, ready for writing-plans

## 1. Goal and scope

A **standalone npm** library in **strict TypeScript** that ports `aiohomematic` to Node.js, with the following agreed boundaries:

- **Backend:** only **CCU3 / RaspberryMatic / OpenCCU** (XML-RPC + JSON-RPC). Homegear/CUxD/CCU-Jack out of the initial scope.
- **System-agnostic public API:** an external system (the user's NodeJS app) interacts only with a facade, never with the CCU/XML-RPC details.
- **Functionality:** complete for CCU3 — connection, discovery, generic model + **all custom types** (phased), hub (sysvar/programs).
- **Approach:** layered port **faithful** to aiohomematic (inherits battle-tested decisions), with an idiomatic TS API on top.

### Non-goals (initial)
- Backends other than CCU3/RaspberryMatic.
- Per-device event subscriptions (**a single global stream** is sufficient).
- 1:1 replication of Python decorators/idioms.

## 2. Layered architecture and layout

Single npm package, strict TypeScript, ESM+CJS build via `tsup`, target Node 20+. Small, focused files (200–400 lines, max 800). **Immutable** domain state.

```
src/
  transport/            # communication, no domain logic
    xmlrpc/             # XML-RPC client + parser/serializer (Homematic quirks)
    jsonrpc/            # CCU WebUI JSON-RPC client (auth, names, rooms, programs, sysvars)
    callback-server/    # XML-RPC server that receives push notifications from the CCU
    resilience/         # circuit-breaker, retry, throttle, request-coalescer
    interface-client.ts # one client per interface (BidCos-RF, HmIP-RF, ...)
  central/              # orchestration
    central-unit.ts     # internal facade: client + callback, discovery, reconnect
    device-registry.ts  # source of truth for discovered devices (immutable)
    discovery.ts        # listDevices/getDeviceDescription/getParamsetDescription + JSON-RPC enrichment
    cache/              # persistent cache (device/paramset descriptions, names)
    event-bus.ts        # typed internal event bus
    connection-state.ts / health.ts / scheduler.ts
  model/
    data-point.ts       # base data point
    device.ts / channel.ts
    generic/            # generic data points (per VALUES parameter)
    custom/             # light, switch, cover, climate, lock, ... (phased)
    hub/                # system variables, programs
    calculated/ combined/   # derived (later phase)
  api/                  # system-agnostic PUBLIC API
    homematic.ts        # facade class: connect/listDevices/getValue/setValue
    events.ts           # event types + typed EventEmitter
    types.ts            # Device, Channel, DataPoint, CustomEntity, event payloads
  support/              # constants, errors, logger, validation (zod), optional i18n
  index.ts              # public entrypoint (re-exports only api/)
tests/
  unit/ integration/ fixtures/ e2e/
```

**Public boundary:** `api/` is the only exposed import. `transport`/`central`/`model` are internal.

## 3. Transport layer

No domain logic: it speaks "raw CCU methods" and emits normalized raw events.

### XML-RPC client (`transport/xmlrpc/`)
Toward the CCU interfaces (typical ports: BidCos-RF 2001, HmIP-RF 2010, Virtual/Groups 9292; TLS variants). Methods: `init`, `getDeviceDescription`, `listDevices`, `getParamsetDescription`, `getParamset`, `getValue`, `setValue`, `putParamset`, `system.multicall`, `ping`.
- **Reuse:** start from the npm `xmlrpc` package (client+server) behind our own `RpcProxy`. If Homematic quirks surface (ISO-8859-1 encoding, `i8`/`double` types, `system.multicall`), the internal serializer is replaced with a custom one based on `fast-xml-parser` **without touching the consumers**.

### JSON-RPC client (`transport/jsonrpc/`)
Toward the CCU WebUI (`/api/homematic.cgi`) for what XML-RPC does not offer: `Session.login/logout`, device/channel names, rooms (`Room`), functions (`Subsection`), programs, system variables. `undici`/native fetch, session-id handling with re-login on expiry.

### Callback server (`transport/callback-server/`)
XML-RPC HTTP server invoked by the CCU after `init(callbackUrl, interfaceId)`. Handles `event`, `newDevices`, `deleteDevices`, `updateDevice`, `replaceDevice`, `readdedDevice`, `listDevices`, `system.listMethods`, `system.multicall`. Normalizes every push into internal events on the bus.

### Resilience (`transport/resilience/`)
Composable wrappers around the proxy: **circuit-breaker** per interface, **retry** with backoff on transient errors, **throttle** (command rate-limiting), **request-coalescer** (deduplicates identical concurrent reads).

## 4. Central (orchestration)

`central-unit.ts` ties transport and model together.

- **Lifecycle/connection:** `start()` creates an `InterfaceClient` for each enabled interface, starts the callback server, runs `init` to register the callback URL, and performs proxy-init. `stop()` de-registers with `init(url, "")` and closes cleanly. `connection-state.ts` tracks the per-interface state; `health.ts` does periodic pings; on a drop → backoff, re-`init`, discovery re-sync.
- **Discovery (`discovery.ts`):** `listDevices` → for each device/channel `getDeviceDescription` + `getParamsetDescription` (MASTER/VALUES) → enrichment with names/rooms/functions via JSON-RPC → `Device → Channel → Parameter` graph. `deleteDevices`/`replaceDevice` update the registry immutably.
- **Caching (`cache/`):** **persistent** on-disk cache (configurable path, on by default) of device/paramset descriptions and names; invalidated by firmware/CCU version. Warm start without a full re-discovery.
- **Event bus (`event-bus.ts`):** typed internal bus; receives the normalized raw events from the callback server and dispatches them (data point value, device add/remove, lifecycle, diagnostics). The model subscribes here.
- **device-registry.ts:** immutable source of truth, lookup by address/interface.

## 5. Public API (system-agnostic facade)

Single public import: `nodehomematic`.

```ts
const hm = new Homematic({
  host: '192.168.x.x',
  interfaces: ['HmIP-RF', 'BidCos-RF'],
  credentials: { username, password },     // for JSON-RPC
  callback: { host, port },                // url the CCU calls back
  cache: { dir: '...', enabled: true },    // persistent, on by default
  tls: false,
});

await hm.start();                  // connect, discovery, register callback
await hm.stop();                   // de-register and close cleanly

hm.devices();                      // immutable snapshot of all devices/entities
hm.getValue(dpId);                 // read (from state/cache)
await hm.setValue(dpId, value);    // validated write toward the CCU
await hm.setValue({ device, channel, parameter }, value); // explicit form
```

**Typed global stream** (EventEmitter — no per-device):

```ts
hm.on('valueChanged', (e) => { /* { dpId, device, channel, parameter, value, prevValue, ts } */ });
hm.on('deviceAdded',   (e) => { /* discovered device */ });
hm.on('deviceRemoved', (e) => { /* ... */ });
hm.on('connection',    (e) => { /* { interface, state } */ });
hm.on('ready',         () => { /* initial discovery complete */ });
hm.on('error',         (err) => { /* ... */ });
```

`valueChanged` is the single live stream for **all** connected devices. Outbound updates always go through `setValue` (validated against the data point metadata). Custom entities expose convenient methods (`light.setBrightness(...)`) that internally use the **same** `setValue` path → a single testable write path.

Exported system-agnostic types: `Device`, `Channel`, `DataPoint`, `CustomEntity`, event payloads.

## 6. Model layer

Immutable hierarchy built from discovery, decoupled from transport.

- **Base:** `Device` (address, type/firmware, interface, name/room/function) → `Channel[]` → `DataPoint[]`. `data-point.ts`: stable identity `interface:address:channel:parameter`, paramset metadata (type, min/max, unit, value-list, RO/WO/EVENT flags), current value, timestamp, availability.
- **Generic (`model/generic/`):** one data point per VALUES parameter; read (event/cache) and write (`setValue`/`putParamset`) with validation against the metadata and centralized CCU↔JS type conversion (`converter`). On its own it satisfies "expose everything generically".
- **Custom (`model/custom/`, phased):** typed domain entities that aggregate data points: `Switch`, `Light`, `Cover`/`Blind`, `Climate`, `Lock`, `Siren`, etc. Each has: a recognition rule (by device-type/channels), high-level properties and methods that translate into operations on the underlying data points.
- **Hub (`model/hub/`):** CCU system variables and programs (JSON-RPC) as first-level data points/actions.
- **Calculated/Combined:** derived and combined data points (later phase), with no impact on the public boundary.

Each level subscribes to the event bus, updates the state immutably and re-emits "value changed" toward the facade.

## 7. Testing

TDD, 80%+ coverage, three levels.

- **Unit (vitest):** XML-RPC serializer/parser on real fixtures, resilience (deterministic fake timers), type converter, metadata validation, custom recognition rules, immutable registry reducers.
- **Integration:** in-process **fake CCU** (HTTP responding to XML-RPC + JSON-RPC with fixtures recorded from the real CCU) for the `start → discovery → callback → valueChanged → setValue` cycle, including the callback server that receives `event`/`newDevices`.
- **E2E:** against the real CCU3/RaspberryMatic — smoke (connection, discovery, live events, one safe write). Gated by env (`HM_E2E=1` + credentials), excluded from the public CI.
- **Contract/fixtures:** real payloads captured from the CCU (discovery + some events) versioned as fixtures to align integration and e2e with the real behavior.

## 8. Phased roadmap

- **Phase 0 — Scaffold:** GitHub repo `apocaliss92/nodehomematic`, strict TS, `tsup`, vitest, eslint+prettier, GitHub Actions CI, README, LICENSE, folder structure.
- **Phase 1 — Transport:** XML-RPC client + callback server, JSON-RPC client + session, resilience. Unit tests + fake CCU.
- **Phase 2 — Central:** discovery, immutable registry, persistent cache, event bus, lifecycle + reconnect.
- **Phase 3 — Generic model + public facade** (`valueChanged`/`setValue`): first useful end-to-end release; npm `0.x` publication (evolving API).
- **Phase 4 — Custom entities:** one family at a time (switch → light → cover → climate → lock → …), each with tests.
- **Phase 5 — Hub** (sysvar/programs) + calculated/combined.

Each phase is a tested spec→plan→implementation cycle.

## 9. Closed decisions and risks

- **Homematic XML-RPC quirks** (ISO-8859-1 encoding, `system.multicall`, numeric types): mitigated by the `RpcProxy` boundary with a fallback to a custom serializer.
- **License:** ✅ **MIT** (same as aiohomematic). The original copyright `Copyright (c) 2021-2026 SukramJ, Daniel Perna` is kept and the port's copyright is added (required by MIT for redistribution).
- **npm name:** ✅ `nodehomematic` available on the registry (verified 2026-06-04).
- **Reconnect/CCU restart — rock-solid requirement:** reconnection is a first-class requirement, not best-effort. The CCU loses the callback registration on every restart/network loss; the system must:
  - detect the drop via **periodic per-interface health-ping** + absence of expected events;
  - re-run `init(callbackUrl, interfaceId)` with **exponential backoff + jitter** until it recovers;
  - **re-sync** discovery after the re-init (devices may have changed during the outage);
  - emit state-transition `connection` events so the external app always knows the real state;
  - survive prolonged CCU restarts without manual intervention and without losing the cached state.
  - Covered by dedicated integration tests (fake CCU that drops/restarts) as well as e2e.
```
