# Solveire Scan V14 — echte crawl + visuele analyse

V14 bouwt voort op V13.

## Wat V14 nu echt doet

1. Crawlt maximaal 5 relevante pagina's.
2. Analyseert HTML, headings, CTA's, formulieren, projecten/cases, reviewsignalen, contactroute, metadata en schema.
3. Kan via **Cloudflare Browser Run** de homepage echt renderen op:
   - desktop 1440×900
   - mobiel 390×844
4. Stuurt de desktop- en mobiele screenshots, samen met het feitelijke bewijs, naar OpenAI voor multimodale analyse.
5. Iedere categorie krijgt een confidence-score.
6. Het interne scherm laat bewijs en betrouwbaarheid zien.
7. De mail wordt alleen op basis van echte bevindingen opgesteld.

## Nodige Cloudflare secrets

In Workers & Pages → jouw `solveire-scan` Pages-project → Settings → Variables and Secrets:

### OpenAI
`OPENAI_API_KEY`
jouw OpenAI API key

Optioneel:
`OPENAI_MODEL`
standaard in code: `gpt-5.6-luna`

### Cloudflare Browser Run
`CF_BROWSER_ACCOUNT_ID`
jouw Cloudflare Account ID

`CF_BROWSER_API_TOKEN`
een Cloudflare API Token met permissie **Browser Rendering - Edit**

Deze secrets blijven server-side in de Pages Function.

## Waarom REST Browser Run?

Pages Functions ondersteunen maar een subset van Cloudflare-bindings. Browser Run is rechtstreeks beschikbaar in Workers; V14 gebruikt daarom de officiële Browser Run REST Quick Actions vanuit de Pages Function. Zo hoef je je huidige Pages-architectuur niet eerst te migreren.

De endpoint die V14 gebruikt is:
`/client/v4/accounts/<accountId>/browser-rendering/snapshot`

## Belangrijk

Zonder de Browser Run secrets werkt de scan nog steeds zoals V13:
- echte crawl
- feitelijke HTML-analyse
- lagere confidence voor mobiel

Met Browser Run:
- echte desktop- en mobiele rendering
- screenshots als multimodale input voor AI
- hogere confidence voor visuele/mobile bevindingen

## Deploy

Upload alle bestanden uit deze map naar dezelfde GitHub-repository. Cloudflare Pages redeployt automatisch.

Structuur:
```text
index.html
functions/
  api/
    scan.js
README.md
.gitignore
```
