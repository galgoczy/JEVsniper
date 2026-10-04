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
- Telegram: `/status`, `/allas` (rövid állás), `/report` (időarányos + állás + visszaforgatás), `/allas_reszletes`, `/stop`, `/resume`, `/panic`, `/help`.
- Webes áttekintő (HUD): http://<mini-IP>:8787 (config `hud`; `HUD_TOKEN` a .env-ben → `?t=<token>`). Később Cloudflare Tunnel: `tradehud.zentopia.hu`.

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
- 2026-10-01: a Jev nélküli karok (`rule_v2_strict` +0,83 n=25, `rule_v2` +0,64 n=37, `base_uni_hold` +0,64 n=24; véletlen −0,45) ⏳ pluszban, de a plusz időben olvad és néhány nagy nyerőn múlik – figyelni, nem élesíteni. Gyári tokenek (ismétlődő `bytecode_hash`, 100% likviditás-kihúzás): új karok `rule_v2_nofactory`, `base_uni_hold_nofactory`.
- Élő vétel bekötve: `config.yaml` → `live_entry.arm` / `exit_plan` (most `rule_v2_strict` / `live`), élő méret 2 USD (az árnyék fixen 1 USD: `evaluation.shadow_size_usd`); dry_run-ban csak „BELÉPNE” Telegram-jelzés. Élesítés = `mode: live` + újraindítás + ETH a tárcában, csak a felhasználó döntésére.
- BNB Chain / Four.Meme (10-04): felvevő fut (`bnb_tokens`, `bnb_trades`, `bnb_grads`; `npm run verify:bnb`). Első mérés: ~6 200 indítás/nap, de szinte csak 1 vevős (készítő) tokenek; 1–2 nap adat után visszajátszás és szabály-jelöltek.
- Solana / Pump.fun (10-04): felvevő fut (`sol_tokens`, `sol_trades`, `sol_snapshots`, `sol_outcomes`; `npm run verify:sol`). Első mérés: ~30 ezer indítás, ~3,5 M kötés, ~1,3 M SOL forgalom naponta – ez a legélénkebb piac; 1–2 nap adat után szabály-jelöltek.
- Jev ki van kapcsolva (nem hozott mérhető előnyt).
- Döntési szabály változatlan: élesítés-jelölt csak ≥ 100 lezárt pozíció, teljesen nulla fölötti 90% CI, és egy második független időszakban is tartson. Élesítésről csak a felhasználó dönt.
- Tervezett karbantartás: a `wallet_trades` tábla gyorsan nő (~1 millió sor/nap) – 1–2 hét múlva automatikus törlés a régi sorokra.
