#!/bin/zsh
# A bot automatikus indítója (Mac újraindulás / bejelentkezés után).
# Hívja: ~/Applications/Jev Sniper indito.app (a LaunchAgent hu.zentopia.jev-sniper nyitja meg bejelentkezéskor).
# Azért app-on keresztül, mert a macOS csak egy alkalmazásnak adhat engedélyt a külső lemez elérésére.
# Rendes leállás (kill / Ctrl+C → 0-s kilépés) után NEM indítja újra; összeomlás (nem 0-s kilépés) után 60 mp múlva igen.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DIR="/Volumes/Mac Nvme Extended/Github/JEVsniper"
LOG="$HOME/Library/Logs/jev-sniper-launchd.log"
say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

# Egyszerre csak egy indító fusson.
LOCK="$HOME/Library/Logs/jev-sniper-indito.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if pgrep -f "scripts/bot-launchd.sh" | grep -qv "^$$\$"; then say "már fut egy indító – kilépek"; exit 0; fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# A külső lemez bejelentkezés után néha később csatolódik.
for i in {1..120}; do [[ -f "$DIR/package.json" ]] && break; sleep 5; done
cd "$DIR" || { say "a lemez nem érhető el: $DIR"; exit 1; }
say "lemez elérhető"

while true; do
  # Ha kézzel indított példány fut, megvárjuk, amíg leáll (ne fusson kettő egyszerre).
  if pgrep -f "^node .*tsx src/index.ts" >/dev/null; then
    say "már fut egy bot – megvárom"
    while pgrep -f "^node .*tsx src/index.ts" >/dev/null; do sleep 10; done
    say "a kézi bot leállt – nem indítom újra (rendes leállás)"
    exit 0
  fi
  mkdir -p logs
  # Napló: hozzáfűzés; 200 MB fölött félreteszi dátummal.
  if [[ -f logs/bot.out ]] && (( $(stat -f %z logs/bot.out) > 200000000 )); then
    mv logs/bot.out "logs/bot.$(date +%Y-%m-%d_%H%M).out"
  fi
  echo "=== indítás (automatikus) $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> logs/bot.out
  say "bot indul"
  ./node_modules/.bin/tsx src/index.ts >> logs/bot.out 2>&1
  code=$?
  say "bot kilépett, kód: $code"
  [[ $code -eq 0 || $code -eq 130 || $code -eq 143 ]] && exit 0
  sleep 60
done
