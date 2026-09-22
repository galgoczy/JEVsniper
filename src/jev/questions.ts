import { choice, noul, score } from "@typesafe-ai/sdk";

/**
 * A Jev "score" kérdés egy 2–10 fokú rubrikát vár (0-tól indexelve), nem 0–100-at.
 * Ezért a 0–100-as pontszámokat 10 fokú rubrikával kérdezzük (0..9), és a várható
 * értéket (expected score) 0–100-ra skálázzuk: score/9*100.
 */
export const SCORE_LEVELS = 10;
export const scoreTo100 = (s: number) => Math.round((s / (SCORE_LEVELS - 1)) * 100);

const tenLevel = (low: string, high: string) =>
  [`0 – ${low}`, "1", "2", "3", "4", "5 – közepes", "6", "7", "8", `9 – ${high}`] as const;

/** 6.4 – belépés előtti címkék, egy kötegben. */
export const entryQuestions = {
  contract_risk: choice("Mennyire kockázatos a token szerződése és mechanikája?", {
    clean: "ismert sablon, nincs veszélyes jog, eladás szimulálható, adó nincs vagy minimális",
    suspicious: "van gyanús elem (nem ismert sablon, tulajdonosi jogok, kis adó, likviditás nem lockolt)",
    dangerous: "honeypot-jel, magas adó, mint/blacklist/pause jog, likviditás kivehető",
  }),
  creator_profile: choice("Milyen a creator (deployer) profilja?", {
    serial_rugger: "korábbi tokenjei rugoltak vagy 1 órán belül meghaltak",
    serial_launcher_neutral: "sok korábbi token, vegyes sors, nem egyértelműen csaló",
    builder: "kevés, de sikeres/graduált korábbi token, tartja a tokenjeit",
    first_timer: "nincs korábbi token, friss vagy kis történetű wallet",
    unknown: "nincs elég adat",
  }),
  wallet_pattern: choice("Milyen a vevő walletek mintázata?", {
    organic: "sokféle wallet, eltérő korú, eltérő finanszírozás",
    bundled: "több wallet ugyanabból a forrásból, egy blokkban vettek",
    bot_farm: "sok friss, azonos mintájú bot-wallet",
    airdrop_farm: "transferrel osztogatott tokenek, dusting, claim-szerződés",
    unclear: null,
  }),
  buyer_quality: score("Mennyire jó minőségűek a vevők (smart money, tartók, nem botok)?",
    tenLevel("csak botok / scammerek", "sok smart-money, tartó, ismert jó walletek")),
  crowd_type: choice("Ki veszi a tokent?", {
    bots: null, degens: null, organic_community: null, insiders: null, mixed: null,
  }),
  dev_behavior: choice("Mit csinál a creator a saját tokenjeivel?", {
    holding: "nem adott el", accumulating: "vesz", distributing: "elad vagy szétosztogat", unknown: null,
  }),
  trade_pattern: choice("Milyen a kereskedési mintázat?", {
    organic_accumulation: "növekvő egyedi vevőszám, egészséges vétel/eladás arány",
    coordinated_pump: "hirtelen, összehangolt vételi hullám",
    distribution: "nagy eladások, nettó kiáramlás",
    dead: "alig van forgalom",
    stalling: "megállt a növekedés, oldalazás",
  }),
  narrative_fit: score("Mennyire illeszkedik a token neve/leírása az aktuális trendekhez és narratívákhoz?",
    tenLevel("semmi illeszkedés", "pontosan a forró narratíva, eredeti")),
  copycat: choice("Másolat-e a token?", {
    original: null, copy_of_trending: "trendi token másolata", copy_of_dead: "halott token másolata",
  }),
  social_quality: score("Mennyire hiteles és aktív a social jelenlét (Telegram, X, weboldal)?",
    tenLevel("nincs vagy hamis", "egyedi, aktív, régi fiók, szerves növekedés")),
  entry_timing: choice("Mennyire jó most a beszállási időzítés?", {
    early: "nagyon korai, kevés vevő", good: "lendület indul, még nem drága",
    late: "már sokat ment", too_late: "csúcs után, eloszlás fázis",
  }),
  outcome: choice("Melyik következik be előbb az elkövetkező 24 órában?", {
    tp1_first: "az ár előbb ér el 2x-et a mostani árhoz képest, mint -40%-ot",
    stop_first: "az ár előbb esik -40%-ot, mint hogy 2x-et érne",
    neither_24h: "24 órán belül egyik sem",
  }),
} as const;

/** 7.2 – tartás-figyelés, egy kötegben. */
export const holdQuestions = {
  trade_pattern: entryQuestions.trade_pattern,
  dev_behavior: entryQuestions.dev_behavior,
  crowd_type: entryQuestions.crowd_type,
  exit: noul("Ki kell-e szállni most a pozícióból?", {
    true: "a jelek romlanak: eloszlás, creator elad, likviditás csökken, vevők eltűnnek",
    false: "a pozíció tartható, a terv szerinti lépcsők várhatók",
  }),
} as const;

/** 6.2 – piaci rezsim. */
export const regimeQuestions = {
  regime: choice("Milyen a memecoin piaci rezsim most?", {
    hot: "erős beáramlás, sok graduáció, ETH stabil vagy emelkedik",
    normal: null,
    cold: "kevés graduáció, gyenge volumen",
    risk_off: "ETH esik, volumen zuhan, nem érdemes új pozíciót nyitni",
  }),
} as const;

/** A verify-teszt egy egyszerű, várható válaszú kérdésköteg. */
export const smokeQuestions = {
  is_rug: noul("Ez a token rug pull-nak tűnik?"),
  pattern: choice("Melyik minta illik?", { organic: null, bundled: null, unclear: null }),
  quality: score("Vevőminőség", tenLevel("rossz", "kiváló")),
} as const;
