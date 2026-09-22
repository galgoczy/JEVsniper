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

---

# 2. lépés – tokenfigyelés (kiegészítés)

## Tulajdonosi döntések (2026-09-22)
- Jev kulcs: van. Robinhood Chainen **PONS** a launchpad (nem hood.fun). MEV-védett fizetős RPC nem kell.

## Ellenőrzött címek és mechanika
- **PONS v2 (Robinhood Chain)** – három egymástól független forrás egyezik (docs.ponsfamily.com/v2#contracts
  keresőkivonat, Bitquery PONS-doksi, pons-sdk 0.1.4 és ponscli 0.1.1 npm csomagok):
  factory `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` (TokenLaunched), helper/launch router `0xe33e…2948`,
  meme hook `0xe5e7…e044`, Uniswap v4 PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`.
  Mechanika: bonding curve (`buy`/`sell` a curve szerződésen, `quoteReserve`/`tokenReserve` olvasható),
  graduáció Uniswap v4 poolba, likviditás véglegesen lockolva a hookban.
  **Snipe-adó**: az első 5 másodpercben 99%-ról exponenciálisan nullára csökken (1 mp: ~25%, 2 mp: ~3%).
  A mi 30–180 mp-es ablakunkat nem érinti, de vétel előtt `currentSnipeTaxBps(wallet)`-et mindig kiolvassuk,
  és a `feeBps + creatorTaxBps` az effektív adó (kemény szűrő: eladási adó > 5% → kiesik).
- **Clanker v4 (Base)** – clanker-sdk 4.2.19 (hivatalos): factory `0xE85A59c628F7d27878ACeB4bf3b35733630083a9`,
  TokenCreated esemény (16 mező: token, admin, név, ticker, poolId, pairedToken, hook, locker, mevModule…).
  Uniswap v4 pool hookkal; a locker a likviditást zárja. Ugyanez a factory Robinhood Chainen is él
  (`0xD3f2cC1731b7Fd17f28798835C2E02f0a1839A94`), ezért ott is figyeljük.
- **Uniswap-indítások**: Base v2 factory `0x8909…8eC6`, v3 factory `0x3312…FDfD`, v4 PoolManager `0x4985…b2b`
  (BaseScan verified + Uniswap docs). Csak ETH/WETH-páros új pool számít tokennek. Robinhood Chainen csak a v4
  PoolManagert figyeljük (a natív ETH a v4-ben a 0x0 cím, így WETH-cím nélkül is működik); a Robinhood WETH és
  v2/v3 factory címeket hivatalos forrásból még nem erősítettem meg → később.
- Launchpad-token graduációja Uniswapra **nem** új token: csak a pool-cím frissül.

## RPC-kérdés (2.) – mi a lényeges különbség
- A bot **másodpercenként kérdezi le a láncot** (új blokkok + események), két láncon, a nap 24 órájában.
  Ez naponta nagyságrendileg 50–60 ezer RPC-hívás (Base 3 mp-enként, Robinhood 3 mp-enként, forrásonként egy
  `eth_getLogs`).
- **Publikus RPC** (mainnet.base.org, rpc.mainnet.chain.robinhood.com): ingyenes, de kérés/mp limit van, a
  túllépést csendben elutasítja (429), és nincs garancia. Tokenfigyelésre menni fog, de a végrehajtásnál (5. lépés)
  egy elutasított kérés = elcsúszott vétel/eladás. Ezért **a végrehajtás külön, megbízhatóbb RPC-n** kell fusson.
- **Alchemy free**: havi 30M compute unit, 25 kérés/mp, minden hálózat (Base + Robinhood Chain is támogatott).
  Egy `eth_getLogs` 75 CU, egy `eth_blockNumber` 10 CU. A mostani beállítás ≈ 40–60M CU/hó, tehát **a free
  keret önmagában kevés** a folyamatos figyeléshez, pláne ha a másik projekted is ugyanazt a keretet fogyasztja
  (a CU-keret fiókonként közös, nem appnként).
- **Javaslat**: figyelés publikus RPC-n (ingyen, ha kiesik, csak késünk), végrehajtás + eladás-szimuláció
  Alchemy-n (kevés hívás, de fontos, hogy átmenjen). Ehhez az `.env`-ben külön `*_PRIVATE_TX_RPC_URL` már van;
  a következő lépésben átnevezem `*_EXEC_RPC_URL`-re. Ha a másik projekted keveset fogyaszt, a meglévő free
  kulcs elég; különben új ingyenes Alchemy-fiók egy másik e-mailről.

## Verify (a Mac Minin)
1. `npm run verify:step2` → minden címen van kód, és az elmúlt ~1 órában jöttek események (PONS, Clanker, Uniswap).
2. `npm start` → ~1 óra múlva `/status` Telegramon vagy újra `verify:step2`: a `tokens` táblában mindkét lánc
   tokenjei szerepelnek launchpadonként bontva.
