# nodehomematic

Porting Node.js/TypeScript di [aiohomematic](https://github.com/sukramj/aiohomematic) — libreria asincrona per controllare e monitorare dispositivi Homematic / HomematicIP tramite **CCU3 / RaspberryMatic / OpenCCU**.

> ⚠️ **Stato:** in sviluppo attivo (0.x). API in evoluzione fino alla 1.0.

## Caratteristiche (roadmap)

- Connessione XML-RPC alle interfacce CCU (BidCos-RF, HmIP-RF, ...)
- Client JSON-RPC verso la WebUI CCU (nomi, stanze, programmi, system variables)
- Callback server per ricezione push degli eventi dalla CCU
- Riconnessione automatica rock-solid (health-ping + re-init + re-sync)
- Discovery automatica di device, canali e data point + cache persistente
- API pubblica agnostica event-driven: stream globale `valueChanged` + `setValue`
- Tipi custom (light, switch, cover, climate, lock, ...) — incrementali

## Requisiti

- Node.js >= 20

## Installazione

```bash
npm install nodehomematic
```

## Uso (anteprima API target)

```ts
import { Homematic } from 'nodehomematic';

const hm = new Homematic({
  host: '192.168.1.10',
  interfaces: ['HmIP-RF', 'BidCos-RF'],
  credentials: { username: 'Admin', password: '...' },
  callback: { host: '192.168.1.50', port: 9123 },
});

hm.on('valueChanged', (e) => console.log(e.dpId, e.value));
await hm.start();
```

> Nota: la facade `Homematic` arriva nella Fase 3. Vedi `docs/superpowers/specs/` per il design.

## Licenza

MIT — porting di aiohomematic (copyright originale SukramJ, Daniel Perna preservato). Vedi `LICENSE`.
