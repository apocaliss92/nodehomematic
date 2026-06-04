# nodehomematic

Porting Node.js/TypeScript di [aiohomematic](https://github.com/sukramj/aiohomematic) — libreria asincrona per controllare e monitorare dispositivi Homematic / HomematicIP tramite **CCU3 / RaspberryMatic / OpenCCU**.

> **Stato:** 0.x funzionale. API pubblica stabile nelle linee generali, possibili rifiniture fino alla 1.0.

## Caratteristiche

- Connessione XML-RPC alle interfacce CCU: **HmIP-RF, BidCos-RF, VirtualDevices** (gruppi, su path `/groups`).
- Client JSON-RPC verso la WebUI CCU (nomi, system variables, programmi) + script ReGa (stanze/funzioni, descrizioni).
- Callback server per la ricezione push degli eventi dalla CCU.
- Riconnessione **rock-solid** (health-ping + ping/pong + re-init con backoff + re-sync valori).
- Discovery automatica di device, canali e data point + cache persistente delle descrizioni + seeding dei valori iniziali allo start.
- API pubblica agnostica event-driven: stream globale `valueChanged` + `setValue` validato.
- **Custom entities** tipizzate: Climate (termostati e gruppi riscaldamento), Switch, Light/Dimmer, Cover/Blind, Lock.
- **Configurazione dispositivi** (paramset MASTER): leggi gli spec dei parametri e leggi/scrivi i valori di config.
- **Hub**: system variables (lettura/scrittura) e programmi (lista/esecuzione/attivazione).

## Requisiti

- Node.js >= 20

## Installazione

```bash
npm install nodehomematic
```

## Uso

```ts
import { Homematic } from 'nodehomematic';

const hm = new Homematic({
  host: '192.168.1.10',
  interfaces: ['HmIP-RF', 'BidCos-RF', 'VirtualDevices'],
  credentials: { username: 'Admin', password: '...' },
  callback: { host: '192.168.1.50', port: 9123 }, // IP di QUESTA macchina, raggiungibile dalla CCU
});

// Stream globale: aggiornamenti live di tutti i device
hm.on('valueChanged', (e) => {
  console.log(
    `${e.device}:${e.channel} ${e.parameter} = ${String(e.value)} (era ${String(e.prevValue)})`,
  );
});
hm.on('connection', (e) => console.log('connessione', e.interfaceId, e.state));
hm.on('ready', () => console.log('discovery completata'));

await hm.start();

// Snapshot dei device (con canali, data point e valori correnti)
for (const d of hm.devices()) {
  console.log(d.address, d.type, d.name);
}

// Lettura / scrittura di un data point (forma esplicita o per id)
const v = hm.getValue({ device: 'VCU0000001', channel: 1, parameter: 'STATE' });
await hm.setValue({ device: 'VCU0000001', channel: 1, parameter: 'STATE' }, true);

// Custom entities (es. termostati / gruppi riscaldamento)
const climates = hm.customEntities().filter((e) => e.kind === 'climate');
await hm.climateSetTemperature('INT0000001', 1, 21.5);
await hm.climateSetMode('INT0000001', 1, 'auto');

// Configurazione dispositivo (paramset MASTER) — per costruire una UI di config
const params = hm.getConfigParams('VCU0000001:1'); // spec dei parametri (type/min/max/valueList/...)
const config = await hm.getConfig('VCU0000001:1'); // valori correnti
await hm.setConfig('VCU0000001:1', { CYCLIC_INFO_MSG_DIS: 28 });

// Hub: system variables e programmi
console.log(hm.systemVariables().length, hm.programs().length);
await hm.setSystemVariable('Allarme', true);
await hm.runProgram('Sveglia');

await hm.stop();
```

## API pubblica (sintesi)

- **Lifecycle:** `start()`, `stop()`.
- **Eventi** (`on`/`once`/`off`): `valueChanged`, `deviceAdded`, `deviceRemoved`, `connection`, `ready`, `error`.
- **Stato:** `devices()`, `getValue(ref)`, `setValue(ref, value)` (`ref` = id del data point o `{ device, channel, parameter }`).
- **Custom entities:** `customEntities()` + comandi `climateSetTemperature/climateSetMode/climateSetBoost`, `switchTurnOn/Off`, `lightTurnOn/Off/SetBrightness`, `coverOpen/Close/Stop/SetPosition`, `lockLock/Unlock/Open`.
- **Config dispositivo:** `getConfigParams(channelAddress)`, `getConfig(channelAddress)`, `setConfig(channelAddress, values)`.
- **Hub:** `systemVariables()`, `getSystemVariable(name)`, `setSystemVariable(name, value)`, `programs()`, `runProgram(idOrName)`, `setProgramActive(idOrName, active)`, `refreshHub()`.

## Note

- Il `callback.host` deve essere l'IP della macchina che esegue nodehomematic, **raggiungibile dalla CCU** (la CCU fa push degli eventi lì).
- Le stanze/funzioni vengono lette via script ReGa; compaiono solo per i canali effettivamente assegnati a stanze/funzioni nella CCU.

## Licenza

MIT — porting di aiohomematic (copyright originale SukramJ, Daniel Perna preservato). Vedi `LICENSE`.
