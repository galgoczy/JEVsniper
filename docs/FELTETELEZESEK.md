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

---

# 3. lépés – on-chain paramétergyűjtő (kiegészítés)

## Mit gyűjt és honnan
- Minden új tokenre 30 / 60 / 180 mp-nél pillanatkép (`snapshots` tábla, JSON, méretkorlát a configból).
- **Szerződés**: bytecode-hash (ismert sablon: PONS/Clanker gyári token, vagy ≥3 másik token ugyanazzal a hash-sel),
  veszélyes szelektorok a bytecode-ban (mint/pause/blacklist/setTax/openTrading – közelítés), `owner()` renounce,
  effektív adók (PONS: `feeBps + creatorTaxBps`; v4 pool: 0, a hook-díj külön), likviditás (PONS: `quoteReserve`;
  v2: reserves; v3/v4: unknown – a singleton PoolManager miatt), graduált-e.
- **Eladás-szimuláció**: PONS curve-nél a curve-képlet (ok/failed); v2/v3/v4-nél `not_supported`/`unknown` –
  a valódi eladás-szimulációt (eth_call a routeren) az 5. lépés hozza, mert ugyanaz a kód kell a kilépéshez is.
- **Holderek**: a token `Transfer` eseményeiből a felfedezés blokkjától: holder-szám, top1/top10 (creator és pool nélkül),
  airdrop-arány (nem a poolból kapott tokent), creator részesedése és eladott hányada. Top20 wallet tx-száma → friss arány.
  Funding-klaszterek: `unknown` (minden wallet első bejövő tx-ét kellene lekérni; explorer API kell, 11. lépés).
- **Dinamika**: swap-eseményekből (PONS CurveBuy/CurveSell, v4 PoolManager Swap poolId-szűréssel, v2/v3 Swap):
  vétel/eladás szám és volumen, egyedi vevők, gyorsulás, ár (sqrtPriceX96-ból v3/v4-nél), csúcs-visszaesés, volatilitás,
  nagy eladások (> likviditás 5%-a). Blokk-időbélyeg: első és utolsó blokk lekérve, a köztesek interpolálva (RPC-spórolás).
- **Bot-arány**: a launch blokkjában vagy +2 blokkon belül vásárlók aránya.
- **Creator**: korábbi tokenjei a saját DB-ből (szám, 24h, graduált), tx-szám és egyenleg. Sors (rugolt/halt) még nem:
  a 7. lépés kilépés-követése után lesz adat.
- **ETH/USD**: Chainlink aggregátor Base-en, 60 mp cache; Robinhood Chainen is ezt használjuk.
- **Social, logó, funding-klaszter, launchpad-rang**: `unknown` (11. lépés, külső adatforrás kell).
- Multicall3 a kanonikus címen Robinhood Chainen is (genesis deploy) – a viem lánc-definícióba felvéve.

## RPC-terhelés
Tokenenként és ablakonként ≈ 8 + top20 tx-szám (20) hívás, tehát ~30; 3 ablak → ~90 hívás/token. Óránként 100 token
mellett ez ~2,5 hívás/mp. Ha a publikus RPC 429-et ad, a `watcher` és a gyűjtő logban jelzi; ilyenkor Alchemy-kulcs.

## Verify (a Mac Minin, futó bot mellett is)
`npm run verify:step3` → a DB legutóbbi tokenjére kiírja az összes mezőt és az unknown-ok listáját.
`npm run verify:step3 -- robinhood 0x...` → adott PONS-tokenre. Elvárás: minden mező kitöltve vagy `unknown`, hiba nélkül.

---

# 5. lépés – végrehajtás (kiegészítés)

## Útvonalak
- **PONS curve** (graduáció előtt): `buy(quoteIn,minOut,recipient)` payable, `sell(tokensIn,minOut,recipient)` approve után
  (csak a curve-nek, csak az eladandó mennyiségre). Árajánlat a curve képletéből (pons-sdk `quoteNativeCurveBuy/Sell`),
  a `currentSnipeTaxBps(wallet)` figyelembevételével. Graduációt a factory `getLaunchedToken(token).phase == 2` jelzi.
- **Uniswap v4** (Clanker Base-en, PONS graduáció után, Uniswap-indítások): Universal Router `execute` –
  V4_SWAP [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL] + SWEEP. Árajánlat = eladás-szimuláció a hivatalos v4 Quoterrel
  (`quoteExactInputSingle`, eth_call). Eladáshoz Permit2: ERC20 `approve(Permit2, pontos mennyiség)` +
  `Permit2.approve(token, router, mennyiség, 30 perc)`. PoolKey a PoolManager `Initialize` eseményéből (DB `pool_key_json`),
  PONS-nál a factory rekordból (poolFee, tickSpacing, meme hook).
- **v2/v3 útvonal még nincs** (Base közvetlen Uniswap-indítások egy része); a következő lépésekben, ha a tölcsér indokolja.

## Címek (forrás)
- Base: Universal Router `0x6fF5…9b43`, v4 Quoter `0x0d5e…048D` (BaseScan címkézett, Uniswap docs v4 deployments).
- Robinhood: Universal Router `0x06af…BF99` (Uniswap docs, 2026-07-06 újratelepítés; a pons-sdk még a régi `0x8876…0904`-et
  használja), Quoter `0x8Dc1…8F94` (egyezik a pons-sdk quoterével), Permit2 kanonikus.
- Ha a Robinhood Universal Router címe mégis a régi lenne, az 1. napi próba száraz futása (`estimateGas`) azonnal jelzi.

## Executor
- Nonce: max(lánc pending, DB `nonces`) – újraindítás után a DB-ből folytat. Gas: becslés ×1,2; USD-plafon vételnél
  `max_gas_per_tx_usd`, eladásnál `max_gas_per_sell_usd`. OP-stack L1 díj (Base) a nyugtából, ha van (`l1Fee`).
- Sikertelen szimuláció (revert): nem küld, gas nincs, de `fills`-be `failed` és a hibaszámláló nő. Sikertelen küldés: egy
  újrapróbálás (config). `max_consecutive_failed_tx` elérésekor nincs új vétel (`/resume` old fel).
- Eladás: mindig friss árajánlat; csúszás-lépcső: alap → 2× → `panic_slippage_pct`; ha egyik sem megy → `unsellable`.
- STOP-fájl: vételt tilt, eladást nem. `/panic`: STOP + minden nyitott élő pozíció eladása a panic-csúszással.
- MEV: küldés opcionálisan külön RPC-n (`*_PRIVATE_TX_RPC_URL`); Base-en a sequencer privát mempoolja az alapvédelem.

## 1. napi próba
`npm run day1 -- pick` → jelöltek; `npm run day1 -- <lánc> <cím>` → száraz (árajánlat, gas-becslés, nincs küldés);
`--confirm` → éles: vétel 1 USD, szándékosan sikertelen eladás (10× minOut), eladás 50%, maradék eladása, nonce-ellenőrzés,
gas műveletenként, fills a DB-ben. `/stop` és `/panic` a futó boton Telegramról.

---

# 6. lépés – döntési motor (kiegészítés)

- **Jev minden pillanatképre** (30/60/180 mp), a kiesett tokenekre is (csak napló): a tulajdonos döntése szerint a több
  Jev-használat rendben, ha mérhető. Az állapot tömör JSON (technikai mezők nélkül, kerekítve), ~2–3k karakter; a korábbi
  ablak címkéi `earlier_labels` néven bekerülnek a későbbi ablak állapotába.
- **Élő szabály** (6.5) csak a 60 mp-es ablakban, a kockázati korlátok (4.) után. Méretmodulátor 1,5× a spec szerint.
- **Árnyékkarok** minden ablakban: `jev_direct_0.3/0.4/0.5`, `live_rule` (az élő szabály árnyékban, korlátok nélkül),
  `rule_score` (Jev nélküli pontszám, ≥60), `random_control` (a cím keccak-hash-éből determinisztikus 20%). `learned` a
  13. lépésben. Belépéskor minden árnyékkarhoz 7 árnyék-pozíció nyílik (élő terv, B, C, moon10, moon30, trail40, trail60) –
  ezek árkövetése és lezárása a 7. lépés.
- **Rezsim** óránként: ETH ár most/24h/7d (saját óránkénti ár-napló a `meta` táblában; a 7 napos csak egy hét után él),
  launchpadok 24h graduációs aránya és indítás-száma, gas. Meme-szektor/Pump.fun/DEX-volumen: `unknown` (11. lépés).
  Kemény felülírás: ETH 24h esés > `eth_24h_drop_pct_risk_off` → `risk_off`. Jev-hiba esetén marad az előző rezsim.
- **Jev-hiba/rate limit** → a kliens szünetel, a kockázati ellenőrzés `jev_paused`-zal blokkolja az élő belépést; a
  gyűjtés, szűrés és árnyékkarok (rule_score, random_control) tovább futnak.
- **Nyitott kérdés**: az élő vétel most a spec küszöbeivel azonnal élesedik, amint a bot fut a 6. lépéssel. Ha előbb
  1–2 nap árnyékfutást akarsz Jev-adattal, a `config.yaml` `mode: dry_run` erre való (minden fut, tx nem megy ki).

---

# 7. lépés – tartás, kiszállás, vészkilépés (kiegészítés)

- **Árfeed kötegelve**, láncenként, a monitor 15 mp-es tick-jén: PONS curve-ök multicall (reserves, graduált), v4 poolok
  PoolManager Swap események poolId-listával (200-as adagok), creator-egyenlegek multicall. Egy tick ≈ 3–4 RPC-hívás láncra,
  a nyitott pozíciók számától nagyrészt függetlenül. Blokkonkénti futás a spec szerint, Jev nélkül.
- **Kiszállási tervek** tiszta függvényben (`src/exit/plans.ts`): élő (2x 50%, 5x 30%, moon bag 20x / trailing -50% csak 5x
  után / 7 nap), moon10/moon30, trail40/trail60, B (2,5x/3x/4x/6x 25%-onként), C (2x 50%, majd csúcstól -35%).
  Kézzel végigszámolt példa a `verify:step7`-ben egyezik (1 USD → 6,2x bruttó, 5,09 USD nettó a modell-költségekkel).
- **Vészfékek**: -40% a belépéshez, creator eladta 20%-át (egyenleg a belépéskorihoz képest), likviditás -30% (PONS curve;
  v4-nél unknown), eladás-szimuláció sikertelen (a csúszás-lépcső után "unsellable", 5 percenként újra), risk_off →
  config szerinti fázisok. Ismert scammer-wallet nagy eladása: a 12. lépés listái után él.
- **Jev hold/exit** csak élő pozíciókra, az adaptív ütemben (15 mp / 60 mp / 5 perc / moon bag 15 perc), könnyű
  állapottal (szorzó, csúcs, tartási idő, forgalom az utolsó ellenőrzés óta, creator-eladás). P(exit) > 0,6 → zárás.
  Napi Jev-keret elérésekor a hold-kérdések kimaradnak, a vészfékek és tervlépcsők futnak.
- **Árnyék-pozíciók**: szimulált vétel és eladás a költségmodellel (gas a mért lánconkénti értékből, díj: curve 2% /
  pool 1%, csúszás x/(R+x) a likviditásból, MEV 0,3%); `fills` táblába `simulated` sorok. Csak támogatott útvonalú
  tokenekre (PONS curve, v4 PoolKey-vel) nyílnak.
- **24 órás kimenet-követés** (`token_outcomes`): minden tokenre, ahol bármelyik kar belépett: max/min szorzó, előbb 2x
  vagy előbb -40%. Ez adja a kalibrációs táblát (9.) és a tanult modell címkéjét (13.).
- **Élő pozíció zárása**: nettó = (kapott − befektetett ETH)·ETH/USD − gas − Jev-költség; napi PnL frissül; a compound-
  kezelő (8.) erre a horogra (`onLiveClosed`) kapcsolódik.

---

# 8. lépés – compound-kezelő (kiegészítés)

- Nyereség 30% → növekedési kassza, 70% → tartalék; veszteség a betétből, majd a kasszából, a tartalékot soha.
- Forgó tőke = betét + kassza; csúcs követve; csúcstól -30% → a kassza fele számít a méretbe, amíg új csúcs nincs.
- Méret naponta 0:00 UTC (`compound.recalc_time_utc`): min(max, alap + effektív kassza / max_open_positions); menet közben
  a nyitott pozíciók mérete nem változik (a méretet a belépés pillanatában olvassa a döntési motor).
- Opcionális kar (`require_positive_vs_random_control`, alapból ki): a méretnövelés csak akkor, ha az utolsó 7 nap élő
  átlagos nettója jobb, mint a random_control kar élő tervének átlagos nettója.
- Verify (`npm run verify:step8`): 3 nyerő (+2, +3, +5), 2 vesztes (−1, −0,8) → kassza 3,00, tartalék 7,00, betét 28,20,
  méret 1,20; utána −10 → forgó tőke −32% a csúcstól → kassza felezve → méret 1,10; tartalék érintetlen. Egyezik.
- A tartalék "elkerítése": a riport mutatja; a bot nem utal ki (a tulajdonos hetente kézzel).

---

# 9. lépés – riport (kiegészítés)

- Napi riport markdownban (`reports/YYYY-MM-DD.md`, config `report.daily_time_utc`) + rövid Telegram-összefoglaló;
  kézzel bármikor: Telegram `/report` vagy `npm run report`.
- Tartalom a spec szerint: tölcsér (új → kiesett okonként → értékelt → átment → élő szabály → élő belépés, blokkolás okai),
  élő (lezárt, nettó, fix költségek aránya, tx-ek becsült vs valódi gas, kilépési okok, Jev-hívások/költség/késés),
  compound-állapot és méretváltozások, árnyékkarok karonként/ablakonként/tervenként (n, találat, medián és átlag szorzó,
  nettó Σ, átlag, bootstrap 90% CI, top 3 nélkül, random_control-hoz mérve), csúcs-szorzók (≥2x/5x/10x/20x) és
  trailing-kilépések, rezsim szerinti bontás, kalibrációs tábla (P(2x előbb) sávok vs. 24h valós kimenet),
  címke-informativitás, kimenet-követés, listák, vesztes sorozat, Jev-hibaarány, rezsim-idővonal.
- Verify (`npm run verify:step9`): a riport számai közvetlen SQL-lel keresztellenőrizve (random_control átlag, új tokenek).

## 2026-09-24 – Base/Uniswap árnyékkarok, szűkített Jev-hatókör
- Tiszta (ablakonkénti) kimenet-adat alapján a 60 mp-es „előbb 2x, mint −40%” találatok mind Base/Uniswap-on indított tokenekből jöttek (51/99), a Robinhood PONS-ból 0/486.
- Új Jev nélküli árnyékkarok: `base_uni_all` (minden szűrőn átment Base/Uniswap token – a csoport alapvonala) és `base_uni_hold` (+10–29 holder és vevő-gyorsulás ≥2).
- Feltételezés: árnyékpozíció csak kereskedhető (v4 PoolKey-es) tokenre nyílik, a v2/v3 poolos tokenekre nincs végrehajtási útvonal, így ezek nem kerülnek be.
- Jev-címkézés csak `evaluation.jev_scope` = ["base/uniswap"] tokenekre; a PONS-tokeneknél a Jev-alapú karok (jev_direct, live_rule) így nem döntenek. Visszaállítás: üres lista.

## 2026-09-25 – Készítő és LP-tulajdonos a Base/Uniswap tokeneknél
- Adat: a base_uni_all árnyékpozíciók 72/74-ét a −40%-os vészkilépés zárta, átlag −0,97 USD (egy lépésben ~nulla) → kihúzás vagy dömping.
- Készítő: közvetlen Uniswap-indításnál a pool-létrehozó (Initialize) tranzakció küldője (tx.from). Clanker ugyanabban a tx-ben: a TokenCreated tokenAdmin felülírja. Csak az új tokenekre érvényes (a régieknél nincs tx hash).
- LP-tulajdonos (v4): a PoolManager ModifyLiquidity eseményeiből (forrás: @uniswap/v4-core 1.0.2 IPoolManager.sol) a legnagyobb nettó pozíció; ha a küldő szerződés, `ownerOf(salt)` (PositionManager: salt = bytes32(tokenId), @uniswap/v4-periphery). Kategóriák: burned (0x0/0x…dEaD), creator, eoa, contract (zároló/hook – nem eldönthető), removed, none.
- Nem kemény szűrő (még): csak paraméter (`contract.lp_owner`) és két új árnyékkar: `base_uni_lp_burned`, `base_uni_clean` (LP égetett vagy szerződésnél + készítőnek nincs korábbi tokenje). Ha mérhetően jobb, kemény szűrővé tehető.

## 2026-09-26 – Mérési hibák javítása (árnyék-eladás, készítő-eladás)
- Hiba 1: v4 poolnál a likviditás gyakran ismeretlen volt (a Quoter-becslés nem mindig sikerül, az árfeed nem mérte). Ismeretlen likviditásnál az árnyék-eladás fix 2% csúszással számolt, így egy 139x-es csúcsnál (FEATHER) +129 USD-t könyvelt, amit a vékony pool valójában nem adott volna ki.
  Javítás: virtuális ETH-tartalék az utolsó Swap eseményből (L és sqrtPriceX96): ETH currency0 → L/sqrtP, currency1 → L·sqrtP. Ugyanez a módszer a gyűjtőben és az árfeedben (összemérhető likviditás-esés). Eladásnál ismeretlen aktuális likviditás esetén a belépéskori likviditás a tartalék.
  Feltételezés: teljes tartományú pozíciónál pontos, szűk tartománynál felülbecsülhet.
