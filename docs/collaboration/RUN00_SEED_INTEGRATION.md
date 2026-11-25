# RUN 00 seed: bezpečné začlenění do `main` (příprava, nic nebylo začleněno)

Stav (2026-11-25): větev `seed/run00-demo-data` (`892c6ad`) **zůstává zachována beze změny**. Data RUN 00 jsou v produkci (14 projektů, 154 úkolů…); na větvi je jen
nástroj, který je vytvořil (`frontend/scripts/demo-seed/`).

## Co větev přináší
Dva commity (`c04b019`, `892c6ad`), **6 nových souborů** pod `frontend/scripts/demo-seed/` (+1 767 řádků): `README.md`, `dataset.mjs`, `demo-seed.mjs`, `demo-seed.test.mjs`,
`rows.mjs`, `manifest.csd-corvane-1.1.0.json`. Nemění žádný existující soubor aplikace, schématu ani konfigurace.

## Zkušební začlenění (2026-11-25, bez dotyku větví a pracovních stromů)
`git merge-tree --write-tree HEAD seed/run00-demo-data` → **bez konfliktů** (výsledný strom `fc5a04b`); žádná z cest už na HEAD neexistuje.

## Sken citlivých dat
* Žádný klíč, token, JWT, heslo v URL ani soukromý klíč; e-maily jen `example.com/.net/.org`; žádné Gmail/Centrum adresy.
* Hesla se berou za běhu z macOS Keychain, v kódu nejsou.
* **Jediný nález:** `manifest.csd-corvane-1.1.0.json` obsahuje UUID **vašeho produkčního účtu** (`workspaceOwner` a 14× `member-owner-<uuid>`). Není to přihlašovací údaj,
  ale jde o identifikátor skutečného účtu a **repozitář `bng-dev-alt/clearspace` je veřejný**. Proto seed větev **nebyla pushnuta** a doporučuji ji nepublikovat v dnešní podobě.

## Doporučený postup (po vašem rozhodnutí)
1. *Varianta A (doporučeno):* manifest zbavit UUID – `workspaceOwner` a `member-owner-<uuid>` nahradit zástupným `00000000-0000-4000-8000-000000000001` (UUID už v datasetu jako
   placeholder existuje) a skript nechat dosazovat vlastníka z parametru `--workspace`; ověřit `node --test demo-seed/demo-seed.test.mjs` a `plan`/`verify` na produkci (read-only).
   Potom normální merge (viz 2) a push.
2. *Merge z čistého worktree:* `git switch -c integration/main-plus-run00-seed main` (ve worktree bez změn) → `git merge --no-ff seed/run00-demo-data` → testy → fast-forward `main`.
3. *Varianta B:* seeder zůstane lokální (větev `seed/run00-demo-data` + záloha) a do veřejného `main` nejde; dokumentace ho jen zmiňuje.
4. Seed větev se po začlenění **nemaže**.

Připravená lokální větev: `integration/main-plus-run00-seed` (merge commit nad finálním `main`, **bez** úpravy manifestu, **nepushnuto**) – slouží jen jako důkaz čistého začlenění.
