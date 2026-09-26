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