- Hiba 2: a „készítő eladott” vészkilépés a belépéskori egyenleget a transzfer-történetből becsülte, később viszont balanceOf-ot olvasott → 145 pozíció azonnal (0 perc) „creator_sold_100%”-kal zárult. Javítás: belépéskor is balanceOf; ha a készítőnél a kínálat 1%-ánál kevesebb van, nincs készítő-eladás figyelés.
- A javítás előtti pozíciók a riport 24 órás ablakából egy nap alatt kikopnak.
- Jev-hasznosság mérése: új árnyékkar `rule_v2_nojev` = rule_v2 a Jev-címkék nélkül (csak on-chain számok). A rule_v2 és a rule_v2_nojev különbsége ugyanazokon a tokeneken a Jev hozzáadott értéke. Ha 1–2 nap után nincs érdemi különbség, a Jev kikapcsolható.

## 2026-09-26 – Egynapos Jev nélküli próba
- `jev.enabled: false`: a bot nem hívja a Jev-et (belépési címkék, rezsim, élő tartás). A Jev-alapú karok (jev_direct, live_rule) nem döntenek; a rule_v2 címkék nélkül fut (ugyanaz, mint rule_v2_nojev).
- Rezsim Jev nélkül: marad „normal”, csak az ETH 24 órás esése kapcsol risk_off-ra.
- A verify:step1 és verify:step6 kifejezetten a Jev-et teszteli, ezért ott a Jev bekapcsolva marad.
- Visszaállítás: config.yaml → jev.enabled: true, majd újraindítás.

## 2026-09-27 – Többnapos riport, döntési tábla, késői belépés teszt
- Riport: `npm run report -- --since ÉÉÉÉ-HH-NN` (UTC 00:00-tól) vagy `-- --days N`; külön fájlba íródik (`<dátum>_ota-<dátum>.md`), a napi riport változatlan.
- Döntési tábla a riport elején: a legjobb 10 (kar, ablak, terv) kombináció legalább 20 lezárt pozícióval, a 90% bootstrap CI alsó határa szerint.
  Előre rögzített szabály: élesítés-jelölt (✅) csak legalább 100 pozíciónál és teljesen nulla fölötti CI-nél. ⏳ = pozitív CI, de kevés adat.
  Feltételezés: sok kombinációt nézünk egyszerre, ezért egy-egy ✅ lehet véletlen is (többszörös összehasonlítás) – élesítés előtt egy további, független időszakon is meg kell ismétlődnie.
- Késői ablak: `evaluation.late_window_sec: 1800`, `late_scope: ["base/uniswap"]` – ezekről a tokenekről 30 perc után még egy pillanatkép; minden kar ott is dönt (így a random_control@1800 és base_uni_all@1800 a túlélők alapvonala).
  Új kar `late_survivor` (csak 1800 mp-nél): likviditás a poolban (nem removed/none), ár az induló fölött, csúcstól < 50% esés, készítő < 50%-ot adott el.
- Költség: tokenenként egy plusz pillanatkép a Base/Uniswap tokenekre (~napi 1900), ingyenes RPC-n belül.

## 2026-09-27 – Folyamatos kiértékelés: figyelő és szabálykereső
- Alapelv: a bot futás közben NEM írja át a szabályait sorozatok alapján (zajkövetés, túlilleszkedés). Csak jelez; változtatás heti ciklusban, friss adaton igazolva.
- Figyelő (`alerts`, óránként): minden (kar, ablak, terv) kombináció az `alerts.since` naptól; Telegram-üzenet csak állapotváltáskor:
  ⏳ ígéretes (n ≥ 20 és 90% CI alsó határa > 0), ✅ élesítés-jelölt (n ≥ 100 és CI > 0), ↘️ kiesett (CI alsó határa −0,02 alá – hiszterézis a villogás ellen).
  Állapotok az `arm_states` táblában. Nagy nyerő: ha egy token a 60 mp-es árától 10x fölé megy, egyszeri üzenet a fő jellemzőivel.
- Szabálykereső (`npm run explore [-- --since ÉÉÉÉ-HH-NN] [-- --window 60|1800]`): hatókör × 1–2 feltétel (41 feltétel), időrendi 2/3 tanító, 1/3 ellenőrző rész.
  Közelítő érték 1 USD-re: 2x előbb +1, −40% előbb −0,4, egyik sem −0,1, mínusz oda-vissza költség (gas + 2×(csúszás + MEV + 1% díj)).
  ✔ csak ha az ellenőrző részen a 2x-arány Wilson 90% alsó becslése is az alapvonal fölött van és az értéke is jobb (n ≥ 15).
  Mérés tiszta zajon (5 szimuláció, 900 token): 0–2 hamis ✔ a top 20-ból; beépített jellel a valódi szabályt megtalálja.
  Korlát: csak azok a tokenek, amelyekhez van kimenet-követés (valamelyik kar belépett: minden Base/Uniswap v4 + a véletlen 20%); a −40%-os veszteség valójában gyakran nagyobb (egylépéses zuhanás).

## 2026-09-27 (este) – Szabálykereső javítása: torzítatlan cél
- Hiba az első változatban: a cél a „2x előbb, mint −40%” volt, és csak a már lezárult tokeneket nézte. Egy nap után a lezárultak főleg a gyorsan 2x-et érők → 93%-os 2x-arány (a valóságban az árnyékpozíciók 20–30%-a nyer). Ráadásul a 2x egy pillanatnyi kiugrásnál is „teljesül”, amin vékony poolban nem lehet eladni.
- Javítás: a cél tokenenként egy árnyékpozíció (adott ablak + terv) eredménye 1 USD-re – költségekkel és likviditás-alapú csúszással. Nyitott pozíciónál az utolsó ellenőrzéskori áron becsült érték (új oszlopok: positions.last_price_native, last_price_at; séma v6). Csak legalább 6 órája nyitott pozíciók.
- Rangsor: az átlag óvatos (90%) alsó becslése a tanító részen; ✔ ha az ellenőrző részen az alsó becslés is az alapvonal átlaga fölött van (n ≥ 15). Az azonos tokenhalmazt kiválasztó szabályokból csak az első látszik.
- Zajteszt (5 × 900 szimulált token, jel nélkül): összesen legfeljebb 5 hamis ✔ a 100-ból; beépített jelet megtalál.
- Ismert korlát a riportban és a figyelőben: azok csak lezárt pozíciókat számolnak, ezért az első napokban a gyorsan zárulók (zuhanások, gyors nyerők) felülreprezentáltak; ez néhány nap alatt kiegyenlítődik.

## 2026-09-28 – v4 irány-hiba javítása, copy trading árnyékteszt
- HIBA (javítva): a Uniswap v4 Swap esemény amount0/amount1 értékei a kereskedő szemszögéből értendők (v4-core 1.0.2 PoolManager/Pool.sol: a swapDelta a hívónak könyvelt delta; negatív = fizette, pozitív = kapta). A gyűjtő fordítva értelmezte (vétel ⇔ negatív token), ezért minden v4 poolos tokennél (összes Base/Uniswap, Clanker, graduált PONS) a vételek és eladások fel voltak cserélve (buys/sells, buy_sell_ratio, largest_buy…), és „vevőként” a router címe szerepelt (unique_buyers, bot_ratio hamis).
  Javítás: vétel ⇔ pozitív token-mennyiség; a kereskedő tárcája az ugyanazon tx token-Transferjéből (PoolManager → tárca = vétel, tárca → PoolManager = eladás).
  Következmény: a 2026-09-28 előtti pillanatképekben a v4 tokenek vevő/eladó-jellemzői hibásak; a szabálykereső alapértelmezése ezért `alerts.features_since: 2026-09-28`. Az árak és az árnyék-eredmények helyesek voltak (azok az sqrtPriceX96-ból jönnek).
- Copy trading (`copy`): láncenként 20 mp-enként a friss (6 órás, szűrőn átment, kereskedhető) tokenek összes vétele/eladása → wallet_trades. PONS: CurveBuy recipient / CurveSell seller. v4: Swap + Transfer párosítás tx szerint.
  Tárcapontozás 10 percenként, csak a már megtörtént kereskedésekből: lezárt kör = a vett mennyiség ≥ 90%-a eladva; smart = ≥ 5 lezárt kör, nyerő arány ≥ 50%, összesen nyereséges; unskilled = ≥ 5 lezárt kör, összesen veszteséges (kontroll).
  Jelzés: minősített tárca legalább 0,005 ETH-ért vesz → copy_smart / copy_unskilled árnyékpozíció (ablak = 0) az észleléskori áron; PONS-nál a vétel utáni határár a curve-tartalékokból (az átlagár optimista lenne). Tokenenként és karonként egyszer.
  Feltételezések: a tárca a token címzettje (router-sweep esetén a router lenne – ilyenkor kimarad a követésből); csak a saját megfigyelt tokenkörben pontozunk (más tokenekben elért eredmény nem látszik); a smart tárcák kialakulásához napok kellenek.

## 2026-09-28 – Listázás-figyelő (Coinbase / Robinhood) és /allas
- Coinbase (hivatalos, nyilvános, kulcs nélkül): GET api.exchange.coinbase.com/currencies és /products. Mezők a ccxt coinbaseexchange implementációja alapján: supported_networks[].id = "base", contract_address; products: base_currency, status, trading_disabled. Innen a dokumentáció nem volt elérhető (proxy) → a Mac Minin `npm run verify:listing` ellenőrzi.
- Robinhood: a hivatalos Crypto Trading API saját kulcsot és amerikai fiókot kér. Ehelyett a NEM hivatalos, nyilvános nummus.robinhood.com/currency_pairs/ végpont (több nyílt forrású kliens használja; bármikor megváltozhat). Szerződéscímet nem ad → DexScreener-keresés a szimbólumra, Robinhood Chain pár (chainId-részlet: `listing.robinhood_chain_match`, alapból "robinhood" – NEM ellenőrzött), egyező szimbólum, a legnagyobb likviditású. Kockázat: azonos nevű utánzat-token; a legnagyobb likviditás ezt csökkenti, de nem zárja ki.
- Esemény: új Coinbase-eszköz Base szerződéssel (currency_added), új kereskedhető Coinbase-termék (trading_live), új kereskedhető Robinhood-pár (rh_tradable). Első futáskor csak alapállapot (esemény nélkül). Korlát: a Coinbase-bejelentés (X/blog) gyakran megelőzi az API-ban való megjelenést, tehát a figyelő a bejelentési ugrás egy részéről lemaradhat.
- Árnyék-belépés az észleléskori DexScreener-áron (1 USD), ár-mintavétel 7 napig (első 2 órában percenként, utána 10 percenként). 5 kiszállási terv szimulálva (gyors 1,3x/−15%/4 óra; lépcsős 1,5x 50% + 3x 30% + csúcstól −30%, stop −30%; nagy 2x/5x, csúcstól −40%, stop −40%; tartás 1 óra; tartás 24 óra). Költség: 1% díj irányonként, csúszás a likviditásból, MEV 0,3%, gas lánconként.
- Valódi vétel nincs: a listázott tokenek jó része nem v4 poolban kereskedik (Aerodrome, v2/v3), arra még nincs végrehajtási útvonal. Ha a mérés indokolja, ez a következő lépés.
- /allas (Telegram) és `npm run allas`: stratégiánként egy sor (élő terv a fő ablakban + a legjobb kombináció, ⏳/✅), véletlen kontroll, listázások összesítve. Tájékoztató; döntéshez a riport.

## 2026-09-28 (délelőtt) – Valódi ETH-likviditás v4 poolokban; késői ablak kikapcsolva
- Megfigyelés: a 30 perces (late) belépések 14/16-a −40%-os vészkilépéssel, átlag −1,00 USD-vel zárult; a véletlen kontroll ugyanott −0,99. A túlélő Base/Uniswap tokeneket később ledömpingelik → `late_window_sec: 0` (kikapcsolva).
- HIBA (javítva): ezeknél a belépéskori likviditás 150–200 ETH volt. Ok: egyoldalú (csak token) indításnál a virtuális tartalék (L/√P) nem valódi ETH. Ez rontotta a likviditás-szűrőt (min. 500 USD) és a likviditás-esés vészféket.
  Javítás: valódi ETH a pool pozícióiban az aktuális áron, a ModifyLiquidity eseményekből felépített pozíciókból (v3/v4 képletek; √P(tick) = 1,0001^(tick/2)). Gyűjtő: minden v4 tokenre. Árfeed: tokenenként visszatöltés a felfedezés blokkjától (legfeljebb 20 000 blokk, különben a régi virtuális becslés marad), utána körönként az új események; likviditás-kivételnél swap nélkül is frissül.
  Copy-pozícióknál a v4 virtuális tartalék nem kerül a belépési likviditásba; ha belépéskor nincs likviditás, a monitor az első árfeed-értéket veszi alapnak.
  Következmény: a vékony valódi likviditású tokenek mostantól kiesnek a likviditás-szűrőn → a stratégiák tokenköre megváltozik. Tiszta összehasonlítás: `alerts.since` és `features_since` = 2026-09-29.
  Feltételezés: a felhalmozott, be nem gyűjtött díjak nincsenek benne (kicsi eltérés).

## 2026-09-29 – HIBA: kiürített pool „nyereséges” eladásként
- Tünet: egy nap alatt minden kar nyereségesre fordult (véletlen kontroll −0,17 → +0,27; base_uni_all 30 mp medián 1,78x), miközben a csak áralapú kimenet-követés (2x / −40% arány) nem változott.
- Ok: a 09-28-i valódi-ETH javítás óta az árfeed látja a likviditás-kihúzást (ModifyLiquidity, swap nélkül): a valódi ETH 0-ra esik, az ár nem változik. A vészfék ekkor zárt, a költségmodell pedig a 0 likviditást „ismeretlennek” vette (2% alapcsúszás) → az eladás a kihúzás előtti áron könyvelődött. A valóságban üres poolból semmit nem kapunk.
- Javítás: eladáskor 0 (vagy negatív) ETH-likviditás = teljes veszteség (nettó 0); ismeretlen (null) marad 2%; vételnél 0 ETH nem végzetes (a token-oldal számít). Ugyanez a listázás-szimulációban.
- A 09-28 délelőtti újraindítás és a 09-29-i javítás közötti lezárások szennyezettek → tiszta összehasonlítás: `alerts.since` / `features_since` = 2026-09-30.
- A riport-verify „új tokenek” ellenőrzése futó bot mellett ±5 eltérést tűr (versenyhelyzet, nem hiba).

## 2026-09-29 (este) – V2: graduációs szakasz, Clanker/PONS alapvonal
- Adat (véletlen kontroll, 24 óra, javított mérés): base/uniswap 64/78, robinhood/uniswap 44/47 likviditás-kihúzással zárult; robinhood/pons (curve) 0/68, graduált PONS 2/10 kihúzás (valószínűleg a curve→v4 likviditás-váltás hamis jelzése). PONS-graduáció: 386 / 24 óra.
- Új árnyékkarok (window 0, eseményvezérelt):
  - grad_at: a graduáció első észlelésekor (PONS-token v4 Initialize-a egy későbbi blokkban), a pool induló árán (Initialize sqrtPriceX96). Csak natív (ETH/WETH) párnál.
  - grad_15_all: +15 perc (config graduation.delay_min), friss pillanatkép (snapshots, 900-as címke), ha átmegy a kemény szűrőn.
  - grad_15_hold: mint előző + ár ≥ graduációs ár, van valódi ETH a poolban, a készítő < 50%-ot adott el.
  Feltételezés: a graduált PONS pool likviditása a PONS kezelésében van (a készítő nem húzhatja ki) – ezt a mérés ellenőrzi.
- Graduáció utáni likviditás-alap: ha a pozíció a graduáció előtt nyílt, az első v4 valódi-ETH érték lesz az új alap (positions.liq_rebased, séma v7), így a curve→v4 váltás nem ad hamis „likviditás-esés” vészjelzést.
- Árfeed-visszatöltés: ha a token felfedezése > 20 000 blokknál régebbi, az utolsó 20 000 blokkból tölt vissza (friss graduációnál ez teljes); ha így sem lát likviditás-hozzáadást, a virtuális becslés marad.
- clanker_all (base/clanker) és pons_all (robinhood/pons) az indulási ablakokban: zárolt likviditású platformok alapvonala.
- Időzítő-feltételezés: a +15 perces ellenőrzés újraindításkor elvész (a folyamatban lévő graduációknál kimarad).

## 2026-09-30 – Riport: csak az időszakban NYITOTT pozíciók; szabálykereső ✔ csak nyereségesnek
- Hiba: a riport árnyék-táblája a lezárás ideje szerint szűrt, így a régen (akár a hibás mérésű napokon, vagy még a Jev-korszakban) nyitott, most időkorlát miatt lezáruló pozíciók is bekerültek (pl. jev_direct karok a döntési tábla élén, felfújt random_control n). Javítás: `opened_at > since` is kell (a figyelő és az állás-lekérés eddig is így számolt).
- Szabálykereső: a ✔ eddig azt jelentette, hogy jobb az alapvonalnál – ez veszteséges szabályra is teljesült (pl. halott PONS-tokenek, amelyek „csak” a költséget veszítik). Mostantól ✔ = az ellenőrző részen nyereséges is (az átlag 90%-os alsó becslése > 0); ↑ = jobb az alapvonalnál, de veszteséges.
- /allas és `npm run allas`: a lezártak mellett „nyitottakkal ~” érték is (lezárt + nyitott pozíciók, a nyitottak az utolsó ellenőrzéskori áron, eladási költséggel és likviditással – becslés). A lassan záruló karok (graduáció, copy) így napok helyett órák alatt értékelhetők; csak nyitott pozícióval rendelkező kar is megjelenik.

