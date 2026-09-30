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

## Állapot (2026-09-30)
- Tiszta, torzítatlan adat: `alerts.since` / `features_since` = 2026-09-30. A riport csak az időszakban NYITOTT pozíciókat számolja.
- Indulás-snipelés (friss Base/Uniswap és PONS): minden stratégia veszít (véletlen kontroll kb. −0,4 USD/pozíció; base_uni_all −0,4…−0,9). Fő ok: likviditás-kihúzás a Uniswap-indításoknál; a likviditás tulajdonosa sem véd. A szabálykereső (09-30) sem talált a friss adaton nyereséges szabályt → az indulási irány lezártnak tekinthető (a karok futhatnak tovább viszonyításnak).
- Nyitott kérdések, ezeket figyeld:
  - V2 graduáció (`grad_at`, `grad_15_all`, `grad_15_hold`): a pozíciók napokig nyitva lehetnek → a `npm run allas` „nyitottakkal ~” értéke (utolsó áron becsülve) ad korai képet.
  - Copy trading: `copy_smart` 09-30-án +0,06 (n=59) – kevés, lehet véletlen; `copy_unskilled` −0,16.
  - `clanker_all`, `pons_all` alapvonal; listázás-figyelő (még nem volt esemény).
- Jev ki van kapcsolva (nem hozott mérhető előnyt).
- Döntési szabály változatlan: élesítés-jelölt csak ≥ 100 lezárt pozíció, teljesen nulla fölötti 90% CI, és egy második független időszakban is tartson. Élesítésről csak a felhasználó dönt.
- Tervezett karbantartás: a `wallet_trades` tábla gyorsan nő (~1 millió sor/nap) – 1–2 hét múlva automatikus törlés a régi sorokra.
