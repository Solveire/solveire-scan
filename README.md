# Solveire Scan V13 — echte scan

Deze versie gebruikt Cloudflare Pages Functions.

## Structuur
- `index.html` — interne Solveire Scan + Bedrijven CRM
- `functions/api/scan.js` — backend die websites echt ophaalt en analyseert

## Deploy
Upload beide naar dezelfde GitHub repository. De map `functions` moet in de root van de repository staan, naast `index.html`.

Cloudflare Pages detecteert `/functions/api/scan.js` automatisch als route:
`POST /api/scan`

## OpenAI (optioneel maar aanbevolen)
Zonder API key:
- echte HTML crawl
- feitelijke signalen
- deterministische scores
- feitelijk mailvoorstel

Met OpenAI:
- dezelfde echte feiten
- betere interpretatie
- persoonlijke mail in Prescilla/Solveire tone of voice
- AI mag geen nieuwe feiten verzinnen

Cloudflare:
Workers & Pages → solveire-scan → Settings → Variables and Secrets → Add

Naam:
`OPENAI_API_KEY`

Waarde:
jouw OpenAI API key

Kies **Encrypt / Secret**.

Optioneel:
`OPENAI_MODEL` = `gpt-5.6-luna`

Redeploy daarna de Pages-app.

## Belangrijk
V13 doet nog GEEN visuele screenshotanalyse. De mobiele score gebruikt alleen aantoonbare HTML-signalen (zoals viewport, contactroute en CTA's) en claimt niet dat een knop visueel zichtbaar/onzichtbaar is.

De volgende stap is Cloudflare Browser Rendering / Playwright toevoegen voor echte desktop- en mobiele screenshots.