## 2026-10-01 – Élő vétel konfigurálható karra; gyári-token szűrő (nofactory karok)
- Élő bekötés: `config.yaml` → `live_entry.arm` dönti el, melyik kar ad élő vételt az élő ablakban (`evaluation.live_window_sec`), és `live_entry.exit_plan` a kilépési terv (ugyanaz a készlet, mint az árnyékban: live, B, C, moon10, moon30, trail40, trail60). Eddig fixen a Jev-címkés `live_rule` volt (Jev kikapcsolva → sosem lépett be). Most `rule_v2_strict` / `live` van beállítva – `mode: dry_run` mellett ez csak Telegram-jelzést ad („az élő kar BELÉPNE”), valódi vétel nincs. A Jev szünete csak a `live_rule` kart blokkolja. Élesítéshez továbbra is: `mode: live` + újraindítás + ETH a tárcában – kizárólag a felhasználó döntésére, és csak ha a kar átmegy a döntési szabályon (≥ 100 lezárt pozíció, teljesen nulla fölötti 90% CI, második független időszak). Jelenleg egyik kar sem jelölt.
- Megfigyelés (09-30 óta, Base/Uniswap): a 4094 indításból ~15% két szerződéskódból jön (`tokens.bytecode_hash` 0xf381621c…: 410 token; 0x592a9c4a…: 172), és ezek 100%-ban teljes likviditás-kihúzással végződnek (386/386 és 153/153 árnyékpozíció), jellemzően ~2,3x-ig felhúzva, ~14 perc után kihúzva. A nyerő karok plusza a NEM gyári tokenekből jött: rule_v2 60 mp/live +1,55 (n=13) vs. gyári +0,15 (n=24); rule_v2_strict +1,55 vs. +0,25; base_uni_hold 30 mp +1,53 vs. −0,04. A gyári tokeneknél a kar kb. nullára jön ki (a 2x-nél eladott fél visszahozza a tőkét).
- Új árnyékkarok: `rule_v2_nofactory` (rule_v2 címkék nélkül) és `base_uni_hold_nofactory` – az alap szabály + „ezzel a szerződéskóddal korábban nem volt teljes likviditás-kihúzás” (bármely kar `emergency:liquidity_drop_-100%` zárása, `src/decision/factory.ts`; új index `tokens(bytecode_hash)`). Az előzmény a futás alatt gyűlik, tehát egy új gyár első 1–2 tokenje még átmegy. Feltételezés: a kód-ismétlés = scripted pump-and-pull; ezt a két kar a friss adaton méri (a fenti bontás utólagos, a minta kicsi: 11–13 nem gyári pozíció).
- Figyelmeztetés: a rule_v2 plusza időben olvad (09-30: +0,6…+3,0 hat órás sávonként; 10-01 00–12 UTC: +0,05…+0,1), és a szabálykereső (30 és 60 mp) a 10-01 02:42 UTC utáni ellenőrző részen nem talált nyereséges szabályt (a rule_v2-szerű feltételek ott ≈ 0). A plusz néhány nagy nyerőn múlik – ez a stratégia természete, de ezért kell a ≥ 100 pozíció.

## 2026-10-02 – HIBA: a kilépés-figyelő újraindítás után órákig állt
- Tünet: a 2026-10-01 21:27 UTC-s újraindítás után ~10,5 órán át egyetlen pozíció sem zárult, és egy ár sem frissült (a belépések, pillanatképek mentek).
- Ok: az árfeed újraindításkor minden követett v4 tokenre (~2800 Base + ~900 graduált PONS) egyenként, sorban visszatöltötte a ModifyLiquidity-előzményt (Base: ~10, Robinhood: ~40 getLogs tokenenként) – az első monitor-kör órákig tartott. Korábban ez nem jött elő, mert kevesebb nyitott pozíció volt, és a tokenek egyenként, fokozatosan érkeztek.
- Javítás (`src/exit/pricefeed.ts`): (1) nincs visszatöltés, ha a token felfedezése (graduált PONS-nál a graduáció) régebbi a 20 000 blokknál – a pool létrehozása úgyis kiesne, virtuális becslés marad (Robinhood blokkidő ~0,26 mp → 20 000 blokk ≈ 1,4 óra); (2) körönként legfeljebb 30 token, a legfrissebbek elöl, 6 párhuzamos szálon; (3) a még sorban álló tokenek pozícióit a monitor nem értékeli (`ready()`), különben egy közbeni likviditás-kihúzást nem látna, és a kihúzás előtti áron „adna el”. Újraindítás után ~2 perc alatt helyreállt.
- Szennyezett adat: a 10-01 21:27 és 10-02 06:10 UTC között nyitott pozíciókat a figyelő nem kísérte (a kilépések késve, a helyreálláskori áron történtek), és a leállás előtt nyitott, gyorsan mozgó (Base) pozícióknál is kimaradtak lépések. Érvénytelenítésük (`close_reason = 'invalid_monitor_stall'`) a felhasználó döntésére vár; addig az ebből az időszakból származó eredmények óvatosan kezelendők.
- 2026-10-02 17:xx (a felhasználó kifejezett kérésére, előtte mentés: `data/backup/jev-sniper_2026-10-02_elotte-invalid.db`): 36 025 pozíció `close_reason = 'invalid_monitor_stall'`, nettó 0 – a 10-01 21:27 és 10-02 06:09:50 UTC között nyitottak, valamint a leállás előtti 24 órában nyitott, akkor még nyitott Base-pozíciók. A riport, az állás és a szabálykereső az `invalid%` okú pozíciókat kihagyja.

## 2026-10-03 – Élő pozícióméret 2 USD; árnyékméret fixen 1 USD
- A felhasználó kérésére `risk.base_position_usd: 1 → 2` (élő vétel). Indok: 09-30 óta a beállított kar (`rule_v2_strict`, 60 mp, Base) egyszerre legfeljebb 3 pozíciót tartott nyitva, tehát a tervezett 15 USD Base-tartalék 2 USD-s pozícióknál is bőven elég (~6 USD csúcsigény). A korlátok változatlanok (max. 15 nyitott, 10/óra, 60/nap, betét-plafon 30 USD = 15 × 2 USD).
- Az árnyékpozíciók mérete ettől függetlenül fix: `evaluation.shadow_size_usd: 1` (új beállítás). Eddig az árnyék is az élő/compound méretet használta – ha az változik, az USD/pozíció átlagok és a csúszás a mérés közepén megváltoznának, és a régi számokkal nem lennének összevethetők. A copy és a graduációs árnyékkarok is ezt a fix méretet kapják.
- Élő méret = max(alap, compound-állapot), legfeljebb `max_position_usd` – a DB-ben tárolt régi 1 USD-s compound-érték nem viszi az alap alá.
- Továbbra is `mode: dry_run`: valódi vétel nincs.
- Tárca-ellenőrzés (a felhasználó kérésére: a mérés marad 1 USD, de lássuk, elég-e a tárca 2 USD-hez): az állás-lekérés (`npm run allas`, Telegram `/allas`) új sora az élő kar (`live_entry.arm`, élő ablak, `live_entry.exit_plan`, csak Base) árnyékpozícióiból számolja, egyszerre legfeljebb hány pozíció lett volna nyitva, × az élő méret (2 USD) + gas-tartalék (4 × 0,02 USD/pozíció). A futó bot 10 percenként elmenti a Base-tárca ETH-egyenlegét és az ETH-árat a `meta` táblába (`wallet_base_eth`, `wallet_eth_usd`, `wallet_at`; kulcs nélkül, csak az egyenleg), az állás ehhez hasonlít: ✅ elég / ⚠️ KEVÉS. Feltételezés: az árnyék időzítése = az élő időzítés; a valóságban a sikertelen vétel gasa és a lassabb eladás kissé többet köthet le.

## 2026-10-03 – Telefonos állás; élő vétel csak Base-en
- Telegram `/allas`: rövid sorok (≤ ~30 karakter): élő kar Base- és összes eredménye + „döntésig n/100”, a jelöltek (rule_v2 család, base_uni_hold, nofactory változatok) Base-eredménye átlag·n·Σ formában, alapvonalak (base_uni_all, copy_smart, pons_all, grad_at) egy tömbben, tárca, listázás. A régi hosszú változat: `/allas_reszletes` és `npm run allas`; a rövid: `npm run allas -- --rovid`.
- Megfigyelés: 10-03 reggeltől a rule_v2 karok csak Robinhood-tokenekbe léptek be (Base-en a belépési arány 6–13 ‰-ről 2 ‰-re esett: több a készítői eladás és az induló áresés; a Robinhood/Uniswap indítások száma megugrott, ~336 / 3 óra). A rule_v2_strict eredménye: Base/Uniswap +1,06 (n=32), Robinhood/PONS −0,40 (n=5), Robinhood/Uniswap −0,65 (n=5). A Robinhood-pillanatképek holder- és likviditásadata megbízhatatlan (lásd 10-03 korábbi megjegyzés).
- Ezért `live_entry.chains: [base]`: élő vétel csak Base-en (ott van pénz a tárcában). Az árnyékmérés minden láncon változatlanul fut, a szabályok nem változtak.

## 2026-10-03 (este) – Láncok szétválasztva; RH saját stratégia: graduáció előtti belépés
- Felosztás (a felhasználó döntése): v2 család → Base (élő vétel csak itt, `live_entry.chains: [base]`); a `rule_v2_strict` Robinhood-eredményét külön figyeljük („ha éled a tömeg”); az RH-nak saját stratégiája van. A futó karokon és szabályokon nem változtattunk: a rule_v2 karok minden láncon mérnek, a kimutatás bontja lánc szerint (a pozíciók `chain` oszlopa alapján, visszamenőleg is).
- Adat (10-02 óta, 60 mp-es ártól, 24 óra): Base/Uniswap 643 token, 44,6% ért 2x-et; Robinhood/PONS 1064 token, 0,3%; a PONS 5x+ tokenjei (7 db) mind graduáltak, az első percben jellemzően 0 holderrel / 0 vétellel. A graduált PONS-tokenek fele 5 percen belül graduál (valószínűleg egyben felvásárolva).
- Új árnyékkarok (window 0, eseményvezérelt, `src/graduation/pregrad.ts`): `pons_pregrad_50` (első megfigyelés 50–80% görbe-haladásnál) és `pons_pregrad_80` (80–100%). Haladás = quoteReserve / graduation_threshold, az árfigyelő 15 mp-es görbe-lekérdezéséből (nincs külön RPC). Belépés a görbe aktuális árán, 2% díjjal (curve), 1 USD. Korlátok: csak a már követett tokeneket látja (amelyekben valamelyik kar belépett: pons_all a szűrőn átment PONS-tokenekre); a két ellenőrzés között sávot átugró (gyors) graduációkat kihagyja; újraindításkor a „már belépett” memória elvész, de a pozíció-tábla egyedi kulcsa (token, kar, terv, ablak) megakadályozza a dupla belépést. Csak natív (ETH) quote-ú görbék.
- Telefonos `/allas`: új „🟣 Robinhood” blokk (rule_v2_strict RH, pregrad_50/80, grad_at, grad_15).
- Javítás (ugyanaznap, ~20 perccel a bevezetés után): az első változat újraindításkor a régóta 50–80%-on megrekedt görbéket (6–125 órás tokenek) is belépőnek vette. Mostantól csak megfigyelt ÁTLÉPÉSRE lép be (az előző megfigyelés a sáv alja alatt volt); az első megfigyelés csak kiindulópont, így újraindítás után az első 15 mp nem nyit pozíciót. Az első változat 70 sora (10 token) `close_reason = 'invalid_pregrad_v1'`, nettó 0.

## 2026-10-03 – Időarányos nézet: Telegram /allasplus
- Karonként USD/nap és belépés/nap a lezárt pozíciókból (1 USD-s mérés), a Base-jelölteknél az élő mérettel (2 USD) átszámolt napi érték is; Base és Robinhood külön, USD/nap szerint rendezve. `npm run allas -- --plus` ugyanez a terminálban.
- Aktív idő = az adott kar (lánc, ablak) első érvényes belépésétől most-ig, a kiesett mérési időszak (10-01 21:27 – 10-02 06:09 UTC, a kilépés-figyelő leállása) átfedését levonva – így a később indult karok (nofactory, pregrad) is igazságosan összevethetők. 6 óránál rövidebb aktív időnél nem számol napi értéket.
- Korlát: csak lezárt pozíciók; a lassan záruló karok (graduáció) napi értéke ezért eleinte alulbecsült.
- Módosítás (a felhasználó kérésére): a `/allasplus` megszűnt; helyette a Telegram `/report` (és a napi 06:00 UTC-s riportüzenet) a telefonos összesítést adja: élő kar, időarányos USD/nap · belépés/nap (Base és Robinhood), jelöltek átlag·n·Σ, Robinhood-blokk, alapvonalak, visszaforgatás, tárca, listázás; a teljes markdown riport továbbra is fájlba íródik (a hivatkozás az üzenet végén). Az élő mérettel szorzott oszlop kimaradt (sima szorzás). Terminál: `npm run allas -- --report`.
- Visszaforgatás (compound): a szabály változatlan és már napi felülvizsgálattal működik – a lezárt élő pozíciók nyereségének 30%-a a kasszába, 70% tartalékba; a belépő naponta `compound.recalc_time_utc`-kor (00:00 UTC) = alap + kassza / 15 (max. 10 USD); csúcstól −30%-nál a kassza fele számít. `dry_run`-ban nincs élő lezárás, ezért a belépő 2 USD marad. A riport „Élesben ma” sora szimuláció: az élő kar Base-árnyékeredményei a belépéskori (szimulált) mérettel felszorozva, ugyanazokkal a compound-függvényekkel, napi újraszámolással, 30 USD-s kezdő betéttel (`risk.deposit_cap_usd`).
- 2026-10-03: a belépő felső határa kikapcsolva (`risk.max_position_usd: null`, a felhasználó kérésére: „lehet bármi, majd figyeljük”). A visszaforgatással a belépő korlát nélkül nőhet; a többi korlát marad (max. 15 nyitott, 10/óra, 60/nap, nyitott kitettség ≤ betét + kassza, napi veszteséglimit). Számmal bármikor visszaállítható.

## 2026-10-04 – BNB Chain / Four.Meme: források, első mérés, felvevő
- Források (mind hivatalos, on-chain ellenőrizve: `npm run verify:bnb`):
  - Four.Meme: github.com/four-meme-community/fourmeme-docs (commit 5f7f589, 2026-08-18) – TokenManager2 `0x5c952063…762b` (proxy), TokenManagerHelper3 `0xF251F83e…6034`; ABI: `abi/TokenManager2.lite.json`, `abi/TokenManagerHelper3.lite.json` (a használt elemek változtatás nélkül: `src/abis/fourmeme.ts`). Események: TokenCreate, TokenPurchase, TokenSale (price = lastPrice a kötés után; funds = összegyűlt quote; offers = maradék készlet), TradeStop, LiquidityAdded (graduáció). `quote == 0` → natív BNB. A klasszikus rendszer maradt az alapértelmezett (az OpenFour mellette fut).
  - PancakeSwap v2 Factory `0xcA143Ce3…0c73`, Router `0x10ED43C7…024E` (developer.pancakeswap.finance); WBNB `0xbb4CdB9C…095c` a Router WETH() hívásából.
  - Chainlink BNB/USD proxy `0xd5D290Fe…9022` (Chainlink reference-data-directory, feeds-bsc-mainnet); on-chain decimals() = 18 (nem 8!).
  - RPC: a bnbchain.org dataseed végpontjai nem adnak getLogs-ot; a `bsc-rpc.publicnode.com` igen, de csak ~1,5 óra (≈11 000 blokk) előzménnyel, archív kulcs nélkül. BSC blokkidő mért átlag ~0,45 mp.
  - A TokenManager2 két dokumentálatlan, 1 adatszavas eseményt is kibocsát (topic0 `0x48063b12…`, `0x741ffc46…`, darabszámuk a vételekével/eladásokéval egyezik – valószínűleg díj-elszámolás); nem használjuk.
- Első mérés (10-03 szombat ~22:30–23:40 magyar idő = ázsiai hajnal 4–6 óra, a leggyengébb napszak; ~71 perc): 312 új token (~6 200/nap), ebből 275-nek pontosan 1 vevője volt (valószínűleg a készítő), 31-nek egy sem; 0 graduáció; egyetlen token sem ment 2x fölé az első kereskedési árához képest. A graduációs küszöb (maxFunds) BNB-s tokennél 18 BNB. A „sok indítás” tehát itt is főleg forgalom nélküli tömegindítás – a valódi aktivitás napszaktól/naptól függhet (ázsiai piac), ezért 1–2 napos folyamatos felvétel kell.
- Felvevő (`src/bnb/recorder.ts`, config `bnb.enabled`): a TokenManager2 minden eseménye 5 mp-enként, 100 blokkos getLogs-okkal → `bnb_tokens`, `bnb_trades`, `bnb_grads`; BNB/USD percenként a meta táblába. Nem kereskedik, árnyékpozíciót sem nyit. Időbélyeg becsült (a fejblokkhoz képest 0,45 mp/blokk), a blokkszám pontos. Újraindításkor legfeljebb ~1 óra pótlás (a végpont korlátja). Nem BNB quote-ú tokeneknél a funds/price más egységben van (külön kezelendő az elemzésnél).
- Következő lépés: 1–2 nap adat után visszajátszás – mely tokenek mentek fel (2x/5x/10x), mi látszott rajtuk a belépési pillanatokban (vevőszám, görbe-haladás, idő az indulástól, készítő-előzmény), és erre szabály-jelöltek, árnyékban mérve, ahogy a Base-en.

