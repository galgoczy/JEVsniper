# Jev Sniper – munkaszabályok és állapot (a Claude Code minden indításkor beolvassa)

A felhasználó nem programozó: magyarul, egyszerűen fogalmazz, a parancsokat te futtasd, ne vele másoltasd.

## Kötelező szabályok
- A privát kulcs (`WALLET_PRIVATE_KEY`) és minden titok a `.env`-ben van: SOHA ne olvasd ki, ne írd ki, ne logold, ne tedd chatbe vagy fájlba. A `.env` tartalmát ne `cat`-old; ha ellenőrizni kell, csak azt nézd, hogy a kulcs létezik-e.
- A bot soha nem hoz létre tárcát és nem utal ki pénzt.
- `config.yaml` → `mode: dry_run`: valódi vétel nincs. Élesítésről (`mode: live`) CSAK a felhasználó dönthet, kifejezett kérésre.
- Nem találunk ki API-végpontot vagy szerződéscímet: csak hivatalos/ellenőrzött forrásból (lásd `docs/FELTETELEZESEK.md`).
- Minden változtatás után: `npx tsc --noEmit -p .` és `npm test` zöld legyen; a feltételezéseket írd a `docs/FELTETELEZESEK.md` végére.
- Git: a fejlesztési ág `claude/loving-keller-dzuzkk`; commit + `git push -u origin claude/loving-keller-dzuzkk`.

## A bot futtatása a Mac Minin
- Indítás: `npm start` (a bot terminálban fut; leállítás Ctrl+C). Frissítés után újraindítás kell.
- Ha a botot te indítod, háttérben futtasd, és a kimenetét fájlba irányítsd, pl. `mkdir -p logs && nohup npm start > logs/bot.out 2>&1 &`; leállítás: a folyamat megkeresése (`pgrep -f "tsx src/index.ts"`) és `kill` (SIGINT/SIGTERM – a bot rendben leáll).
- Telegram: `/status`, `/allas` (egyszerűsített állás), `/report`, `/stop`, `/resume`, `/panic`, `/help`.

## Rendszeres kiértékelés (ezeket futtasd és értelmezd a felhasználónak)
- Állás: `npm run allas`
- Riport: `npm run report -- --since ÉÉÉÉ-HH-NN` vagy `-- --days N` (tizedes is lehet, pl. 0.25)
- Szabálykereső: `npm run explore` (alapból a `config.yaml` → `alerts.features_since` naptól), `-- --plan B`, `-- --window 60`
- Ellenőrzők: `npm run verify:listing`, `npm run verify:lp`
- Adatbázis: `sqlite3 -header -column data/jev-sniper.db "..."` (csak olvasó lekérdezések, hacsak nem kifejezetten javítás a cél)

## Módszertani elvek
- Minden stratégia árnyékban fut (költségmodellel), és a `random_control` véletlen kontrollhoz mérjük.
- Döntési szabály: élesítés-jelölt csak ≥ 100 lezárt pozíció és teljesen nulla fölötti 90% CI mellett, és egy második, független időszakban is tartania kell.
- Hirtelen, túl szép javulás = először mérési hibát keress (eddig ez mindig az volt). Futás közben a szabályokat nem írjuk át sorozatok alapján.

## Állapot (2026-09-29)
- Tiszta, torzítatlan adat: `alerts.since` / `features_since` = 2026-09-30 (előtte több mérési hiba volt; lásd FELTETELEZESEK.md, 09-28 és 09-29).
- Eredmény eddig: friss Base/Uniswap és PONS indulásoknál minden stratégia veszít (fő ok: likviditás-kihúzás a Uniswap-indításoknál; a likviditás tulajdonosa sem véd). Jev ki van kapcsolva (nem hozott mérhető előnyt).
- Futó tesztek: V2 graduációs szakasz (`grad_at`, `grad_15_all`, `grad_15_hold`), `clanker_all`, `pons_all`, copy trading (`copy_smart`, `copy_unskilled`), listázás-figyelő (Coinbase / Robinhood), korábbi karok.
- Következő döntési pont: 2026-10-01 – `npm run report -- --since 2026-09-30` és `npm run explore`. Kérdés: van-e a graduációs karok közt a véletlennél és a költségeknél jobb; ha a szabálykereső sem talál a friss adaton tartó szabályt, a snipelést javasolt lezárni.
- Tervezett karbantartás: a `wallet_trades` tábla gyorsan nő (~1 millió sor/nap) – 1–2 hét múlva automatikus törlés a régi sorokra.
