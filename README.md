# Jev Sniper Bot

Memecoin-indításokat figyelő és mikropozíciókkal kereskedő bot Base és Robinhood Chain láncon, Jev (TypeSafe)
döntési modellel. Specifikáció: v6. Állapot: **1. lépés (váz, config, DB, Jev, Telegram) kész.**

## Telepítés (Mac Mini)
```bash
# Node 22+ szükséges
npm install
cp .env.example .env      # töltsd ki: Jev kulcs, RPC-k, Telegram, privát kulcs
npm run verify:step1      # config + DB + kötegelt Jev-hívás + Telegram-üzenet
npm test                  # offline tesztek
npm start                 # bot indítása (privát kulcs nélkül nem indul)
```

pm2-vel:
```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

## Telegram parancsok
`/status` – állapot, `/stop` – nincs új belépés (STOP fájl), `/resume` – feloldás, `/panic` – minden pozíció zárása
(az 5. lépéstől él a tényleges eladás), `/help`.

Kill switch fájlból: hozz létre `STOP` nevű fájlt a projekt gyökerében.

## Fájlok
- `config.yaml` – minden paraméter és kockázati limit
- `.env` – kulcsok (nincs gitben)
- `data/jev-sniper.db` – SQLite adatbázis
- `docs/FELTETELEZESEK.md` – feltételezések, ellenőrzött API-adatok, nyitott kérdések
