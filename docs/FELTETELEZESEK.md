# Feltételezések és nyitott kérdések (1. lépés után)

## Amit hivatalos forrásból ellenőriztem

### Jev API (TypeSafe) – hivatalos SDK alapján (`@typesafe-ai/sdk` 0.6.0, npm)
- Végpont: `POST https://api.typesafe.ai/v1/systemone`, kulcs a `TYPESAFE_API_KEY` env-ben.
- Egy hívásban **egy state + tetszőleges számú kérdés** → a 12 belépési kérdés egy kötegben megy (6.4 teljesül).
- Kérdéstípusok: `choice` (max. 255 opció, minden opcióra valószínűség + confidence), `score` (2–10 fokú rubrika,
  várható érték + valószínűségek), `noul` (igen/nem valószínűség).
- **Fontos eltérés a spectől:** a Jev nem ad 0–100-as pontszámot közvetlenül. A `buyer_quality`, `narrative_fit`,
  `social_quality` kérdéseket 10 fokú rubrikával (0–9) kérdezem, és a várható értéket skálázom 0–100-ra. A küszöbök
  (pl. `buyer_quality ≥ 40`) így a skálázott értékre vonatkoznak.
- Limitek (dokumentáció szerint): 64k token/kérés (state + összes kérdés), 32k (state + leghosszabb kérdés);
  rate limit 1200 kérés/perc, 250k token/mp → 429. Ár: 0,042 USD / 1M input token, output ingyenes.
  Tehát egy ~1500 tokenes állapot 12 kérdéssel ≈ 0,0001 USD – a Jev-költség gyakorlatilag elhanyagolható; a
  `jev_daily_budget_usd` inkább biztonsági fék.
- SDK: beépített retry (429/5xx), timeout. Hibánál a bot `paused` állapotba megy (config: 3 egymást követő hiba
  → 5 perc szünet; 429-nél a szerver által kért idő).

### Láncok
- **Base**: chain id 8453 (viem beépített). Launchpadok: Clanker (Uniswap v4, factory v4.0.0:
  `0xe85a59c628f7d27878aceb4bf3b35733630083a9` – BaseScan szerint verified), Zora, Flaunch. Uniswap v4 PoolManager:
  `0x498581fF718922c3f8e6A244956aF099B2652b2b`. Ezeket a 2. lépésben még egyszer ellenőrzöm az ABI/eventek szintjén.
- **Robinhood Chain**: chain id 4663, Arbitrum Orbit, gas ETH-ben, RPC `https://rpc.mainnet.chain.robinhood.com`,
  explorer `robinhoodchain.blockscout.com`. Uniswap v2/v3/v4 él (2026-07). Launchpad: **hood.fun** (bonding curve,
  graduáció Uniswap v3 1%-os poolba, likviditás lockolva). Szerződéscímeket még nem találtam hivatalos forrásból –
  2. lépés feladata (whitepaper / Blockscout verified contract).
- Kutatási állapot MEV-ről: Base-en nincs publikus mempool (a sequencer privát), a sandwich-kockázat kisebb;
  fizetős MEV-védett RPC-k léteznek (pl. GetBlock/Merkle). Robinhood Chain (Orbit) hasonló sequencer-modell.
  Az `.env`-ben van hely privát küldő RPC-nek; alapból a sima RPC-re megy.

## Feltételezések, amikkel dolgoztam
1. Egy fájlos SQLite `better-sqlite3`-mal (natív modul, Mac Minin `npm install` lefordítja/letölti).
2. Node 22+ (a Jev SDK Node 20+-t kér).
3. A `config.yaml` az egyetlen helye a küszöböknek; a bot indulásakor validálja (zod), hibás config → nem indul.
4. A bot **nem indul privát kulcs nélkül**; a kulcs csak `.env`-ből jön, a logger kitakarja a 0x+64 hex mintát,
   a Telegram-tokent és az API-kulcs-szerű stringeket.
5. Telegram: saját minimál kliens (fetch), long polling; csak a beállított `TELEGRAM_CHAT_ID`-ból fogad parancsot.
6. `/panic` az 1. lépésben csak STOP-ot állít és naplóz; a tényleges eladás az 5. lépés (végrehajtás) része.
7. Az élő ablak 60 mp, árnyék 30 és 180 mp (config `evaluation`).

## Nyitott kérdések a tulajdonosnak (reggelre)
1. **Jev kulcs**: van már TypeSafe-fiók és kulcs? (Nincs ingyenes tier a doksi szerint.)
2. **RPC**: elég a publikus Base/Robinhood RPC, vagy legyen saját (Alchemy/Chainstack)? Tokenfigyeléshez
   (blokkonkénti log-lekérés két láncon) a publikus RPC rate limitje szűk lehet; ajánlom a saját kulcsot.
3. **Launchpad-választás** (2. lépés): Base-en Clanker-t javaslom elsőnek (legnagyobb forgalom, tiszta v4 esemény),
   Robinhood Chainen hood.fun-t. Egyetértesz?
4. **Adat-API-k** (11. lépés): DexScreener/GeckoTerminal ingyenes, social adatokhoz fizetős kellhet – később egyeztetjük.
5. **Fizetős MEV-védett RPC** Base-re: kell-e, vagy elég a sequenceres alapvédelem az 1 USD-s mérethez? Javaslatom: nem kell.

## Ami ebben a környezetben NEM volt tesztelhető
A fejlesztő konténer proxyja blokkolja a külső API-kat (typesafe.ai, telegram, RPC-k). Ezért az élő Jev-hívás
és a Telegram-üzenet tesztje a Mac Minin fut: `npm run verify:step1`. A DB-séma, a config, a kérdés-definíciók és a
kulcs-kitakarás automatikus tesztekkel ellenőrizve (`npm test`).