## 2026-10-04 – Solana / Pump.fun: források, első mérés, felvevő
- Források (hivatalos, on-chain ellenőrizve: `npm run verify:sol`): Pump.fun nyilvános dok. és IDL – github.com/pump-fun/pump-public-docs (commit cb188ce, 2026-09-29). Pump program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, Global `4wTV1Ymi…xnjf` (kezdeti virtuális tartalékok 30 SOL / 1 073 M token, valódi készlet 793,1 M token, díj 100 bps), PumpSwap AMM `pAMMBay6…fXEA` (20 + 5 bps). Események a tranzakció-logban „Program data:” base64-ként (8 bájt diszkriminátor + Borsh): CreateEvent, TradeEvent (az ár = virtuális SOL / virtuális token a kötés után), CompleteEvent (a görbe készlete elfogyott, `real_token_reserves == 0`), CompletePumpAmmMigrationEvent. Görbe-haladás = 1 − real_token_reserves / 793,1 M. Vannak nem SOL-quote-ú tokenek is (`quote_mint`), ezeket jelöljük (`quote_sol`). A díj 2025-09 óta piaci kapitalizációtól függő sávos (FEE_PROGRAM_README) – a költségmodellbe később.
- Kapcsolódás: publikus mainnet RPC/websocket (solana.com/docs/references/clusters; limit 100 kérés/10 mp, 40 kapcsolat; „nem éles használatra”). A `logsSubscribe` a Pump programot említő tranzakciókra egyetlen kapcsolattal működik, 0 dekód-hibával (saját Borsh-olvasó, csak az IDL első mezőiig). A HTTP-s `getTransaction`-höz `maxSupportedTransactionVersion: 1` kell. Nincs előzmény-letöltés (a publikus RPC-n drága), ezért a felvevő csak az indulása utáni tokeneket követi.
- Első mérés (10-04 vasárnap ~00:30–01:00 magyar idő, 2 × 40 mp): ~30–36 ezer új token/nap, ~3,5 millió kötés/nap, ~1,2–1,5 millió SOL (≈ 200+ millió USD) forgalom/nap, ~2 000 görbe-teljesülés/nap; az ablakban indult tokenek kb. harmadának 3+ külső vevője volt az első percben. Ez nagyságrendekkel élénkebb, mint a Base (~1 500 indítás/nap) és a BNB (~6 000, de 1 vevős).
- Felvevő (`src/sol/recorder.ts`, config `sol.enabled`): a napi 3,5 M kötés miatt nem minden kötést ment. `sol_tokens` (minden indítás), `sol_trades` (az indulás óta született tokenek kötései az első 30 percben, tokenenként max. 500), `sol_snapshots` (30/60/180/600/1800 mp: vételek, eladások, külső vevők, SOL be/ki, legnagyobb vétel, ár, görbe-haladás, készítő vett/eladott, utolsó kötés kora), `sol_outcomes` (a 60 mp-es árhoz mért csúcs/mélypont 24 órán át, teljesülés/migráció ideje), `sol_grads`. SOL/USD a Coinbase Exchange nyilvános tickeréből (meta `sol_usd`). Kapcsolat-szakadásnál 3 mp után újracsatlakozik (a kiesett idő adata elvész). Nem kereskedik, árnyékpozíciót nem nyit. Feltételezés: az ár a görbén tisztán a virtuális tartalékokból adódik (nincs pool-mélység kérdés), a csúszást a görbe képlete adja.
- Következő lépés (1–2 nap adat után, előre rögzített jelöltek): „valódi vevők” szabály (N külső vevő + gyorsulás 30/60/180 mp-nél), készítő-előzmény szűrő, görbe-haladás (50/80%) és teljesülés/migráció utáni belépés; véletlen és „minden token” alapvonal. A költségmodellhez: sávos díj + görbe-árhatás; élesítés itt külön végrehajtó réteget igényelne (Solana-tranzakciók), ez most nem cél.

## 2026-10-04 – Solana visszajátszás (első kör): nincs nyerő jelölt; a késleltetés mindent eldönt
- Eszköz: `npm run sol:replay [-- --latency-sec 2] [-- --size-usd 1]` (`src/sol/replay.ts`, `scripts/sol-replay.ts`). A felvett kötés-ár útvonalon (első 30 perc, max. 500 kötés/token) ugyanazzal a kilépési logikával (`planAction`, live/C/B) és −40%-os vészfékkel szimulál, mint az éles bot. Költség: Pump-díj 1,25% + MEV/csúszás 0,3% irányonként + 0,0001 SOL/tranzakció. Az útvonal végén nyitva maradt rész az utolsó áron, eladási költséggel. Időrendi felosztás: tokenek első 2/3-a tanító, utolsó 1/3-a ellenőrző.
- Előre rögzített jelöltek (a felvétel előtt leírva): véletlen 20%, minden token, vevők ≥ 3 / ≥ 10, v2-szerű (≥10 külső vevő, gyorsulás ≥ 1,2, a készítő nem adott el, nincs korábbi tokenje), v2_strict-szerű (gyorsulás ≥ 2; 60 és 180 mp), készítő tart + új készítő, gyors görbe (≥ 60% 60 mp-nél), görbe-átlépés 50% / 80%.
- Adat: 26 000 SOL-párosítású token (10-04 00:29–13:18 magyar idő, vasárnap).
- MÉRÉSI CSAPDA (javítva): késleltetés nélkül (a jelző kötés árán belépve) a „görbe-átlépés 50%” mindkét részen pozitív volt (ellenőrző: +0,10…+0,13 USD/1 USD, CI > 0). 2 mp késleltetéssel −0,07 / −0,12, 5–10 mp-nél is negatív. A jelző kötés ára elérhetetlen (azt már a gyorsabb botok kötötték meg); a Solanán másodpercek alatt elúszik az ár. Ezért a visszajátszó alapból 2 mp késleltetéssel számol MINDEN belépésnél (az ablakos belépéseknél is: ha a sávban volt kötés, az utána következő első kötés ára).
- Eredmény (2 mp késleltetés, live terv): véletlen −0,07, minden token −0,07, vevők≥10 −0,10, v2-szerű −0,11, v2_strict-szerű (60 s) −0,06 / −0,13, (180 s) −0,03 / −0,03, gyors görbe −0,06, görbe-átlépés 50% −0,07 / −0,12, 80% −0,01 / −0,04. A C és B terv ugyanígy. A Base-en nyerő recept („sok külső vevő + gyorsulás”) a Solanán inkább a gyors pumpa-dömping jele (több vevőnél nagyobb a zuhanás aránya).
- Korlátok: csak 13 óra, vasárnapi adat; a 30 perces útvonalvég után nincs követés (a nyitva maradt rész 30–90%); a díj valójában sávos (FEE_PROGRAM_README) – a 1,25% közelítés. A 24 órás kimenetek (sol_outcomes) holnaptól zárulnak, akkor a hosszabb tartás is mérhető.
- Következtetés: a Solanán az „indulás után 1–3 percen belül, nyilvános adatból” típusú belépés – a mi sebességünkkel – nem nyerő. Ha van ott előny, az vagy a sebességben van (ami nekünk nincs), vagy hosszabb időtávon (graduáció után a PumpSwapon, órák alatt) – ezt a 24 órás adat mutatja meg.

## 2026-10-04 – BNB: mérés-ellenőrzés és PancakeSwap v2 felvevő
- A Four.meme-felvétel teljes: 601 blokkban a láncon 90 kötés, mentve 90.
- Megközelítési hiba (javítva az elemzésben): a Four.meme forgalmának nagy része NEM BNB-párosítású. A legforgalmasabb 120 token quote-ja: BNCB (54 token, 5 179 kötés), USDT (10 / 4 848; graduációs küszöb 12 000 USDT), „tőzsdei” tokenek (QQQB, GMEB, NVDAB, SPCXB, MRNAB – a Four.meme „Stock Meme” iránya), natív BNB csak 26 token / 908 kötés. Az első mérés BNB-ben számolt; a további elemzés lánc-semleges mérőszámokkal (árszorzó, funds/maxFunds) készül. A 0 graduáció valós.
- A BNB-memeforgalom nagy része közvetlenül a PancakeSwap v2-n indul: ~22 perc alatt 374 új pár (~24 000/nap), ebből 232 WBNB-pár; a létrehozó tranzakciók címzettje jellemzően ismeretlen szerződés (két gyakori: `0xe2ce6ab8…`, `0x90497450…` – valószínűleg indítóplatformok, hivatalos forrásból még NEM azonosítva) vagy a PancakeSwap Router.
- PancakeSwap v2 felvevő (`src/bnb/pancake.ts`, config `bnb.pancake`): új WBNB-párok (`bnb_pairs`, a létrehozó tx küldőjével és címzettjével), az első 30 perc Swap/Sync eseményei (`bnb_pair_trades`, vétel = WBNB be a párba; tokenenként max. 500), pillanatképek 30/60/180/600/1800 mp-nél (`bnb_pair_snapshots`: vételek, eladások, egyedi vevők a Swap.to alapján, BNB be/ki, ár, WBNB-likviditás), 24 órás kimenet (`bnb_pair_outcomes`: a 60 mp-es árhoz mért csúcs/mélypont, WBNB-likviditás minimuma – kihúzás-jelzés; 30 perc után 5 percenként getReserves-multicall). Ár = nyers tartalék-arány, csak szorzóként. Feltételezések: a Swap.to routeres vételnél a vevő; a „vétel” = WBNB be a párba és WBNB nem jön ki.
- JAVÍTÁS (ugyanaznap, ~20 perccel később): az első változat a PairCreated-et vette indításnak, de a WBNB-párok túlnyomó része üres héj (a tokenszerződés a konstruktorában hozza létre, likviditás soha nem kerül bele; 18-ból 17). A „~24 000 pár/nap, ott a BNB-forgalom nagy része” állítás ezért túlzás volt – a valódi indítások számát az új felvevő méri. Új logika: a friss WBNB-párok 6 óráig „héjként” várnak; 20 mp-enként egy getReserves-multicall nézi, került-e beléjük WBNB; ha igen, a pár naplójából (a legutóbbi üres ellenőrzés blokkjától) az első WBNB-t tartalmazó Sync blokkja az indítás, és az addigi kötések is visszatöltődnek. A publikus végpont cím nélküli getLogs-ot nem enged, ezért nem lehet az összes Mint eseményt egyben figyelni. Korlát: a felvevő indulása előtt létrehozott, később feltöltött párok kimaradnak; 6 óránál később feltöltött párok is. Az első változat 18 sora törölve.
- Újraindítás-állóság (10-04): a Solana- és a PancakeSwap-felvevő a 24 órás kimenet-követést memóriában tartotta, így minden újraindításkor elveszett (10-04-én több újraindítás volt → az addigi tokenek egy részének kimenete nem zárult le). Mostantól induláskor visszatöltik a 24 órán belül indult, még le nem zárt tokeneket/párokat az adatbázisból (a korábbi csúcs/mélypont megmarad). A pillanatkép-ablakok ilyenkor késznek számítanak (a kiesett idő kötései hiányoznak, a hiányos számlálás torz pillanatképet adna). A kiesett időszak alatti csúcsok/mélypontok hiányozhatnak (a Solanán a kimenet a websocket-kötésekből, a PancakeSwapon az 5 perces getReserves-ből folytatódik).

## 2026-10-04 – Ár-józansági szűrő: tartós összeomlás elfogadva
- Hiba: a monitor a belépéshez képest 500x fölötti vagy egymilliomod alatti árat mindig „árfeed-hiba – kihagyva”-nak vette. 10-04-én 8 Base-token ára valóban a belépési ár 2,7e-7…9,3e-7-szeresére zuhant (GOIF, IOF, USDF, TDOF, WWR…); ezek a pozíciók soha nem zárultak le (231 árnyékpozíció: base_uni_all 147, copy_smart 49, random_control 35; a rule_v2 karok nem érintettek), és a napló ~2 200 figyelmeztetéssel telt meg 2 óra alatt.
- Következmény a mérésre: az alapvonalak (véletlen, minden token, copy) kissé jobbnak látszottak a valóságosnál (hiányoztak a −100%-os veszteségek) → a rule_v2 előnye inkább alul-, mint túlbecsült volt.
- Javítás (`sanityCheck`, `src/exit/monitor.ts`): ha a „gyanúsan alacsony” ár legalább 3 egymás utáni ellenőrzésen ÉS legalább 5 percig fennáll (először 20 ellenőrzés volt, de az 1 óránál idősebb pozíciókat a monitor csak 5 percenként nézi – az ~100 perc lett volna), valódi zuhanásnak számít – a vészfék (−40%) a pozíciót azon az áron zárja (≈ teljes veszteség). A felfelé kiugró (>500x) és a nem véges ár továbbra is kihagyás; normál ár a számlálót nullázza. A figyelmeztetés ritkítva (az 1. és minden 50. egymás utáni esetnél). A Base kereskedési szabályai nem változtak.

