# luffast.com – read-only audit Cloudflare DNS + Email Routing a postup pro 5 aliasů

Audit 2026-11-26: Cloudflare API (jen GET) + veřejné DNS (`dig @1.1.1.1`). **Nic nebylo změněno** (DNS, MX, pravidla, cíle).

## Současný stav
| Oblast | Stav |
|---|---|
| Zóna | `luffast.com`, active, plán Free, NS Cloudflare; 17 DNS záznamů |
| Email Routing | **zapnutý, `ready`** |
| MX (apex) | `route1/2/3.mx.cloudflare.net` (64 / 86 / 69) – patří Email Routingu |
| SPF (apex) | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| DKIM (apex) | `cf2024-1._domainkey` (Cloudflare Email Routing) |
| DMARC (apex) | **chybí** (`_dmarc.luffast.com` neexistuje) |
| Pravidla | 1 aktivní: `privacy@luffast.com` → osobní Gmail vlastníka (maskováno `m***@gmail.com`); catch-all **vypnutý** (drop) |
| Ověřené cílové adresy | 1 (osobní Gmail vlastníka). **Demo Gmail zatím není cílovou adresou.** |
| Odesílání ClearSpace (Resend) | samostatná subdoména `notify.luffast.com`: DKIM `resend._domainkey.notify`, `send.notify` (MX + SPF Resend), `rsend.notify`, `_dmarc.notify` `p=none` |
| Weby | `clearspace.luffast.com`, `microcrm.luffast.com` = CNAME na Vercel (bez pošty) |

## Konflikty
* **Žádný.** Nové aliasy jsou na apexu, kde už MX vede do Cloudflare Email Routing; nevyžadují žádnou změnu DNS ani MX.
* Resend posílá z `notify.luffast.com` (jiná subdoména, vlastní MX `send.notify`) – na příjem pošty na apexu nemá vliv a naopak.
* Žádný jiný poštovní hosting (Google Workspace / M365 / …) – v zóně nejsou jeho MX ani ověřovací TXT.
* `microcrm@` nekoliduje s webem `microcrm.luffast.com` (adresa na apexu, subdoména jen web).
* Limit Email Routing (Free): 200 pravidel / 200 cílových adres – 5 nových pravidel je v pořádku.

## Postup (provede vlastník; DNS se nemění)
1. Cloudflare → `luffast.com` → **Email** → **Email Routing** → **Destination addresses** → **Add destination address** → demo Gmail.
   Cloudflare pošle ověřovací e-mail do demo Gmailu → vlastník ho otevře a potvrdí (**Verify email address**). Bez ověření pravidla nedoručují.
2. **Routing rules** → **Create address** pětkrát, vždy *Action: Send to an email* → demo Gmail:
   `clearspace`, `microcrm`, `support`, `sales`, `demo` (@luffast.com).
3. **Nesahat:** pravidlo `privacy@`, catch-all (nechat vypnutý), DNS záznamy, MX, SPF, DKIM. Průvodce „Add records“ se nemá objevit (DNS je `ready`);
   pokud by Cloudflare nabízel přepsat / přidat záznamy, **zastavit** – znamenalo by to změnu DNS.
4. Ověření: z externí schránky poslat e-mail na každý alias → v demo Gmailu dorazí (adresát = alias); Email Routing → **Activity log** = *Forwarded*.
5. (Volitelně, samostatné rozhodnutí – mění DNS) DMARC pro apex: `TXT _dmarc.luffast.com "v=DMARC1; p=none"`, po čase zpřísnit.

## Poznámky
* Email Routing je **jen příjem**. Odpovědi z demo Gmailu odejdou z adresy Gmailu; odesílání „jako“ `sales@luffast.com` by vyžadovalo SMTP
  (např. přes Resend se samostatným ověřením) – mimo rozsah.
* API alternativa kroků 1–2: `POST /accounts/{id}/email/routing/addresses` a `POST /zones/{id}/email/routing/rules` (oprávnění Email Routing Rules Edit);
  ověření cílové adresy kliknutím v e-mailu je i tak ruční.
* Gmail může přeposlanou poštu občas zařadit do Spamu (SRS přepis odesílatele) – při testu zkontrolovat i Spam.