## 2026-10-04 – Webes áttekintő (HUD)
- A bot folyamatában futó, csak olvasó webszerver (`src/hud/`, config `hud`, alapból 8787-es port, 0.0.0.0): `/` (egyoldalas felület, 10 mp-enként frissül), `/api/summary`, `/api/positions`, `/api/feed`. Tartalom: mód, élő kar, belépő, élő (becsült) PnL (lezárt + nyitott, ma, tempó/nap, napi oszlopok), döntés állása (n/100, 90% CI), visszaforgatás (most és szimulálva), tárca, Base-jelöltek / Robinhood-karok / alapvonalak (átlag · n · Σ · /nap), nyitott pozíciók tokenenként (v2 karok az élő ablakban + RH pregrad: most-x, csúcs-x, fázis, becsült érték), kötésfolyam (belépés, részeladás, zárás), felvevők (Solana, Four.meme, PancakeSwap, listázás).
- Számítás: ugyanazok a függvények, mint a /report és az /allas (1 USD-s árnyékmérés); az „élesben” értékek az élő belépővel lineárisan felszorozva (a saját árhatás 2 USD-nél elhanyagolható).
- Biztonság: titkot nem ad ki (a tárcának csak az egyenlegét); a tokenneveket a felület szövegként jeleníti meg (nem HTML-ként); szigorú Content-Security-Policy. `HUD_TOKEN` a .env-ben → minden kéréshez `?t=<token>` kell.
- Tervezett nyilvános elérés: Cloudflare Tunnel, `tradehud.zentopia.hu` (a `hud` aldomain valószínűleg foglalt). Ekkor javasolt: Cloudflare Access (e-mailes belépés) és/vagy HUD_TOKEN, valamint `hud.host: 127.0.0.1` (csak a cloudflared érje el).
- Második javítás (ugyanaznap): az összeomlott tokenekkel utána senki nem kereskedett, az árfigyelő pedig csak kötéskor kap árat → újraindítás után nem volt ár, a pozíciót a monitor meg sem vizsgálta (és a memóriában tartott számláló is nullázódott). Mostantól a „gyanúsan alacsony” árat és az első észlelés idejét a pozíció menti (`positions.low_price_native`, `low_price_since`); ha 5 percnél régebbi az észlelés, egy friss megerősítés elég, illetve friss ár hiányában a mentett összeomlott áron zár. Normál ár a jelölést törli.
- Egyszeri helyreállítás (`scripts/recover-crashed.ts`): az 5 érintett token (WWR, USDF, IOF, TDOF, GOIF) pooljának utolsó Swap-ja a láncról visszakeresve: mind 2,8e-7…5,7e-7-szeres ár → 210 pozíció megjelölve, a monitor lezárta. Eredmény: mind a 231 beragadt pozíció −1,01-gyel zárult (base_uni_all 147, copy_smart 49, random_control 35). Az alapvonalak így kissé lejjebb mennek (pontosabb mérés); a rule_v2 karokat nem érintette.
- HUD beléptetés (10-04, `src/hud/auth.ts`): jelszó → passkey. A jelszót a felhasználó maga adja meg (`npm run hud:jelszo`, rejtett beírás), a .env-be csak scrypt-lenyomat kerül (HUD_PASSWORD_HASH, N=2^15, r=8, p=1, 16 bájtos só); a lenyomat és a HUD_TOKEN is a naplóból kitakart titok. Munkamenet: 32 bájtos véletlen süti (HttpOnly, SameSite=Strict, HTTPS-en Secure, 30 nap), az adatbázisban csak a SHA-256 lenyomata (`hud_sessions`). Hibás jelszó: IP-nként (Cloudflare mögött `cf-connecting-ip`) 15 percenként legfeljebb 5, összesen óránként 30 → 429. Passkey: WebAuthn a @simplewebauthn/server 14 / browser 14 könyvtárral, csak a configban engedélyezett eredeteken (`hud.origins`: https://tradehud.zentopia.hu, http://localhost:8787 – a WebAuthn HTTPS-t vagy localhostot kíván, LAN-IP-n nem működik); a nyilvános kulcs és a számláló a `hud_passkeys` táblában. Felvétel csak belépve. `hud.password_login: false` → csak passkey; ha egyetlen passkey sincs, a jelszó nem kapcsol ki (kizárás ellen). Biztonsági fejlécek: CSP (frame-ancestors none), X-Frame-Options DENY, no-referrer, nosniff. A HUD alapból csak 127.0.0.1-en figyel (a Cloudflare Tunnel helyben csatlakozik); a helyi hálós (192.168…) elérés ezzel megszűnt.
- Cloudflare Tunnel (10-04): külön, helyben kezelt tunnel `jev-hud` (id 36f76169-…), konfig: `~/.cloudflared/jev-hud.yml` (csak `tradehud.zentopia.hu` → `http://127.0.0.1:8787`, minden más 404), hitelesítő: `~/.cloudflared/36f76169-….json` (titok, nincs a repóban). DNS: CNAME `tradehud.zentopia.hu` → a tunnel (`cloudflared tunnel route dns`). Futtatás: felhasználói LaunchAgent `~/Library/LaunchAgents/hu.zentopia.jev-hud-tunnel.plist` (RunAtLoad + KeepAlive, napló: `~/Library/Logs/jev-hud-tunnel.log`). A gépen már futó másik (token-alapú, rendszerszintű) Cloudflare-tunnelhez és a fiók többi tunneljéhez (cointidy-mac1, stream) nem nyúltunk. Ellenőrizve: / → 302 /login, /api/* belépés nélkül 401, CSP és X-Frame-Options a válaszban, a passkey a https-eredeten elérhető.
- HUD (10-04 este): passkey felvéve („Geri”) és kipróbálva → `hud.password_login: false` (csak passkey; visszakapcsolás: true + újraindítás; passkey nélkül a jelszó magától él). Új „🏆 Nagy nyerők” blokk (`/api/winners`): a v2 karok (élő ablak) és a pregrad karok lezárt nyerő pozíciói tokenenként (a karok közül a legjobb eredmény), élő mérettel; csúcs-szorzó, tartási idő, zárás oka; és hogy az élő kar Base-nyereségéből mennyit adott a top 5 token (és mennyi maradna nélkülük).

## 2026-10-04 – Új árnyék kilépési terv: run70 („hagyjuk jobban futni”)
- Kérdés: a nofactory jobb belépései mellett megéri-e többet tartani? A meglévő tervek közül csak a maradék 20% kifutása tér el (moon10/moon30/trail40/trail60), illetve a C tartja meg a felét (2x-nél 50% el, a maradék csúcstól −35%). Eddig (nofactory, n=8): C +3,12, trail40 +3,10, live +3,06, moon10 +3,04, B +2,75, trail60 +2,63, moon30 +2,20 – a 20% 30x-ig tartása rosszabb (a csúcsok 14–24x körül fordultak).
- run70 (`src/exit/plans.ts`): 2x-nél csak 30% el, a maradék 70% a csúcstól −40%-os visszaesésnél zár (5x-es és 20x-es lépcső nélkül); a −40%-os vészfék a belépéstől és a 7 napos limit ugyanúgy érvényes. 10-04 este óta minden árnyékkar ezzel is nyit (a korábbi pozíciókra nincs – utólagos illesztés elkerülése); a run70 sorai csak az ezutáni belépéseket tartalmazzák, ezért a többi tervvel csak azonos időszakon hasonlítható össze.

## 2026-10-05 – grad_at gyanú: elérhetetlen belépési ár; új grad_30s kar
- Megfigyelés: a grad_at „B” terve 108 lezárt pozíciónál +0,62, 90% CI 0,30…0,99 – formálisan átlépi a döntési küszöböt. Gyanú (a Solana-visszajátszás tanulsága alapján): a grad_at a pool INDULÓ árán (Initialize sqrtPriceX96) lép be, még mielőtt bárki kereskedne; a valóságban csak az észlelés után, másodpercekkel később vehetnénk, amikor a gyors botok már felvitték az árat. A legnagyobb nyerők egy részénél a belépéskori likviditás is 0/ismeretlen (az eladási költség optimista lehet). A top 5 nélkül a 103 pozíció +27,7. → NEM élesítés-jelölt.
- Új árnyékkar `grad_30s` (`src/graduation/index.ts`): a graduáció után 30 mp-cel friss pillanatkép (címke 930), belépés annak VALÓDI pool-árán, szűrő nélkül – a grad_at reális párja; a kettő különbsége az ár-optimizmus mértéke. Korlát: újraindításkor a folyamatban lévő 30 mp-es időzítők elvesznek (mint a +15 percesnél).
- Mellékmegfigyelés (10-03–05): a Base-en a rule_v2 belépési aránya 6–13 ‰-ről ~1 ‰-re esett. Ok: valós piaci változás – a „bot_ratio” (az indulás utáni első 2 blokk vételeinek aránya) miatti kiesés 10–36%-ról 61%-ra nőtt (10-05), több a sniper-bot; a token-kínálat változatlan (80–120/óra). Nem mérési hiba (a számítás nem változott).

## 2026-10-05 – Solana: gyorsabb belépés és alacsonyabb kiszállók sem nyerők
- Kérdés: gyorsabb infóval és alacsonyabb kiszállókkal életképes-e a Solana? Visszajátszás (`npm run sol:replay -- --latency-sec next|1|2 --plans … --only …`), 60 700 SOL-párosítású token (10-04 00:29 – 10-05, hétköznappal), időrendi tanító/ellenőrző felosztás. Új: `--latency-sec next` = a jelzés utáni LEGELSŐ kötés ára (nagyon gyors bot legjobb esete; a kötések időbélyege mp-es, ennél finomabbat az adat nem mutat); „scalp” tervek `tp<X>_sl<Y>` (teljes eladás X-szeresnél vagy Y% esésnél; csak a visszajátszásban).
- Eredmény (tp1.2_sl10, tp1.3_sl15, tp1.5_sl20, tp2_sl30, live × next/1/2 mp × véletlen, minden token, v2_strict-szerű 180 s, gyors görbe, görbe-átlépés 50/80%): EGYIK kombináció sem pozitív mindkét részen. A véletlen kontroll −0,06 – ez nagyjából a költség (Pump-díj + MEV 2 × 1,55% + 2 × 0,0001 SOL ≈ 1,2% egy 1 USD-s pozíción) – a piac a költségeken túl „tisztességes”, a jelek nem adnak érdemi előnyt. A legjobb tanító sorok (görbe-átlépés 80% scalp: +0,01…+0,03) az ellenőrző részen negatívak (−0,02…−0,08).
- A „next” és a 2 mp-es késés között alig van különbség: a jelzés utáni 1–2 mp-ben ritkán van kötés; a valódi előny az UGYANABBAN a slotban (≤0,4 mp) vett belépésben lenne, amit a publikus adat és végpont nem lát – ehhez fizetős, alacsony késleltetésű infrastruktúra (pl. Jito-csomagok) kellene, és akkor is versenyben a profi botokkal. Következtetés: a Solana indulás-snipelés nekünk nem életképes; a felvevő pár nap múlva leállítható.
- Gyorsabb (fizetős) végpont a többi modellnél: a Base fő stratégiája 60 mp-cel az indulás után lép be, a kilépések 15 mp-es ütemben – a sebesség itt nem szűk keresztmetszet (a visszajátszott/árnyék eredmény már a mi ütemünkkel számol). Élesítéskor a megbízhatóság miatt (rate limit, Robinhood RPC-hibák) lehet érdemes fizetős végpontra váltani.

## 2026-10-05 – HIBA: a Robinhood-pillanatképek órákat késtek (torlódó mérési sor)
- Tünet: a grad_30s alig nyitott pozíciót. Ok: a gyűjtő láncenként legfeljebb 2 pillanatképet készít egyszerre; a Robinhoodon a tokenszám megugrott (napi ~3 800, tokenenként 3 ablak) és a végpont lassú/hibás → a sor 10-02 óta szinte folyamatosan torlódott: a „30/60/180 mp-es” pillanatképek óránkénti átlagkésése többnyire 1–13 óra (minden újraindításkor nullázódott, majd újra nőtt). A Base-en a késés ≤3 mp volt (külön sor).
- Érintett (a pillanatkép árán/jellemzőin belépő Robinhood-karok): pons_all (91% késve), random_control a Robinhoodon (90%), rule_v2 / strict / nofactory / nojev a Robinhoodon (~43%), rule_score, grad_15_all / grad_15_hold (~85%). NEM érintett: minden Base-kar, a pregrad (árfigyelőből), a grad_at (az Initialize-eseményből), a copy karok. A korábbi „Robinhood v2 −0,48” és a pons_all eredmények ezért nagyrészt hamisak voltak; a riport „véletlen kontroll” sora (60 mp, minden lánc) is tartalmazta a késve nyitott Robinhood-pozíciókat.
- Javítás: (1) határidő – ha a pillanatkép a sorban állás után a tervezett időpontnál 30 mp-nél többet késne, kimarad (`StaleSnapshotError`, számláló a /status-ban), a graduációs +30 mp / +15 perc mérésnél is; (2) Robinhood-párhuzamosság 2 → 4.
- Adat-javítás: 277 691 ablakos és 101 graduációs Robinhood-pozíció, amelynek a belépése >60 mp-cel a tervezett pillanat után történt, `close_reason = 'invalid_snapshot_lag:<eredeti ok>'` jelölést kapott (a nettó eredmény megmaradt, a statisztikák kihagyják; a nyitottak lezárva, nettó 0).
- Utóhatás (ugyanaznap): Robinhood 4 párhuzamos mérésnél a Base-mérések késni kezdtek (átlag 5–7 mp, csúcs 30 mp; 30 perc alatt 69-ből 4 Base-tokennek kimaradt a 60 mp-es mérése). Javítás: Robinhood 3 párhuzamos, és a Base elsőbbséget kap (ha Base-mérés vár, új Robinhood-mérés nem indul; felszabaduláskor előbb a Base-várakozó).

## 2026-10-05 – Copy trading kikapcsolva
- A felhasználó döntése: ebben a formában nem folytatjuk (`copy.enabled: false`). Eredmény 09-30 óta: copy_smart −0,74 (n≈300), copy_unskilled −0,2 – a „jó” tárcák követése rosszabb volt a „rosszaknál” is. Mellékhatás: a tárcakövetés napi ~1 millió `wallet_trades` sort és sok RPC-hívást takarít meg. A meglévő adatok (wallet_trades, wallet_lists, copy pozíciók) megmaradnak.

## 2026-10-05 – Solana, második jelöltkör (új megközelítések): szintén nem nyerő
- Előre rögzített jelöltek (`npm run sol:replay -- --extra`): X1 készítő korábbi tokenje graduált (+ vevők≥3), X2 sorozatgyártó (kontroll), X3 első ezzel a névvel / 3+ másolat 24 órán belül, X4 dev első vétele ≥1 SOL / <0,1 SOL, X5 csomagolt indítás (5+ vétel az első mp-ben) vs. nem csomagolt, X6 „okos tárca” követése (olyan tárca korai vétele, amelynek 2+ korábbi korai vétele később graduált; a tárca pontszáma csak a vétel előtti adatból). Belépés 60 mp-nél (X6: a jelző vétel után 2 mp), tervek live / C / tp1.5_sl20, tanító–ellenőrző felosztás, 60 700 token.
- Eredmény: MINDEN jelölt mindkét részen −0,05…−0,09 (a véletlen kontroll −0,06), vagyis a költség körül. A kontrollok (sorozatgyártó, csomagolt) sem térnek el érdemben. Az X6 túl laza (25 800 tokenre jelzett – 2 000 graduáció/nap mellett 2 találat nem szelektív); találati arány alapú pontozással finomítható, de az eddigi kép szerint az első 30 perc árútja a költségen túl „zajos sétához” hasonlít mindenki számára, aki nem az indítás blokkjában vesz.
- Teszteletlen irányok: (a) graduáció UTÁNI kereskedés a PumpSwapon (órás tartás; ~2 000 graduáció/nap → gyorsan nagy minta; ehhez a pump_amm program eseményeinek felvétele kell), (b) 30 percnél hosszabb görbe-szakasz a túlélő tokeneken (a felvevő csak az első 30 perc kötéseit menti).

## 2026-10-05 – Solana: új megközelítés – túlélők és a graduáció utáni szakasz (órás táv)
- Durva 24 órás kép (31 190 lezárt kimenet; „valaha elért csúcs” a 30 perces árhoz, a 30 perc ELŐTTI csúcsot is tartalmazhatja – torzított): a 30 percnél 10–50%-os görbe-haladású túlélők 48%-a ért 2x-et, 27%-a 5x-öt; 50–90%-nál 60% / 27% (de 78% felezett is); <10%-nál 10% / 5%. A nagy mozgás tehát a túlélő, félig feltöltött görbéknél a 30 perc UTÁN látszik – ott, ahol nincs blokk-sebességű verseny. Ez a jelöltek harmadik köre: előre rögzítve, de csak a tiszta (30 perc utáni) útvonalakon mérhető.
- Felvevő-bővítés: (1) túlélők – ha a 30 perces pillanatképnél a haladás ≥ 10% és nincs teljesülés, a görbe-kötések 6 óráig / a teljesülésig mentődnek (max. 3 000/token), és a kimenet a 30 perces árhoz is mérve (`sol_outcomes.ref30_price/max_x30/min_x30`); (2) PumpSwap AMM felvevő (`src/sol/amm.ts`, config `sol.amm`): a pump_amm program CreatePoolEvent/BuyEvent/SellEvent eseményei (IDL: pump-public-docs idl/pump_amm.json), csak SOL-quote poolok (WSOL mint `So111…112`), kötések az első 6 órában (max. 3 000/pool), pillanatképek 60/300/900/3600 mp-nél, kimenet az 5 perces árhoz 24 órán át, a pool SOL-tartalékának minimumával. Ár = quote-tartalék / base-tartalék a kötés után (base 6, quote 9 tizedes). Külön websocket-kapcsolat (a publikus limit 40).
- Jelöltek (előre rögzítve, 2–3 nap adat után): S1 túlélő belépés 30 percnél haladás-sávonként (10–50 / 50–90%), S2 graduáció után +5 perc az AMM-en (szűrő nélkül = alapvonal), S3 AMM +5 perc, ha a pool SOL-tartaléka nő és vevők ≥ N, S4 AMM-en a 15 perces visszaesés utáni belépés (csúcstól −30…−50%, de tartalék stabil). Kilépés: live / C / run70 + scalp; 2 mp késés; költség: AMM 25 bps + MEV.
- Pool-felvétel (10-05 este): a migrációs tx logja a logsSubscribe-ban csonkolódik, a CreatePoolEvent kimarad (5 migrációból 1 pool látszott) → a poolok a görbe-felvevő migrációs eseményéből (pool + quote_mint) is felvéve; a SOL-párt ott a nulla pubkey jelöli (PUMP_PROGRAM_README: `Pubkey::default()`), a pool-eseményben a WSOL mint. Ellenőrzés: 10 perc alatt 5 SOL-migráció → 7 követett pool (a többlet CreatePoolEvent-ből), 4 279 kötés, CPU ~10%.

## 2026-10-06 – PONS-specifikus jelöltek visszajátszása (Robinhood)
- Adat: `pons_all` árnyék-pozíciók 10-02 06:00 UTC-től (érvénytelenítettek nélkül), a belépési ablak (30/60/180 s) pillanatképének jellemzőivel. Nyitott pozíciók: utolsó áron, 3% eladási költséggel becsülve (a 75–85% nyitott, többnyire mozdulatlan görbe).
- Időrendi bontás: tanító < 2026-10-04 18:00 UTC ≤ teszt. 90% bootstrap CI a teszten.
- Előre rögzített jelöltek (az eloszlás megnézése után, az eredmény előtt): P1 görbe ≥ 60%; P2 ≥ 10 egyedi vevő; P3 ≥ 5 vevő, bot ≤ 0,3, készítő nem adott el; P4 = P1 ∧ P3; P5 = P2 ∧ készítő korábbi tokenjei ≤ 5. Kiszállási tervek: C, live, B, run70, moon10; plusz optimista felső becslés: teljes eladás 1,5x/2x/3x-nél (ha a csúcs elérte).
- Eredmény: minden jelölt, minden ablak és terv negatív a teszten (−0,14…−0,37 USD / 1 USD), a szűrők ROSSZABBAK a válogatás nélküli belépésnél (−0,10…−0,12). Az aktív (sok vevős, gyors görbéjű) tokeneket gyakrabban húzzák ki; a SPLIT/GULP-féle futás ritka (a P1-nek is csak ~15%-a ér 2x-et).
- Következtetés: a PONS induló-szakasz a jelenlegi jellemzőkkel és sebességgel nem ad előnyt; a futó karok (pons_all, pregrad, grad_*) viszonyításnak maradnak.
- Base (10-06): kevés v2-belépés (napi 15–22 → 2–3) nem hiba: a pillanatképek késése < 1 s, a jellemzők eloszlása változatlan, de a ≥10x futók száma is visszaesett (napi 2–8 → 0–1); a fő elutasítási ok a gyenge gyorsulás és a kevés tulajdonos.

## 2026-10-06 – HIBA (javítva): hamis PONS-graduációk (idegen por-poolok)
- Tünet: a grad_at „nyerők” 15–30x-os csúcsokon zártak, de 90%-os eladási csúszással (MINIONS: 30x → −0,04 USD); a grad_at ár sok tokennél a görbe 80%-os ára ALATT volt; a 30 mp-es pool-ár néhol 7–14x.
- Ok: a figyelő minden későbbi v4 Initialize-t, amelyben a PONS-token szerepelt, graduációnak vett. Botok idegen, nem PONS-hookos, 79–88% díjú por-poolokat (~0,0003 ETH) nyitnak a görbén lévő tokeneknek. A 3 527 „graduációból” csak 197 volt valódi (PONS v2 hook `0xe5e7…e044`, díj 0, tickSpacing 200, ~5,5 ETH likviditás, egységes induló ár). A hamis graduáció után az árfigyelő a por-poolból olvasta az árat (a görbe helyett), és a valódi graduációt, ha a por-pool előbb jött, nem vette észre (619 token).
- Javítás: `src/watchers/index.ts` – PONS-tokennél csak a PONS v2 hookos PoolKey graduáció (`isOfficialPonsPool`), és ez felülírja a korábbi PoolKey-t; az idegen poolokat figyelmen kívül hagyja. `scripts/fix-fake-grads.ts`: 2 711 token vissza görbére (graduated_at/pool_key_json = NULL), 619 token a hivatalos PoolKey-re (factory rekord + hook) és a valódi graduációs időre (Initialize esemény blokkideje). 15 710 pozíció `invalid_fake_pool:<eredeti ok>` (a hamis graduáció után még nyitva voltak, vagy a hamis graduáción nyíltak).
- Mellékmegfigyelés (nem módosítva, csak értelmezés): a PONS görbe `quoteReserve`-je a graduációs küszöb 40%-ával (virtuális tartalék) indul, így a `bonding_curve_progress_pct` (= quoteReserve / küszöb) friss tokennél is 40%. Valódi haladás = (nyers − 40) / 60. A pregrad karok nyers sávjai: 50–80 ≈ valódi 17–67%, 80–100 ≈ valódi 67–100%. A futó szabályok (rule_v2_strict curve<60 Robinhoodon, pregrad sávok) változatlanok.

## 2026-10-06 – Új RH mérőkar: `pons_flip95` („95%-on be, graduáción ki”), csak árnyékban
- Indok (a javított adatokon): a 4,2 ETH-s PONS-görbe végára 1,05e-8, a hivatalos pool induló ára mindig 2,058e-8 (~1,96x); nyers 95%-on (9,5e-9) vásárolva ez ~2,17x. A ≥95%-ot elérő tokenek durván ~55%-a graduált (18/33, kis és torzított minta).
- Előre rögzítve (eredmény előtt): belépés a NYERS görbe-haladás 95%-ának átlépésekor (előző megfigyelés < 95 ≤ mostani < 100; nyers 95 ≈ valódi 91,7%), a görbe aktuális árán, curve-díjjal (2%), 1 USD; tokenenként egyszer; csak natív quote. Figyelés: a 15 mp-es árfigyelő-körből a nyers ≥ 85% görbék „forró” listára kerülnek, ezeket 2 mp-enként külön multicall olvassa (`src/graduation/flip.ts`).
- Kiszállás, `flip` terv (`src/exit/plans.ts`): minden eladva ≥ 1,5x-nél (a görbén 95→100% között legfeljebb ~1,11x lehet, tehát ez csak a graduációs ugrás), ≤ 0,75x-nél stop, 15 perc után zárás; a vészfékek is élnek. Összevetésül ugyanez a belépés a `live` tervvel is.
- Ismert korlátok: (1) a belépési ár a megfigyeléskori ár (valódi tx 1–2 blokkal később); (2) a graduáció után az ár csak pool-kötésből frissül, a monitor 15 mp-enként néz → az eladás a graduáció utáni első 15–30 mp valamelyik kötésének árán; (3) ha graduáció után 15 percig nincs pool-kötés, a timeout a régi görbe-áron számolna – ezeket a kiértékelésnél külön kell venni (`flip_timeout_15m` + graduált token).
- Kiértékelés: ≥ 100 lezárt, 90% CI > 0, második független időszak – a szokásos szabály.
- HELYESBÍTÉS (10-06 délután, OVLO): a PONS-görbe a küszöbön TÚL is kereskedhető – a graduációt külön kell meghívni, addig a vételek folytatódnak (OVLO: a görbe a végár ~1,8x-éig ment, `graduated = false`, majd a készítő mindent eladott, a quoteReserve vissza 1,69 ETH-ra). A „≥ 1,5x csak graduációval lehetséges” feltevés tehát hamis; a `flip` terv ettől még valós (a görbén elérhető) árat mér, de a kiértékelésnél külön kell bontani: graduált / küszöb fölött nem graduált / nem érte el a küszöböt. A tervet nem módosítom (előre rögzített).
- Javítás-mellékhatás (10-06): a hamis graduációkon nyitott, `invalid_fake_pool` grad_* sorok az egyedi kulcs (token, kar, terv, ablak) miatt blokkolták a későbbi valódi graduáció mérését (pl. PURE 09:38). A még nem graduált tokenek ilyen sorai (5 948 sor + a szimulált eladásaik) törölve; a már graduált tokenekéi maradnak (ott a valódi graduáció úgyis kimaradt).

## 2026-10-06 – HUD: lassú frissítés (javítva) + frissítés gomb
- Tünet: a HUD „nem frissült”. Ok: egy frissítés négy lekérdezése a 750 ezer soros `positions` (és 420 ezer soros `fills`) táblán index nélkül ~23 mp volt, az oldal pedig 10 mp-enként kért újat; a better-sqlite3 szinkron, így ez a bot fő szálát is megakasztotta. Az adatbázis ráadásul nem WAL-módban futott: a hosszú olvasások (HUD, riport, kézi lekérdezés) a bot írásait is blokkolták („database is locked”).
- Javítás: (1) `PRAGMA journal_mode = WAL` + `busy_timeout = 5000` (`src/db/index.ts`); (2) indexek: `idx_positions_arm (arm, window_sec, exit_plan, chain, opened_at)`, `idx_positions_plan_opened (exit_plan, opened_at)`, `idx_fills_position (position_id, kind)`; (3) a HUD adatai külön szálon (`src/hud/worker.ts`, saját csak olvasó kapcsolat), egy közös `/api/all` válaszban, 30 mp-es gyorsítótárral (a „friss” kérés legalább 5 mp-enként számol újra); (4) az oldalon 🔄 gomb, 30 mp-es automatikus frissítés, és a kijelzett idő az adat számításának ideje. Mérés: ~23 mp → ~8,5 mp, a bot szálán kívül.
- HUD gép-állapot (10-06): CPU (gép: minden mag átlaga `os.cpus()` különbségből; bot: a folyamat `process.cpuUsage()`-e egy magra vetítve, a HUD-szállal együtt), memória (macOS `memory_pressure` „free percentage”, mert az `os.freemem()` a gyorsítótár miatt félrevezető), tárhely (`statfs` az adatbázis kötetén), adatbázis-méret (db + wal + shm). 10 mp-es mintavétel a fő szálon; `/api/system` és az `/api/all` része.

## 2026-10-06 – „BELÉPNE” jelzés útvonal nélküli tokenre (javítva)
- Eset: CHUBBY (Base, Uniswap **v2** pool) – a rule_v2_strict belépett volna, a Telegram „BELÉPNE” üzenetet küldött, de pozíció nem nyílt, mert v2/v3 poolra nincs ár- és végrehajtási útvonal (az árnyékmérés is csak görbére és v4-re nyit, lásd korábban).
- Javítás: az élő döntés útvonal nélkül `no_route:<mechanics>` okkal blokkol, jelzés nélkül. Súly: 09-30 óta a strict 42 Base-belépéséből 2 lett volna v2/v3 (1 v2, 1 v3) → a v2/v3 útvonal most nem sürgős.
- HIBA (10-06, javítva): újraindításkor a Robinhood RPC (`rpc.mainnet.chain.robinhood.com`) átmenetileg Cloudflare-ellenőrzéssel 403-at adott; a figyelő indulási `getBlockNumber` hívása védelem nélkül volt (`void w.start()`), a kezeletlen hiba az egész botot leállította. Javítás: a figyelő induláskor újrapróbál (≥ 10 mp-enként); `unhandledRejection` kezelő (naplóz, a bot fut tovább).

## 2026-10-07 – Solana + BNB harmadik kör: előre rögzített jelöltek (a futtatás ELŐTT leírva)
- Adat: PumpSwap-poolok (SOL-páros, ≥ 6 órás, ~1 500), Pump.fun-túlélők (30 percnél ≥ 10% haladás, kötések 6 óráig, ~1 800; görbe→AMM összefűzve a migráció után), PancakeSwap-indítások (≥ 6 órás, ~3 700). Horizont 6 óra (a végén nyitott pozíció az utolsó áron, eladási költséggel).
- Módszer: időrendi bontás az entitás indulása szerint (első 2/3 tanító, utolsó 1/3 ellenőrző); 90% bootstrap CI az ellenőrzőn; véletlen kontroll (20%, determinisztikus) és „minden” alapvonal. Késés: SOL 2 mp, BNB 3 mp – eseményvezérelt belépésnél a jelzés utáni első, legalább ennyivel későbbi kötés árán (ha nincs, nincs belépés). Költség: PumpSwap 0,25% + 0,3% MEV + 0,0001 SOL/tx; görbe 1,25% + 0,3%; PancakeSwap 0,25% + 0,5% MEV/csúszás + 0,006 USD gáz/tx (BSC gázár 10-07: 0,05 gwei). BSC token-adó ismeretlen → 0 (optimista; élesítés előtt ellenőrizendő).
- Kilépési tervek: live, C, run70, tp1.5_sl30, tp2_sl40, tp3_sl50, tr40 (tiszta követő stop −40% a csúcstól, cél nélkül).
- ~38 jelölt × 7 terv ≈ 270 teszt → 5%-os szinten ~13 hamis „pozitív” várható VÉLETLENÜL is. Ezért egy cella önmagában nem bizonyíték: ✔ csak ha tanító > 0 ÉS ellenőrző 90% CI alja > 0 ÉS n ≥ 30, és egy jelölt-CSALÁD (több terv/ablak) egy irányba mutat. Ami ✔, az is csak árnyék-mérésre jelölt, nem élesítésre.
- PumpSwap (A): A0 véletlen +5p; A1 minden +60s; A2 minden +5p; A3 minden +15p; A4 minden +60p; A5 lendület +5p (tartalék nő 60s→5p, vevők ≥ 100); A6 erős lendület +15p (ár 60s<5p<15p, tartalék nem csökken); A7 visszaesés-vétel (+5p után ár ≤ 0,6× csúcs, tartalék ≥ 0,8× tartalék-csúcs); A8 kitörés (15p után új csúcs, ≥ 10 perc csúcs nélkül); A9 mély esés (ár ≤ 0,5× a 60s-ár 1 órán belül, tartalék ≥ 0,7× induló); A10 csendes gyűjtés +15p (sells < buys, vevők 15p ≥ 1,5× 5p, ár ±20% az 5p-hez); A11 bálna-vétel (első ≥ 5 SOL vétel +5p után); A12 késői volumen-robbanás (15p után 5 perces blokk vételei ≥ 3× előző és ≥ 30); A13 mayhem-poolok +5p; A14 a készítőnek volt korábbi migrált tokenje +5p; A15 nagy pool (tartalék(60s) ≥ 150 SOL) +5p.
- Túlélők (S): S0 véletlen +30p (10%+); S1a 10–30%, S1b 30–50%, S1c 50–90% +30p; S1d 50–90% és ≥ 5 vevő az utolsó 5 percben; S1e haladás +15 pont 10p→30p; S2 90%-átlépés 30p után (összefűzött görbe→AMM út); S3 50%-átlépés 30p után.
- PancakeSwap (B): B0 véletlen +60s; B1 minden +60s; B2 +3p; B3 +10p; B4 +30p; B5 liq(60s) ≥ 5 BNB és vevők ≥ 10; B6 router-indítás; B7 egyéb indító (0xc9b7…); B8 liq nő 30s→3p ≥ 1,2× és vevők ≥ 15, +3p; B9 visszaesés (10p után ár ≤ 0,6× csúcs, liq(10p) ≥ 0,8× addigi max); B10 kitörés (új csúcs 10p után, ≥ 30 vevő); B11 túlélte az eladásokat +10p (sells ≥ 0,5× buys, ár ≥ 60s-ár); B12 rug-biztonság +10p (liq(10p) ≥ 0,8× liq(30s), vevők ≥ 20); B13 bálna-vétel ≥ 1 BNB +60s után; B14 nagy indulás (liq(30s) ≥ 20 BNB) +60s.

## 2026-10-07 – Solana + BNB harmadik kör: eredmény (`npm run replay:solbnb`, riport: reports/solbnb_2026-10-07.md)
- Mérési hibák, amelyeket az első futás „túl szép” számai (BNB +27 trillió USD) leplezték le, sorban javítva a visszajátszóban:
  (1) kiürült pool/pár árpontjai (porszem-vétel 10^27-szeres „árat” ad) → BNB: a kötésekből visszaszámolt konstans-szorzatú tartalék (< 0,05 BNB = kiürült), SOL: pool_quote < 0,2 SOL → onnantól a pozíció értéke 0;
  (2) túlélők görbe→AMM összefűzése: csak a hivatalos pool (init ≥ 50 SOL vagy migrációból felvett) és csak időben folytonos (≤ 10 perc) – a „kalóz” 0,3 SOL-os poolok és az órákkal későbbi ár hamis ugrást adott;
  (3) kiszállási késés: a jelző kötésen nem lehet eladni → a legalább 2–3 mp-cel későbbi első kötés árán;
  (4) honeypot: ≥ 10 vétel és 0 eladás a horizonton → eladhatatlan (0);
  (5) a LEGNAGYOBB: a késve észlelt entitásoknál a felvevők az ÖSSZES ablak pillanatképét egyszerre, utólag írták (pl. 0x846c…: mind az öt „pillanatkép” a kihúzás utáni 7,97-es árral, a 60. mp-ben a kötések ~1 300-on) → a visszajátszó belépési ára csak a kötésekből jön (az ár két kötés között nem változik), pillanatkép csak ±90 mp-es időbélyeggel számít (BNB: 911 / 3 220 párnak van ilyen). A felvevők (pancake, amm, sol) javítva: 90 mp-nél régebben lejárt ablakra nem írnak pillanatképet (`lateSnaps` statisztika).
  (6) a 24 órás kimenet szerint kiürült pár (min_liq < 0,05 BNB) → a horizont végén nyitott pozíció értéke 0 (a kihúzás pontos ideje ismeretlen: Sync swap nélkül nincs felvéve).
- **Solana: minden jelölt negatív** – PumpSwap A0–A15: ellenőrző −0,07…−0,31 (a legjobb a „minden +60p” −0,07, a költség körül); túlélők S0–S3: −0,01…−0,61 (S2 90%-átlépés −0,01, n=24). A 15 ötlet (lendület, visszaesés, kitörés, bálna, volumen-robbanás, mayhem, készítő, nagy pool, csendes gyűjtés) egyike sem ad előnyt a mi sebességünkkel. Solana-irány lezárva, amíg nincs új ötlet VAGY gyorsabb (saját RPC/Jito) infrastruktúra.
- **BNB / PancakeSwap: két jelölt tartja magát a tanító és az ellenőrző időszakban is** (2 mp-es… 3 mp-es késéssel, költséggel, kiürülés/honeypot = 0):
  - **B13 bálna-vétel**: ha +60 mp után valaki ≥ 1 BNB-t vesz, a következő kötésen belépés, kiszállás 2×-nél vagy −40%-nál (tp2_sl40): tanító +0,54 (n=379), **ellenőrző +0,85 [+0,48; +1,47] (n=204)**; más tervvel is pozitív (C +0,46, tp1.5 +0,65, run70 +0,19), a „live” terv −0,07 (túl lassú kiszállás).
  - **B1 minden indítás +60 mp**, tp2_sl40: tanító +0,13, **ellenőrző +0,13 [+0,08; +0,18] (n=927)**; a nyereség a ≥ 10 BNB likviditású pároknál (+0,23, n=1 783), a 2–10 BNB-seknél −0,07. +3 perc már −0,41, +10 perc −0,76: az indítási pumpa az első 1–2 percben van.
  - Az eredmény a scalp-tervektől függ (tp1.5/tp2 pozitív; live/run70/tr40 erősen negatív): a BSC-indítások 56%-a ér 2×-et a 60 mp-es ártól, de utána 54% kiürül – gyorsan ki kell szállni.
- NEM ellenőrizhető a felvett adatból (optimista feltevések, ezért élesítésre NEM jelölt): (a) hogy MI el tudunk-e adni (feketelista/whitelist, „anti-bot” adó: mások eladása nem bizonyítja a miénket); (b) token-adó (0-nak vettük); (c) MEV/szendvics a vételnél. Ezért a következő lépés árnyék-mérés valódi eladás-szimulációval: +60 mp-nél `eth_call` egy valódi tulajdonos címéről (egy friss vevő `to` címe) PancakeSwap `swapExactTokensForETH`-tel (honeypot/adó teszt), és csak ha az átmegy, nyílik az árnyékpozíció; a kiszállás a scalp-terv szerint a következő kötés árán.

## 2026-10-07 – BNB árnyékkarok élesben mérve (`bnb_all60`, `bnb_whale`) + HUD
- Modul: `src/bnb/shadow.ts`, tábla `bnb_shadow_positions` (+ `bnb_shadow_skips`). A PancakeSwap-felvevő minden kötésnél (és 30 perc után az 5 perces tartalék-frissítésnél) eseményt ad, a kör végén (`step`) dől el a belépés/kiszállás.
- A visszajátszáshoz képest SZIGORÚBB (reális) végrehajtás: belépés és kiszállás a kör végi AKTUÁLIS áron (a felvevő 5 mp-enként néz; a jelző kötés ára elérhetetlen); a kiszállási jelzés a kör alatt látott legmagasabb/legalacsonyabb kötésár. Késve (> 60 mp) látott jelzésnél nincs belépés (`late`).
- Eladhatósági próba belépés előtt: friss vevő (Swap.to, nem a router) egyenlege, majd `eth_call` token.transfer(pár, egyenleg/10) a nevében – visszadobás = `honeypot` (kihagyva, `bnb_shadow_skips`). Nem méri: a token-adót (0-nak vesszük), a csak-bizonyos-összeg feletti tiltást, a később bekapcsolt tiltást. Ezért az eredményt a kimenetből (pl. adós tokenek aránya) még ellenőrizni kell, mielőtt bármi élesítés szóba kerülne.
- Tervek: tp2_sl40 (fő, előre rögzítve), tp1.5_sl30, C. Költség: 0,75% oldalanként + 0,006 USD/tx gáz; méret 1 USD (árnyék). Kiürülés (WBNB < 0,05) = 0; 6 óra után zárás.
- HUD: BNB-blokk (karonként a fő terv; a buborékban a többi terv, nyitott pozíciók, a kiszűrtek száma). Minden kar sorára egeret húzva (telefonon koppintva): nyitott pozíciók (a legfrissebb 12: név, jelenlegi szorzó, kor), „nyitva most” és „legtöbb egyszerre” × az élő belépő-méret = tőkeigény (most / valaha max), + gáz. A „legtöbb egyszerre” a pozíciók nyitási/zárási idejéből számolt csúcs (érvénytelenítettek nélkül).
- HIBA (10-07 délután, javítva): a publicnode BSC-végpont 2026-10-07 óta legfeljebb 9 címet fogad egy `eth_getLogs`-ban (10+ → „Invalid parameters”). A PancakeSwap-felvevő 100-as adagokat küldött, így minden kör hibára futott, és ~12:40 UTC-től a felvevő állt (a hiba csak debug-szinten látszott); a BNB árnyékkarok ezért nem kaptak friss adatot. Javítás: 8 címes adagok, 4 párhuzamos kéréssel, blokk/log-index szerint rendezve (a Sync→Swap sorrend számít); 12 egymás utáni hibás kör után WARN a naplóban. Az adatgyűjtésben ~12:40–13:10 UTC között hiány van.
- HIBA (10-07, javítva): a BNB árnyékkar a belépés körében is kiértékelte a kiszállást, a kör eleji (a belépés ELŐTTI) mélyponttal – a bálna-vétel előtti alacsony ár azonnali „−40%-os stopot” váltott ki a belépési áron (−0,03). Javítás: a belépés körében nincs kiértékelés; a 3 hibásan (1 mp-en belül) zárt sor törölve. Teszt: a javítás nélkül elbukik.

## 2026-10-07 – BSC token-adó mérése a láncról (BNB árnyékkarok)
- Módszer (`src/bnb/tax.ts`): a pár felvett vételeinek/eladásainak nyugtáiból (pároként legfeljebb 3+3 tx, medián). Vételi adó = 1 − (a címzett egyenlegének nettó növekedése a tx-ben) / (a pár Swap-ja szerint kiküldött token); eladási adó = 1 − (a pár által kapott token, Swap amountIn) / (az eladó által elküldött token). Aggregátoron át továbbküldött tx nem mérhető (kimarad). Unit teszt: szintetikus 5% / 10% adó.
- Nyugták: a BNB Chain hivatalos nyilvános végpontja (`bsc-dataseed.bnbchain.org`, docs.bnbchain.org „BSC RPC Endpoints”); a publicnode a néhány óránál régebbi nyugtát csak személyes tokennel adja („Archive requests require a personal token”).
- A bot belépés után (és zárásnál, ha még nem volt eladás) méri; a mai pozíciók: `scripts/bnb-tax-backfill.ts`. Eredmény (10-07, 162 pozíció): 143 db 0%, 11 db < 5% (átl. vétel 0,5%, eladás 1,1%), 1 db 10%/10%, 7 nem mérhető. Adóval korrigálva: bnb_all60 tp2_sl40 +0,22 [+0,08; +0,35] (n=124), bnb_whale tp2_sl40 +0,49 [+0,21; +0,76] (n=29) – az adó gyakorlatilag nem változtat. (Ami NEM mérhető így: az adó, amit csak egyes címekre vagy később kapcsolnak be; és a tényleges MEV/szendvics-költség.)
- HUD: a BNB-sorok értéke adóval korrigált (mért adó, ismeretlennél 0); a buborékban az adó nélküli érték, a mért/összes és az adózó tokenek száma.
- Késés-érzékenység (10-07 este): `bnb_all60_d5/_d10`, `bnb_whale_d5/_d10` – ugyanaz a jelzés és eladhatósági próba, a vétel 5 / 10 mp-cel a fő belépés után, az akkori áron, csak a fő tervvel (tp2_sl40). Ha a pár közben kiürült, a vétel teljes veszteség (−méret − gáz; élesben a tx addigra elment volna). A HUD-on a fő kar alatt „↳ 5/10 mp késéssel” sorként. Cél: mennyire olvad az előny néhány másodperc csúszástól (a visszajátszás: +60 mp nyereséges, +3 perc már −0,41).

## 2026-10-07 – Értékelési időszakok (a felhasználó döntése)
- 1. időszak: 2026-09-30 00:00 UTC → 2026-10-08 00:00 Budapest (10-07 22:00 UTC); 2. időszak: onnan. `config.yaml` → `evaluation.periods`. A pozíció a NYITÁSA szerinti időszakba tartozik (az 1. időszakban nyitott, később záruló pozíció az 1.-be számít).
- A 2. időszakban minden kar változatlanul fut tovább (Base v2 család, Robinhood-karok, BNB: bnb_all60, bnb_whale és a +5/+10 mp-es késés-érzékenységi változatok, Solana-felvevők). A szabályokon nem változtatunk – ez a döntési szabály „második független időszaka”.
- Jelentések (`npm run allas`, Telegram /allas, /report, figyelő) és a HUD alapból az AKTUÁLIS időszakot mutatják (éjfélkor automatikusan váltanak); `npm run allas -- --period 1` a lezárt időszak. A HUD alján (a gép-állapot fölött) „Lezárt időszakok”: a kulcskarok eredménye 90% CI-vel (Base 60 mp/élő terv, Robinhood-karok, BNB fő terv adóval).
- Terhelés (10-07 este): a bot ~45% egy magból (a 10-ből), ~600 MB memória; adatbázis 6,3 GB, a legnagyobb a Solana-kötés tábla (~1,8 M sor/nap); szabad hely 684 GB – a Solana- és Robinhood-mérés futhat tovább.

## 2026-10-07 – Listázás ár nélkül (WHUF) → késleltetett belépés
- Eset: a Coinbase felvette a WHUF-ot (Whuffie, Base `0xeeee77bC…eeee`, 18 tizedes), majd a WHUF-USD termék megjelent – de a Coinbase-en `cancel_only` állapotban (még nincs kereskedés, ár null), és a hivatalos címen NINCS DEX-pool (DexScreener: 0 pár; a „WHUF” nevű poolok mind más című másolatok). A bot által látott egyetlen Base v4 pool egy 80%-os díjú, kötés nélküli porszem-pool (sell_simulation_failed). Tehát az „ár nem elérhető – nincs belépés” helyes volt: nem volt mit megvenni.
- Hiány: a figyelő az árat csak az esemény pillanatában nézte; ha a lánc-likviditás később jön, a belépés elveszett. Javítás (`src/listing/watcher.ts`): ár nélküli eseménynél 7 napig 5 percenként újranézi a HIVATALOS címet (DexScreener), és az első ≥ 1 000 USD likviditású pár áránál késleltetett árnyék-belépés (`listing_events.entry_at`; a szimuláció ettől számol; Telegram-értesítés). A másolat-tokeneket a cím szerinti keresés kizárja.

## 2026-10-07 este – BNB ÉLŐ végrehajtó: előkészítés (bekötés NÉLKÜL)
- A felhasználó döntése: kis valódi teszt (10–15 USD) a BNB-karon, ha a 2. időszak is megerősíti. Elkészült, de a botba NINCS bekötve: `src/bnb/live.ts` (BnbLive: PancakeSwap v2 vétel `swapExactETHForTokensSupportingFeeOnTransferTokens`, azonnali approve, eladás `swapExactTokensForETHSupportingFeeOnTransferTokens` a fő terv (2×/−40%/6 óra/kiürülés) szerint, revertnél pánik-csúszással újra, majd „unsellable”; védelmek: csak mode=live ÉS bnb_live.enabled, STOP-fájl, egymást követő hibák, max_open, napi USD-veszteségkorlát, BNB-egyenleg ≥ pozíció + gáz-tartalék, gázplafon, sekély pár), `config.yaml` → `bnb_live` (enabled: false, kar bnb_whale, 1,5 USD, max 4 nyitott, napi −5 USD), táblák `bnb_live_positions`, `bnb_live_fills`.
- A bekötést (a tárca-kulcs átadása a BSC-végrehajtónak, a jelzés-hook az árnyékkarból, /panic, állapotsor, tesztek hamis kliensekkel) a Claude Code jogosultsági rendszere „valódi tranzakció” okból megállította – ez a felhasználó kifejezett jóváhagyásával tehető meg. Addig a modul inaktív: a bot viselkedése nem változott.
- Gáz: BSC gázár 0,05 gwei (10-07); 0,2 gwei-jel egy swap ~0,03 USD → 1,5 USD-s pozíción vétel+approve+eladás ≈ 0,1 USD (~6%) – ezért 1 USD-nél kisebb méret nem ésszerű.

## 2026-10-07 23:00 – BNB ÉLŐ: bekötés, füstpróba, élesítés (a felhasználó kifejezett kérésére)
- Bekötés: `bnb_live.mode` KÜLÖN kapcsoló (a globális `mode` marad dry_run → a Base/Robinhood árnyékban); az árnyékkar az eladhatósági próba után hívja a BnbLive.onSignal-t, a kör végén BnbLive.step dönt a kiszállásról az árnyék állapotával (kör alatti csúcs/mélypont, likviditás); `/panic` a BNB-pozíciókat is eladja; `/resume` nullázza a BNB hibaszámlálót. Teszt hamis kliensekkel (dry_run: nincs tx; élő: vétel+approve → 2× → eladás, nettó; blokkolások).
- Füstpróba (`scripts/bnb-fustproba.ts --igen --usd 1`, CAKE – on-chain ellenőrzött): vétel 759 ms, approve 885 ms, eladás 878 ms, összesen 2,9 s; kapott = jegyzett (0 adó); gáz 0,000057 BNB (0,044 USD); nettó −0,049 USD = díjak + gáz (~5% az 1 USD-n). A végrehajtási út működik.
- Élesítve (config): `bnb_live.enabled: true`, `mode: live`, kar `bnb_whale`, 1,5 USD/pozíció, max 4 nyitott, napi veszteségkorlát 5 USD, 3 egymást követő hiba → szünet, gáz 0,2 gwei, gáz-tartalék 0,003 BNB, min. likviditás 3 BNB. Tárca: 0,0181 BNB (~14 USD). A Base élő vétel NEM indult el (globális mode dry_run).
- Mérendő élesben (a bnb_live_fills-ből): tényleges késés jelzés→vétel, jegyzett vs kapott (adó/csúszás), eladhatóság a saját címről, szendvics-veszteség; összevetés a bnb_whale és a +5 mp-es árnyékkal.

## 2026-10-08 – BNB élő láb: visszaforgatás, HUD-átrendezés
- Visszaforgatás a BNB élő lábra (`src/bnb/compound.ts`, tábla `bnb_compound_state`), a felhasználó szabálya: naponta a nap nettója (az utolsó újraszámolás óta zárt élő BNB-pozíciók, a füstpróba nélkül) → NYERESÉG 30%-a a tőkéhez (70% tartalék, nem forog), VESZTESÉG 100%-ban a tőkét csökkenti; pozícióméret = alapméret × tőke/induló tőke, legalább 1 USD (a gáz miatt). Induló tőke = 1,5 × 4 = 6 USD. A méret menet közben nem változik.
- Időzítés: 03:01 HELYI idő (Europe/Budapest), a Base-szabálynál is (`compound.recalc_time_local` + `recalc_timezone`, a korábbi `recalc_time_utc` helyett) – 03:01 kikerüli az óraátállítást (02:00–03:00). `isLocalTime()` Intl-lel; teszt nyári/téli időre.
- HUD: legelöl „🟡 ÉLŐ · BNB” (nettó eddig / ma / nyitott / tárca+méret, élő pozíciók, utolsó zárások, visszaforgatás-állapot, az árnyék ugyanazon időszakbeli átlaga); a Base-kiértékelés lejjebb; a kötésfolyam kártya kikerült (a karok buborékja mutatja a pozíciókat); a lánc-ikon mindenhol egységes (🔵 Base, 🟡 BNB, 🟣 Robinhood – a nagy nyerőknél korábban a nem-Base lila volt). A tárca BNB-egyenlege percenként a metába (`bnb_wallet_bnb`).
- 10-08 00:20: BNB élő pozícióméret 1,5 → 2 USD (a felhasználó: a Base alapméretével egyező); a visszaforgatás induló tőkéje 8 USD (2 × 4), még nem volt élő zárás, ezért az állapot egyszerűen újraírva. Átnézés az élesítés után: 14 perc alatt 12 indítás, 12 all60-jelzés, 0 bálna-jelzés (napközben 11–15/óra) – nincs hiba; a WARN-ok a Robinhood RPC átmeneti hibái.

## 2026-10-08 – BNB élő: első 5 kötés, szünet, honeypot-szimuláció
- Élő eredmény (21:19–21:31 UTC): 5 vétel, mind veszteség, −10,13 USD: 3 kihúzás (a vétel után másodpercekkel–percekkel), 2 honeypot (eladás: `TRANSFER_FROM_FAILED`). A végrehajtás jól működött (vétel 0,6–1,1 s, a jelzéstől 1,9–6,4 s; kapott/jegyzett 99,7%; a hibás eladásokat a becslés előre jelezte, gázt nem égetett).
- Vizsgálat: LAB – a párt egyetlen cím (0x65f5…) 30 mp-enként 1–2 BNB-vel pörgette (ez adta a „bálna-jelzést”), rajtunk kívül más nem vett; friss címről sem adható el (állapot-felülírásos szimuláció) → „csak engedélyezett adhat el”. AC – friss címről eladható, a mi címünkről semmilyen átutalás nem megy → a címünkre szóló tiltás.
- Miért engedte át az előzetes próba: „egy friss vevő címéről a párba küldhető-e” – a LAB-nál az egyetlen másik vevő a csapda üzemeltetője (engedélyezett) volt. Az árnyék mindkét honeypotot NYERŐNEK számolta (+1,06 / +1,14) → az árnyék-statisztika a címre szabott / engedélylistás honeypotok miatt túlbecsül.
- Szünet: STOP-fájl (21:39 UTC) – új élő vétel nincs a felhasználó döntéséig. A tesztek külön STOP-fájlt használnak (`STOP_FILE=.test-STOP`).
- A felhasználó kérésére a LAB teljes egyenlege átküldve a saját címére (0x300d…BfF9, tx 0x2beae303…68bc, gáz 0,000007 BNB) kézi eladási kísérlethez (a szimuláció szerint onnan sem adható el).
- Új mérés: `src/bnb/simtrade.ts` + `contracts/SimTrader.sol` (solc 0.8.26) – egyetlen eth_call-ban a vizsgált címre ideiglenesen felülírt kóddal vétel → approve → teljes visszaeladás a PancakeSwap routeren (a valódi token kódja fut, így a vétel által élesített tiltás is látszik). Ellenőrzés: CAKE stage 5 (0,995), LAB stage 4 mindenhol, AC stage 4 a saját címről, 5 a friss címről; 30–90 ms. Minden BNB-jelzésnél három változat (saját cím 0,2 / 0,05 gwei, friss cím 0,05 gwei) → `bnb_sim_checks`; a HUD buborékja mutatja az átmenési arányt és a „szűrővel” eredményt. Csak mérés – szűrőként az élő vétel előtt csak a felhasználó döntése után.

## 2026-10-08 éjjel – BNB élő újraindítás (a felhasználó döntése): 0,8 USD, 0,05 gwei, honeypot-teszt
- Beállítás: `position_usd: 0.8`, `gas_gwei: 0.05` (a hálózati szint; a 0,2 gwei-jel az AC-nál egyedül mi lógtunk ki a 22 vevő közül – valószínű anti-sniper tiltás), `gas_reserve_bnb: 0.0005`, `sim_filter: true`, `min_roundtrip_ratio: 0.85`. Tárca: 0,00495 BNB (~3,8 USD) → 4 × 0,8 USD fér el. MIN_POSITION_USD 0,5 (0,05 gwei-n egy kör gáza ~0,01 USD).
- Honeypot-teszt az élő vétel előtt (`BnbLive.onSignal`): `simRoundTrip` a SAJÁT címről, ugyanazzal a mérettel és gázárral; ha stage ≠ 5 vagy a visszakapott/elköltött < 0,85 → nincs vétel (`bnb_live_fills` kind = 'sim_block'). Unit teszt: elbukó szimuláció után nincs tx.
- Visszaforgatás újraindítva: induló tőke 3,2 USD (0,8 × 4), az előző 5 veszteség nem számít bele (last_recalc_at = most).
- Teszt-javítás: a HUD-szerver teszt a 2. időszak indulása (10-07 22:00 UTC) óta üres listát kapott (a mintaadat régebbi), és elbukott ellenőrzés után a szerver nyitva maradt → a futás lógott; most időszakok nélküli configgal fut, és a szerver kapcsolatai lezárulnak.
- 10-08 (a felhasználóval egyeztetve): a BNB-karok FŐ értéke a HUD-on és a lezárt-időszak panelen a honeypot-teszten átment pozíciók (saját cím, 0,05 gwei, oda-vissza ≥ 0,85; adóval) eredménye – élesben is így szűrünk; a szűretlen (minden jelzés) a buborékban marad. Ok: a 2. időszak első 37 percében a kiszűrt (honeypot) pozíciók az árnyékban +2,06 / +2,28 átlaggal a legnagyobb „nyerőknek” látszottak (a csapda pumpál, eladó nincs) – a szűretlen árnyék túlbecsül. Az 1. időszakban még nem volt szimuláció → ott szűretlen. A karok szabályain nem változtat.
- 10-08 00:45 (a felhasználó döntése): élő BNB kar `bnb_whale` → `bnb_all60` (minden indítás +60 mp; honeypot-szűrővel a 2. időszak első órájában +0,70 vs bálna +0,53; a bálna-jelzés túlreprezentálja a csali-vételes honeypotokat: 6-ból 2 vs 22-ből 2; nagy volumen → gyorsabb élő tapasztalat), napi veszteségkorlát 5 → 2 USD. A felhasználó további BNB-t tesz a tárcára. A max 4 nyitott és a 0,8 USD marad; a honeypot-teszt kötelező.
- 10-08 00:50: (1) HIBA: az élő kar a 10-07-i 4 sikertelen (honeypot) eladás hibaszámlálója miatt blokkolt („max_consecutive_failed”) – a STOP-fájl kézi törlése nem nullázza (csak a /resume); nullázva. (2) A felhasználó kérésére max_open 4 → 15; a visszaforgatás induló tőkéje 0,8 × 15 = 12 USD (a méret a tőke arányában változik, így a 30%-os visszaforgatás a teljes forgó tőkéhez mérődik). A tárca most ~3,8 USD (≈ 4 pozíció) – a feltöltésig a „kevés_bnb” blokk korlátoz.

## 2026-10-08 – Base honeypot-teszt (mérés)
- `src/exec/simV4.ts` + `contracts/V4SimTrader.sol` (solc 0.8.26): egyetlen eth_call-ban, a vizsgált címre ideiglenesen felülírt kóddal, PONTOSAN az élő Base-útvonalon: Universal Router V4_SWAP (SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL) vétel → approve(Permit2) → Permit2.approve(router) → teljes visszaeladás. A token és a pool hookja is fut. Csak natív ETH-páros pool (az élő útvonal is csak ezt kezeli; a WETH-párosak stage 0 „nem natív”).
- Ellenőrzés 14 friss Base-tokenen: élő pool → stage 5 (oda-vissza 0,98–1,00), kihúzott pool → stage 1 (a vétel sem megy), WETH-pár → stage 0; ~0,5–0,6 s/hívás.
- Bekötés (mérés, nem szűrő): a döntési motor az élő ablakban (60 mp), ha bármely kar belépett és a pool natív v4, a saját és egy friss címről lefuttatja → `base_sim_checks`. A HUD Base-sorainak buborékja: átment saját/friss, és a szűrt (saját cím stage 5) átlag. Szűrőként az élő Base-vétel előtt csak a felhasználó döntése után.
- 10-08 00:51: BNB élő napi veszteségkorlát 7 USD (a felhasználó); a tárca feltöltve: 0,0187 BNB (~14,4 USD).
- HIBA (10-08 00:56, javítva): a BNB élő napi veszteségkorlát az UTC-napot számolta, így a 10-07 esti szakasz −10,13 USD-je az újraindítás után is blokkolt („daily_loss_limit”, minden jelzés). Mostantól a „nap” a visszaforgatás utolsó újraszámolása (03:01 helyi idő, ill. kézi újraindítás) óta zárt élő pozíciók (a füstpróba nélkül); állapot híján UTC-nap. Unit teszt.
- 10-08 01:05: a BNB élő vételek 16–34 mp-cel a jelzés után jöttek (az élő az árnyék után 1–3 mp-cel – az árnyék maga késett). A felvevő a lánchoz képest 2–9 mp-en belül volt, de az árnyék csak a felvevő körének egy pontján lépett, egy kör (héj-ellenőrzés, kimenet-frissítés) pedig időnként 15–30 mp. Javítás: az árnyék (és vele az élő kar) saját 2 mp-es ütemben is lép, átfedés-védelemmel; a kiszállási döntések is sűrűbbek lettek.
- HUD (10-08): az élő BNB-blokk és a gép-állapot 5 mp-enként frissül (`/api/live`: csak az olcsó hudBnbLive, a HUD-szálon, 3 mp-es gyorsítótárral; rejtett lapon nem kérdez); a teljes oldal marad 30 mp (a nehéz összesítő ~8 mp a HUD-szálon). A bot fő szálát nem terheli.

## 2026-10-08 – Gyűrű-szűrő (utólagos tiltás ellen)
- Lelet: az AC és a CSOPSKHYNIX2L (élő, 23:06) mögött ugyanaz a tárcacsoport: ~14 cím tokenről tokenre vesz és a routeren át elad („organikus” forgalom), a kívülálló vevőt pedig utólag, külön tx-ben letiltja (a CSOP-nál a vételkori honeypot-teszt mindhárom változatban átment; 33 perccel később a mi címünkről semmi nem mozdítható, egy friss címről ma is). A csoport 10-04 óta ~132 párban volt jelen (≥ 3 taggal); az árnyék ezeket NYERŐNEK látja.
- Szabály (`src/bnb/ring.ts`): gyűrű-tag = legalább 2 különböző „rossz” párban (élő pozíciónk eladhatatlan lett) vásárló tárca (egyszeri áldozat-bot így nem kerül listára); a lista önfrissítő (minden új eladhatatlan élő pozíció párjának vevői jelöltek lesznek). Egy pár gyűrűs, ha a jelzés ELŐTT ≥ 1 tag vett benne (a +60 mp-es belépéskor a gyűrű még csak érkezik: CSOP-nál 1 tag volt a vételünkkor, AC-nál 6). Élő: gyűrűs párba nincs vétel (`bnb_live_fills` kind = 'ring_block'). Árnyék: `bnb_shadow_positions.ring_n` (a nyitáskor; visszamenőleg kitöltve: `scripts/bnb-ring-backfill.ts`), a HUD szűrt értéke ezeket is kihagyja.
- Kezdő lista: 13 tag (3 rossz párból). Visszamenőleges mérés (enyhe előre-tudással, mert a lista a 10-07 esti esetekből jött): bnb_all60 árnyékban 13 gyűrűs pozíció (+0,43 / +1,01 átlag – élesben tiltás), bnb_whale 11.
- HIBA (10-08 01:40, javítva): a PancakeSwap-felvevő csak a Swap-eseményeket adta tovább az árnyéknak/élő karnak, a likviditás-kivételt (Sync swap nélkül) nem → a kiürülést csak a 30 perces tartalék-frissítés vette észre (#7, #9 élő: „kiürült” 30,5 percnél; a láncon valóban kiürült, az eredményt nem változtatta). Most a Sync is továbbmegy (kind = reserve).
- Visszamenőleges mérés a gyűrű-szűrővel (az 1. időszakban honeypot-szimuláció még nem volt): bnb_all60 +0,14 [+0,07; +0,22] (n=474; szűretlen +0,15), +5 mp +0,10, +10 mp +0,05; bnb_whale +0,72 [+0,56; +0,86] (n=107; szűretlen +0,64), +5 mp +0,59, +10 mp +0,33. Az élő 17 pozícióból a két szűrő 3-at fogott volna (AC, CSOP – gyűrű; LAB – a vételkori szimuláció, utólag ellenőrizve stage 4); a maradék 14 mind kiürült (−15 USD) – a szűrők a kihúzás ellen nem védenek; az árnyék ugyanezeken a párokon ugyanígy zárt.
- 10-08 01:45 (a felhasználó döntése): élő BNB kar vissza `bnb_whale`-re, a honeypot-teszttel és a gyűrű-szűrővel; 0,8 USD, max 15, napi korlát 7 USD (a „nap” 03:01-kor újraindul). Reggel közös átnézés. Megjegyzés: a 03:01-es visszaforgatás a 22:35 óta zárt élő pozíciók veszteségét 100%-ban levonja a tőkéből (12 USD-ből), így a méret a 0,5 USD-s padlóra eshet – a felhasználó szabálya szerint.
- 10-08 01:55 (a felhasználó kérésére): a 03:01-es BNB-visszaforgatás ma éjjel EGYSZER kimarad – a méret 0,8 USD, a tőke 12 USD marad; a „nap” (a napi veszteségkorlát) 03:01-kor ettől függetlenül újraindul. Megvalósítás: meta `bnb_compound_skip_next = 1` (a futás után törlődik); unit teszt.
- 10-08 02:10–02:15 (a felhasználó): BNB élő belépő 0,8 → 0,6 → 0,5 USD (induló tőke 0,5 × 15 = 7,5 USD) (több próbálkozás ugyanabból a tárcából; a gáz egy körre ~0,01 USD); visszaforgatás induló tőke 0,6 × 15 = 9 USD; a 03:01-es egyszeri kihagyás marad (a méret 0,6 USD marad).
- 10-08 03:05 (a felhasználó: több adat): BNB élő belépő 0,25 USD (induló tőke 0,25 × 15 = 3,75 USD); a méret alsó határa (MIN_POSITION_USD) 0,5 → 0,2 USD. A gáz egy teljes körre (vétel + approve + eladás, 0,05 gwei) ~0,01 USD ≈ 4%, plusz 2 × 0,25% díj – a nettó eredményben benne van.
- 10-08 03:20 (a felhasználó döntése): BNB élő szünet reggelig (STOP-fájl), az árnyék tovább mér. Ok: 10-07 21:00 óta új csalás-gyár – ~4 percenként friss tárcával indított token (~40 BNB, PancakeSwap router), ~80 mp-nél egy 1–1,4 BNB-s „bálna”-vétel (mindig más címről), majd 4–6 mp-cel a vételünk után kihúzás. A bálna-árnyékban a 30 mp-en belüli kihúzás 13:00–21:00 között 0, 21 h: 3, 01 h: 4/6. A gyűrű-szűrő (friss tárcák) és a honeypot-teszt (vételkor rendes token) nem fogja. A 03:01 utáni 4 élő kötés: −1,5 USD, mind kiürült. Reggel: célzott minta vizsgálata (induló likviditás, bálna-időzítés, indítási ütem, gyors kihúzás).

## 2026-10-08 hajnal – Reaktív kihúzó gyárak: vizsgálat és szűrő
- Ujjlenyomatok (az élő gyors kihúzásokból, láncon): (1) a csali „bálna”-vétel MINDIG ugyanazon a szerződésen (0xa3e0e5409a93…) megy, nem a PancakeSwap routeren – a bálna-tárcák változnak (egy, 0xf602c983…, visszatért); (2) a kihúzás mindig ugyanazon a szerződésen (0x3db7618a8c…) megy, a likviditást betevő tárcától, 2–3 blokkal (~1 mp) a vételünk után; (3) a token-kód sablonos: a 01 órás gyár minden tokenje 0xb4748757c1… (2040 B), a 23 órásé 0x63ad5291cd… (1526 B), további sablonok 0x21eca77c4d…, 0x70eae7c959…, 0xb3bdfe0382…; (4) a likviditást betevő tárcák pontosan 14 tranzakció után (gépi előkészítés).
- Reaktív: a bálna-karon MINDEN 30 mp-en belüli kihúzás olyan párban volt, ahol élőben vettünk (10/10); csak-árnyék párban egy sem. Ha senki nem vesz, a gyár saját vételeitől az ár 2×-ig fut → az árnyék ezeket NYERŐNEK látja. Ez az árnyék harmadik vakfoltja (a honeypot és a címre szabott tiltás mellett).
- Hatás az árnyékon (tp2_sl40, 10-07 13:00 óta): bnb_all60 összes +0,14 (n=663) → a reaktív sablonok / csali-szerződés nélkül −0,25 [−0,35; −0,15] (n=273): a +60 mp-es kar pluszát TELJES egészében a gyárak adták. bnb_whale összes +0,60 (n=156) → nélkülük +0,81 [+0,45; +1,17] (n=45; 2. időszak n=11, +0,95) – a router-en át vásárolt bálnák (n=31) +0,78, gyors kihúzás nélkül.
- Szűrő (`src/bnb/reactive.ts`, tábla `bnb_reactive_marks`): a jelzéskor a token kódjának keccak-ja és a jelző ≥ 1 BNB-s vétel tx.to-ja; ha bármelyik listán van, nincs élő vétel (`bnb_live_fills` kind = 'reactive_block'). Önfrissítő: élő pozíció 30 mp-en belüli kiürülése → a kódsablon és (ha nem a router) a csali-szerződés listára. Kezdő lista: 5 kódsablon + 1 csali-szerződés (`scripts/bnb-reactive-backfill.ts`); a bnb_sim_checks code_hash / whale_via visszamenőleg kitöltve. HUD: a BNB fő értéke a honeypot + gyűrű + reaktív szűrőn átmentek.
- Korlát: a lista csak a már „megégett” sablonokat ismeri – egy új sablonnal induló gyár az első élő vételünket viszi. A kezdő lista a teljes eddigi árnyék-mintán (in-sample) lett mérve; a 2. időszakban új adaton kell igazolódnia.
- 10-08 03:40 (a felhasználó): az élő BNB-vétel ÁLL – `bnb_live.enabled: false`, `mode: dry_run` (a STOP-fájl mellett); nyitott élő pozíció nincs. Újraindítás csak kifejezett kérésre. Az árnyék (bálna, +60 mp, késleltetett változatok, szűrők) tovább mér.

## 2026-10-08 hajnal – Mintakeresés a korábbi adatokon (csak elemzés, változtatás nélkül)
- BNB, kódsablonok: a párok vevőinek ~100%-a „visszatérő” (≥ 5 párban vásárló) tárca – a BNB-indításokat szinte csak botok/farmok kereskedik. Gyanús, még nem listázott sablon: 0x22b230294d… – 20 pár, árnyékban 24/24 dupla (+1,12), de páronként átlag 1,3 vevő (egy szereplő pumpál) → valószínű reaktív csapda.
- BNB, egyedi vevők a jelzés előtt (bálna-kar, tp2_sl40): 1–2 vevő +1,22 (n=25, 23 dupla); 3–5: +0,73 (n=28); 6–15: +0,69 (n=84); 16–40: −0,43 (n=7); 41+: −0,66 (n=15). Minél „mesterségesebb” (kevés vevős) a pár, annál jobb az árnyék – a valódi, sok vevős párokon a stratégia veszít. Erős gyanú: a BNB-árnyék előnyének nagy része a reaktív csali-párokból jön (élesben kihúzás).
- Base, rule_v2 (60 s, live terv) kódsablon szerint: „gyári” kód (≥ 50 azonos bytecode): n=40, −0,17, 0 nagy nyerő, 18 kihúzás; ritka (2–4): n=6, +3,56; egyedi: n=23, +1,21. Mind a 10 nagy nyerő (> 2 USD) egyedi vagy ritka kódú, és sok valódi vevővel (37–102 a 3. percben) – a Base-előny „organikus” tokenekből jön, a BNB-é mesterséges párokból. Ez megerősíti a rule_v2_nofactory irányt.

## 2026-10-08 – Base élő teszt (rule_v2_strict, 0,2 USD) – a felhasználó döntése
- A felhasználó kifejezett kérésére: `mode: live`, `risk.base_position_usd: 0.2`, `deposit_cap_usd: 3` (a Base-tárcán ~3,6 USD), napi veszteségkorlát 85% → ≈2,5 USD; compound_state: betét 3, méret 0,2. A BNB élő láb külön kapcsolóval (bnb_live.enabled: false) áll; az élő vétel csak Base-en (`live_entry.chains: [base]`).
- Kötelező honeypot-teszt az élő vétel előtt (`live_entry.sim_filter`, `min_roundtrip_ratio: 0.85`): vétel+eladás szimuláció a saját címről, az élő mérettel, az élő útvonalon (Universal Router + Permit2). Bukás → `decisions` sor `sim_block:…` okkal, Telegram-jelzés, nincs vétel.
- Feltételezés: egyes egyedi hookos poolokon (pl. cbwCAT, hook 0x82B6…C0cc) a szimuláció a vételnél bukik (a hívó kód miatt), miközben a valódi vétel becslése átmegy → ezeket kihagyjuk (óvatos irány, hamis negatív).
- Korlát: a WETH-páros (nem natív ETH) v4 poolokra nincs élő útvonal; a Base-szimulációk ~fele ilyen volt (189/384) → ezek kimaradnak az élő vételből.
- Füstpróba 08:11 UTC (Penguin, 0,2 USD): vétel, szándékosan bukó eladás (revert, gas nélkül), 50% eladás, maradék eladás – mind rendben; teljes gas ~0,005 USD, kör mérlege −0,010 USD.
