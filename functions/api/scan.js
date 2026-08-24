const MAX_PAGES = 5;
const MAX_HTML = 350000;
const FETCH_TIMEOUT = 10000;

const BROWSER_TIMEOUT = 30000;


const CTA_WORDS = [
  "offerte","contact","afspraak","plan","bel","bel ons","aanvragen","aanvraag",
  "advies","kennismaken","start","boek","reserveer","meer informatie","vrijblijvend"
];
const TRUST_WORDS = [
  "review","reviews","klant","klanten","ervaring","ervaringen","testimonial",
  "referentie","referenties","beoordeling","beoordelingen","trustpilot","google reviews"
];
const PROJECT_WORDS = ["project","projecten","case","cases","portfolio","realisatie","realisaties","werk"];
const ABOUT_WORDS = ["over ons","over mij","team","ons team","wie zijn wij","bedrijf"];
const SERVICE_WORDS = ["dienst","diensten","services","oplossingen","specialist"];
const CONTACT_WORDS = ["contact","offerte","afspraak","aanvraag","bel","mail"];

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const target = normalizeUrl(body?.url);
    if (!target) return json({ error: "Vul een geldige http(s)-website in." }, 400);
    if (!isSafePublicTarget(target)) return json({ error: "Deze URL kan niet worden gescand." }, 400);

    const crawl = await crawlSite(target);
    if (!crawl.pages.length) return json({ error: "De website kon niet worden opgehaald." }, 422);

    const facts = buildFacts(crawl);

    // Visual rendering is optional but strongly preferred.
    // It uses Browser Run REST so it also works from a Pages Function.
    let visual = null;
    if (context.env.CF_BROWSER_ACCOUNT_ID && context.env.CF_BROWSER_API_TOKEN) {
      try {
        visual = await collectVisualEvidence(
          context.env,
          facts.scanned_pages[0] || target.toString()
        );
      } catch (err) {
        console.log("Visual analysis failed:", err?.message || err);
      }
    }

    const deterministic = deterministicAssessment(facts, visual);

    let ai = null;
    if (context.env.OPENAI_API_KEY) {
      try {
        ai = await analyzeWithOpenAI(context.env, facts, deterministic, visual);
      } catch (err) {
        console.log("AI analysis failed:", err?.message || err);
      }
    }

    const final = mergeAssessment(facts, deterministic, ai, visual);
    return json(final, 200);
  } catch (err) {
    return json({ error: err?.message || "Onbekende fout tijdens scan." }, 500);
  }
}

function normalizeUrl(value) {
  if (!value || typeof value !== "string") return null;
  let raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    return u;
  } catch { return null; }
}

function isSafePublicTarget(u) {
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const p = h.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return false;
    if (p[0] === 169 && p[1] === 254) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
  }
  return true;
}


async function collectVisualEvidence(env, url) {
  const desktop = await browserSnapshot(env, url, { width: 1440, height: 900, deviceScaleFactor: 1 });
  const mobile = await browserSnapshot(env, url, { width: 390, height: 844, deviceScaleFactor: 1 });

  const desktopVisual = analyzeRenderedSnapshot(desktop, "desktop");
  const mobileVisual = analyzeRenderedSnapshot(mobile, "mobile");

  return {
    used: true,
    desktop: desktopVisual,
    mobile: mobileVisual,
    // Base64 screenshots are held server-side for multimodal AI, not returned to the frontend.
    _desktopScreenshot: desktop.screenshot || null,
    _mobileScreenshot: mobile.screenshot || null
  };
}

async function browserSnapshot(env, url, viewport) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CF_BROWSER_ACCOUNT_ID}/browser-rendering/snapshot`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CF_BROWSER_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url,
      formats: ["content", "screenshot", "accessibilityTree"],
      viewport,
      screenshotOptions: { fullPage: false, type: "jpeg", quality: 68 },
      gotoOptions: { waitUntil: "networkidle2", timeout: BROWSER_TIMEOUT }
    })
  });
  const data = await res.json().catch(()=>null);
  if (!res.ok || !data?.success || !data?.result) {
    throw new Error(`Browser Run snapshot failed (${res.status})`);
  }
  return data.result;
}

function analyzeRenderedSnapshot(snapshot, mode) {
  const content = String(snapshot?.content || "");
  const tree = typeof snapshot?.accessibilityTree === "string"
    ? snapshot.accessibilityTree
    : JSON.stringify(snapshot?.accessibilityTree || {});
  const renderedText = stripTags(content).slice(0, 15000);
  const combined = (renderedText + " " + tree).toLowerCase();

  const visibleCtas = CTA_WORDS.filter(w => combined.includes(w)).slice(0, 10);
  const visibleTrust = TRUST_WORDS.filter(w => combined.includes(w)).slice(0, 10);
  const visibleProjects = PROJECT_WORDS.filter(w => combined.includes(w)).slice(0, 10);

  const renderedH1 = matchAll(content, /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, 10).map(m=>stripTags(m[1]));
  const navCount = matchAll(content, /<(nav|header)\b[\s\S]*?<\/(nav|header)>/gi, 8).length;
  const buttonCount = matchAll(content, /<(button|a)\b[^>]*>([\s\S]*?)<\/(button|a)>/gi, 120)
    .map(m=>stripTags(m[2])).filter(x=>x.trim()).length;

  return {
    mode,
    rendered_h1: renderedH1,
    visible_cta_terms: visibleCtas,
    visible_trust_terms: visibleTrust,
    visible_project_terms: visibleProjects,
    rendered_text_length: renderedText.length,
    nav_or_header_blocks: navCount,
    clickable_text_elements: buttonCount,
    accessibility_sample: tree.slice(0, 4500)
  };
}

function safeVisualForClient(visual) {
  if (!visual) return { used:false };
  return {
    used:true,
    desktop:visual.desktop,
    mobile:visual.mobile
  };
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "SolveireScan/1.0 (+website quality analysis)",
        "Accept": "text/html,application/xhtml+xml"
      }
    });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.includes("text/html")) return null;
    const text = (await res.text()).slice(0, MAX_HTML);
    return { url: new URL(res.url), html: text, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function matchAll(html, regex, limit = 40) {
  const out = [];
  let m;
  while ((m = regex.exec(html)) && out.length < limit) out.push(m);
  return out;
}

function extractPage(page) {
  const html = page.html;
  const text = stripTags(html);
  const lower = text.toLowerCase();

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  const metaDescription = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1] || "").trim();

  const h1s = matchAll(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, 10).map(m => stripTags(m[1]));
  const h2s = matchAll(html, /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, 30).map(m => stripTags(m[1]));

  const links = matchAll(html, /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, 120).map(m => ({
    href: m[1],
    text: stripTags(m[2]).slice(0, 120)
  }));

  const buttons = matchAll(html, /<button\b[^>]*>([\s\S]*?)<\/button>/gi, 40).map(m => stripTags(m[1]).slice(0, 120));
  const forms = matchAll(html, /<form\b[\s\S]*?<\/form>/gi, 15).map(m => {
    const snippet = m[0];
    return {
      inputs: (snippet.match(/<(input|textarea|select)\b/gi) || []).length,
      text: stripTags(snippet).slice(0, 250)
    };
  });

  const images = matchAll(html, /<img\b[^>]*>/gi, 120).map(m => {
    const tag = m[0];
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? null;
    return { alt };
  });

  const schemaTypes = matchAll(html, /"@type"\s*:\s*"([^"]+)"/gi, 30).map(m => m[1]);
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const telLinks = links.filter(l => /^tel:/i.test(l.href));
  const mailLinks = links.filter(l => /^mailto:/i.test(l.href));
  const ctaMatches = [...links.map(l => l.text), ...buttons].filter(t => hasAny(t.toLowerCase(), CTA_WORDS));
  const trustMatches = snippetsForWords(text, TRUST_WORDS);
  const projectMatches = snippetsForWords(text, PROJECT_WORDS);
  const aboutMatches = snippetsForWords(text, ABOUT_WORDS);

  return {
    url: page.url.toString(),
    pathname: page.url.pathname,
    title, metaDescription, h1s, h2s, links, buttons, forms,
    imageCount: images.length,
    missingAltCount: images.filter(i => i.alt === null || i.alt.trim() === "").length,
    schemaTypes: [...new Set(schemaTypes)],
    hasViewport, telCount: telLinks.length, mailCount: mailLinks.length,
    ctaMatches: [...new Set(ctaMatches)].slice(0, 12),
    trustMatches: trustMatches.slice(0, 8),
    projectMatches: projectMatches.slice(0, 8),
    aboutMatches: aboutMatches.slice(0, 8),
    textSample: text.slice(0, 9000),
    wordCount: text ? text.split(/\s+/).length : 0
  };
}

function hasAny(text, words) { return words.some(w => text.includes(w)); }

function snippetsForWords(text, words) {
  const lower = text.toLowerCase();
  const out = [];
  for (const w of words) {
    let idx = lower.indexOf(w);
    if (idx >= 0) out.push(text.slice(Math.max(0, idx - 70), Math.min(text.length, idx + 150)));
  }
  return [...new Set(out)];
}

async function crawlSite(startUrl) {
  const first = await fetchHtml(startUrl);
  if (!first) return { pages: [] };
  const firstData = extractPage(first);
  const origin = first.url.origin;

  const candidates = [];
  for (const l of firstData.links) {
    try {
      const u = new URL(l.href, first.url);
      if (u.origin !== origin || !["http:", "https:"].includes(u.protocol)) continue;
      u.hash = "";
      const path = u.pathname.toLowerCase();
      if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|xml)$/i.test(path)) continue;
      let score = 0;
      if (hasAny(path + " " + l.text.toLowerCase(), PROJECT_WORDS)) score += 5;
      if (hasAny(path + " " + l.text.toLowerCase(), ABOUT_WORDS)) score += 4;
      if (hasAny(path + " " + l.text.toLowerCase(), CONTACT_WORDS)) score += 4;
      if (hasAny(path + " " + l.text.toLowerCase(), SERVICE_WORDS)) score += 4;
      if (u.pathname !== "/" && u.pathname.split("/").filter(Boolean).length <= 2) score += 1;
      if (score > 0) candidates.push({ url: u.toString(), score });
    } catch {}
  }

  const unique = [...new Map(candidates.sort((a,b)=>b.score-a.score).map(x => [x.url, x])).values()].slice(0, MAX_PAGES - 1);
  const pages = [firstData];

  for (const c of unique) {
    try {
      const p = await fetchHtml(new URL(c.url));
      if (p) pages.push(extractPage(p));
    } catch {}
  }
  return { pages };
}

function buildFacts(crawl) {
  const pages = crawl.pages;
  const home = pages[0];
  const allText = pages.map(p => p.textSample).join(" ");
  const links = pages.flatMap(p => p.links);
  const allH1 = pages.flatMap(p => p.h1s);
  const allForms = pages.flatMap(p => p.forms);
  const allSchema = [...new Set(pages.flatMap(p => p.schemaTypes))];

  const reviewSignal = pages.some(p => p.trustMatches.length > 0);
  const projectSignal = pages.some(p => p.projectMatches.length > 0) || pages.some(p => hasAny(p.pathname.toLowerCase(), PROJECT_WORDS));
  const aboutSignal = pages.some(p => p.aboutMatches.length > 0) || pages.some(p => hasAny(p.pathname.toLowerCase(), ABOUT_WORDS));
  const contactSignal = pages.some(p => p.telCount || p.mailCount || p.forms.length);
  const servicePages = pages.filter(p => p.pathname !== "/" && (hasAny(p.pathname.toLowerCase(), SERVICE_WORDS) || p.wordCount > 250)).length;
  const ctas = [...new Set(pages.flatMap(p => p.ctaMatches))].filter(Boolean);

  const locationCandidates = [...new Set(
    (allText.match(/\b[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ]+(?:\s[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ]+)?\b/g) || [])
      .filter(x => x.length >= 4 && x.length <= 35)
  )].slice(0, 80);

  return {
    hostname: new URL(home.url).hostname.replace(/^www\./, ""),
    scanned_pages: pages.map(p => p.url),
    page_count: pages.length,
    home: {
      title: home.title,
      meta_description: home.metaDescription,
      h1s: home.h1s,
      h2s: home.h2s.slice(0, 12),
      ctas: home.ctaMatches,
      has_viewport: home.hasViewport,
      forms: home.forms,
      tel_count: home.telCount,
      mail_count: home.mailCount,
      word_count: home.wordCount
    },
    aggregate: {
      h1_count: allH1.length,
      review_signal: reviewSignal,
      project_signal: projectSignal,
      about_signal: aboutSignal,
      contact_signal: contactSignal,
      service_page_count: servicePages,
      ctas,
      form_count: allForms.length,
      max_form_fields: allForms.length ? Math.max(...allForms.map(f => f.inputs)) : 0,
      schema_types: allSchema,
      image_count: pages.reduce((a,p)=>a+p.imageCount,0),
      missing_alt_count: pages.reduce((a,p)=>a+p.missingAltCount,0),
      location_candidates: locationCandidates
    },
    pages: pages.map(p => ({
      url: p.url,
      title: p.title,
      meta_description: p.metaDescription,
      h1s: p.h1s,
      h2s: p.h2s.slice(0,10),
      ctas: p.ctaMatches,
      trust_snippets: p.trustMatches.slice(0,3),
      project_snippets: p.projectMatches.slice(0,3),
      forms: p.forms,
      word_count: p.wordCount
    }))
  };
}

function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }

function deterministicAssessment(f, visual = null) {
  const h=f.home, a=f.aggregate;

  let first = 0;
  first += h.h1s.length === 1 ? 5 : h.h1s.length > 0 ? 3 : 0;
  first += h.title && h.title.length >= 20 ? 4 : h.title ? 2 : 0;
  first += h.meta_description ? 3 : 0;
  first += h.ctas.length >= 1 ? 5 : 1;
  first += h.word_count >= 180 ? 3 : h.word_count >= 80 ? 2 : 1;
  first = clamp(first,0,20);

  let mobile = 0;
  mobile += h.has_viewport ? 6 : 0;
  mobile += (h.tel_count > 0 || h.mail_count > 0 || h.forms.length > 0) ? 4 : 1;
  mobile += h.ctas.length > 0 ? 3 : 1;
  if (visual?.mobile) {
    mobile += visual.mobile.visible_cta_terms.length ? 4 : 1;
    mobile += visual.mobile.rendered_text_length > 250 ? 2 : 1;
    mobile += visual.mobile.nav_or_header_blocks > 0 ? 1 : 0;
  } else {
    mobile += 2; // neutral baseline if Browser Run isn't configured
  }
  mobile = clamp(mobile,0,20);

  let trust = 0;
  trust += a.review_signal ? 6 : 1;
  trust += a.project_signal ? 6 : 1;
  trust += a.about_signal ? 4 : 1;
  trust += a.schema_types.some(x=>/LocalBusiness|Organization|Person|ProfessionalService/i.test(x)) ? 2 : 0;
  trust += a.contact_signal ? 2 : 0;
  trust = clamp(trust,0,20);

  let conversion = 0;
  conversion += a.ctas.length >= 2 ? 7 : a.ctas.length === 1 ? 5 : 1;
  conversion += a.contact_signal ? 5 : 1;
  conversion += a.form_count > 0 ? (a.max_form_fields <= 6 ? 4 : 2) : 1;
  conversion += (a.review_signal || a.project_signal) ? 3 : 1;
  conversion += h.ctas.length > 0 ? 1 : 0;
  conversion = clamp(conversion,0,20);

  let seo = 0;
  seo += h.title ? 4 : 0;
  seo += h.meta_description ? 3 : 0;
  seo += h.h1s.length === 1 ? 4 : h.h1s.length > 0 ? 2 : 0;
  seo += a.service_page_count >= 2 ? 4 : a.service_page_count === 1 ? 2 : 1;
  seo += a.schema_types.length > 0 ? 2 : 0;
  const altRatio = a.image_count ? 1 - (a.missing_alt_count / a.image_count) : .5;
  seo += altRatio > .75 ? 3 : altRatio > .4 ? 2 : 1;
  seo = clamp(seo,0,20);

  const website_total = first+mobile+trust+conversion+seo;

  const improvement = clamp(Math.round((100-website_total)*0.42),5,30);
  const business = clamp((a.project_signal?8:3)+(a.review_signal?7:2)+(a.about_signal?5:2)+(a.service_page_count?5:2),0,25);
  const traction = clamp((a.review_signal?8:2)+(a.project_signal?7:2)+(a.contact_signal?3:1)+(a.service_page_count>=2?2:1),0,20);
  const custom = clamp((website_total<70?7:3)+(a.service_page_count>=2?4:2)+(a.form_count?2:1)+(a.project_signal?2:1),0,15);
  const reachability = clamp((a.contact_signal?7:2)+(h.mail_count?2:0)+(h.tel_count?1:0),0,10);
  const opportunity = clamp(improvement+business+traction+custom+reachability,0,100);

  const evidence = buildEvidence(f, {first,mobile,trust,conversion,seo}, visual);
  const fallback = fallbackNarrative(f, {first,mobile,trust,conversion,seo,website_total}, opportunity, evidence, visual);

  return {
    scores:{first_impression:first,mobile,trust,conversion,seo,website_total},
    opportunity:{
      total:opportunity,
      label: opportunity>=80?"Prioriteit":opportunity>=65?"Interessant":opportunity>=45?"Lage prioriteit":"Overslaan",
      match: opportunity>=80?"Sterke Maatwerk-match":opportunity>=65?"Interessante Maatwerk-kans":"Beperkte match",
      breakdown:{improvement,business,traction,custom,reachability}
    },
    evidence,
    analysis:fallback.analysis,
    mail:fallback.mail,
    confidence:deterministicConfidence(f, visual)
  };
}

function buildEvidence(f, scores, visual = null) {
  const h=f.home,a=f.aggregate;
  const ev = [
    {label:"Gescande pagina’s", value:`${f.page_count} pagina('s): ${f.scanned_pages.map(x=>new URL(x).pathname||"/").join(", ")}`},
    {label:"Hoofdtitel", value:h.h1s.length ? h.h1s.join(" | ") : "Geen H1 aangetroffen op homepage"},
    {label:"Primaire acties", value:h.ctas.length ? h.ctas.join(", ") : "Geen duidelijke CTA-tekst aangetroffen op homepage"},
    {label:"Vertrouwen", value:`Reviews/signaal: ${a.review_signal?"gevonden":"niet gevonden"} · Projecten/cases: ${a.project_signal?"gevonden":"niet gevonden"} · Over/team: ${a.about_signal?"gevonden":"niet gevonden"}`},
    {label:"Contactroute", value:`Formulieren: ${a.form_count} · grootste formulier: ${a.max_form_fields} velden · tel/mail-links aanwezig: ${a.contact_signal?"ja":"nee"}`},
    {label:"SEO-basis", value:`Title: ${h.title?"ja":"nee"} · meta description: ${h.meta_description?"ja":"nee"} · schema: ${a.schema_types.length?a.schema_types.join(", "):"geen aangetroffen"}`},
    {label:"Mobiel technisch", value:h.has_viewport?"Viewport-tag gevonden.":"Geen viewport-tag gevonden."}
  ];
  if (visual?.used) {
    ev.push({
      label:"Mobiele render",
      value:`Gerenderd op 390×844. Zichtbare CTA-termen: ${visual.mobile.visible_cta_terms.length ? visual.mobile.visible_cta_terms.join(", ") : "geen duidelijke termen gedetecteerd"}.`,
      source:"visual"
    });
    ev.push({
      label:"Desktop render",
      value:`Gerenderd op 1440×900. Zichtbare CTA-termen: ${visual.desktop.visible_cta_terms.length ? visual.desktop.visible_cta_terms.join(", ") : "geen duidelijke termen gedetecteerd"}.`,
      source:"visual"
    });
  } else {
    ev.push({label:"Visuele render", value:"Niet uitgevoerd. Configureer Cloudflare Browser Run voor echte desktop- en mobiele rendering."});
  }
  return ev;
}

function fallbackNarrative(f, scores, opportunity, evidence, visual = null) {
  const a=f.aggregate,h=f.home;
  const problems=[];
  if (!a.review_signal) problems.push("Op de gescande pagina’s is geen duidelijk review- of klantbewijs aangetroffen.");
  if (!a.project_signal) problems.push("Op de gescande pagina’s zijn geen duidelijke projecten/cases aangetroffen.");
  if (!h.ctas.length) problems.push("Op de homepage is geen duidelijke CTA-tekst aangetroffen.");
  if (a.max_form_fields > 7) problems.push(`Het grootste aangetroffen formulier bevat ${a.max_form_fields} velden, wat relatief veel frictie kan geven.`);
  if (!h.meta_description) problems.push("De homepage heeft geen meta description aangetroffen.");
  if (h.h1s.length !== 1) problems.push(`De homepage heeft ${h.h1s.length} H1-koppen aangetroffen.`);
  if (!h.has_viewport) problems.push("Er is geen viewport-tag aangetroffen voor mobiele weergave.");
  if (visual?.mobile && visual.mobile.visible_cta_terms.length === 0) {
    problems.push("In de mobiele render is binnen de gerenderde toegankelijkheids- en tekststructuur geen duidelijke CTA-term gedetecteerd.");
  }

  const strengths=[];
  if (a.project_signal) strengths.push("Projecten/cases zijn aantoonbaar aanwezig.");
  if (a.review_signal) strengths.push("Klantbewijs/reviews zijn aantoonbaar aanwezig.");
  if (h.ctas.length) strengths.push(`Er is minimaal één duidelijke actie gevonden: ${h.ctas.slice(0,2).join(", ")}.`);
  if (a.contact_signal) strengths.push("Er is een concrete contact- of aanvraagroute aanwezig.");
  if (a.service_page_count) strengths.push(`${a.service_page_count} relevante inhoudelijke vervolgpagina('s) zijn gescand.`);

  const primary = problems[0] || "De basis staat redelijk sterk; de grootste kans zit vooral in verdere verfijning van conversie en presentatie.";
  const bestEvidence = evidence.find(e=>/Vertrouwen|Contactroute|Primaire acties/.test(e.label))?.value || evidence[0].value;

  const why = [
    {title: opportunity>=80?"Hoge verbeterpotentie":"Concrete verbeterpotentie", detail: primary},
    {title:"Feitelijk onderbouwd", detail:bestEvidence},
    {title:"Geen geforceerde probleemstelling", detail:"Als een element niet betrouwbaar is vastgesteld, wordt het niet als feit gepresenteerd."}
  ];

  const contactAngle = primary;
  const company = f.hostname.split(".")[0].replace(/[-_]/g," ").replace(/\b\w/g,m=>m.toUpperCase());
  const body=`Goedemiddag,\n\nIk kwam de website van ${company} tegen en er viel me iets concreets op.\n\n${contactAngle}\n\nGeen wereldramp natuurlijk 😉 maar wel zo'n punt waarvan ik denk dat de website er sterker van kan worden.\n\nIk heb tijdens het kijken nog een paar concrete dingen genoteerd. Als je wilt, stuur ik ze gewoon even door.\n\nGroet,\nPrescilla\nSolveire`;

  return {
    analysis:{
      commercial_observation: primary,
      contact_angle: contactAngle,
      best_evidence: bestEvidence,
      evidence_note:"Deze observatie komt rechtstreeks uit de gescande HTML en gevonden pagina-elementen.",
      why_contact: why,
      strengths
    },
    mail:{subject:"Kleine observatie over jullie website",body}
  };
}

async function analyzeWithOpenAI(env, facts, deterministic, visual = null) {
  const visualFacts = visual ? safeVisualForClient(visual) : {used:false};

  const prompt = `Je bent de interne website-analist van Solveire. Geef eerlijke feedback op basis van ALLEEN aantoonbaar bewijs.

HARD RULES
- Verzin nooit reviews, posities, omzetverlies, bezoekersgedrag of conversie-impact.
- Maak onderscheid tussen technisch bewijs, gerenderd visueel bewijs en interpretatie.
- Als iets niet kan worden vastgesteld, schrijf "niet vastgesteld".
- Zoek NIET verplicht drie problemen. Een onderdeel mag gewoon goed zijn.
- Mobiele visuele claims mogen alleen wanneer visual.used=true en de render dit ondersteunt.
- Scores mogen maximaal 3 punten afwijken van de deterministische categorie-score, tenzij een gerenderd screenshot dit duidelijk rechtvaardigt.
- Mail gebruikt slechts één sterke observatie, geen lijst met generieke websiteproblemen.
- Mail is Nederlands, menselijk, warm en zelfverzekerd. Licht tongue-in-cheek als het natuurlijk voelt. Geen gladde salespraat of overdreven complimenten.
- Geen claims als "u verliest klanten" tenzij bewijs dat letterlijk aantoont, wat praktisch nooit het geval is.
- De eerste mail verkoopt niet; hij maakt nieuwsgierig.
- Bepaal eerst één unieke hook die aantoonbaar bij DIT bedrijf hoort: concrete dienst, project, propositie, regio, headline of ander specifiek website-detail. Alleen bedrijfsnaam telt niet.
- Benoem één concreet sterk punt en maximaal één gemiste kans.
- Vermijd standaard acquisitietaal zoals "online aanwezigheid", "naar een hoger niveau", "optimaliseren", "kansen benutten", "ik kwam toevallig jullie website tegen" en "geen verkooppraatje hoor".
- Geen geforceerde complimenten. Als de hook onvoldoende uniek is: personalization.usable=false.
- Tongue-in-cheek alleen als het natuurlijk past.

Geef ALLEEN geldig JSON:
{
 "company_name": string,
 "scores":{"first_impression":0-20,"mobile":0-20,"trust":0-20,"conversion":0-20,"seo":0-20},
 "confidence":{"first_impression":0-100,"mobile":0-100,"trust":0-100,"conversion":0-100,"seo":0-100,"overall":0-100},
 "analysis":{
   "commercial_observation":string,
   "contact_angle":string,
   "best_evidence":string,
   "evidence_note":string,
   "why_contact":[
     {"title":string,"detail":string},
     {"title":string,"detail":string},
     {"title":string,"detail":string}
   ]
 },
 "personalization":{"hook":string,"strength":string,"opportunity":string,"confidence":0-100,"usable":boolean},
 "visual_findings":[
   {"label":string,"detail":string,"confidence":0-100}
 ],
 "mail":{"subject":string,"body":string}
}

HTML/CRAWL BEWIJS:
${JSON.stringify(facts)}

VISUEEL/Gerenderd BEWIJS:
${JSON.stringify(visualFacts)}

DETERMINISTISCHE SCORES:
${JSON.stringify(deterministic.scores)}
`;

  const content = [{ type:"input_text", text:prompt }];

  // If Browser Run returned screenshots, let the multimodal model inspect them directly.
  if (visual?._desktopScreenshot) {
    content.push({
      type:"input_image",
      image_url:`data:image/jpeg;base64,${visual._desktopScreenshot}`
    });
  }
  if (visual?._mobileScreenshot) {
    content.push({
      type:"input_image",
      image_url:`data:image/jpeg;base64,${visual._mobileScreenshot}`
    });
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method:"POST",
    headers:{
      "Authorization":`Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.6-luna",
      input:[{
        role:"user",
        content
      }]
    })
  });
  if (!response.ok) {
    const errText = await response.text().catch(()=> "");
    throw new Error(`OpenAI ${response.status}: ${errText.slice(0,180)}`);
  }
  const data = await response.json();
  const text = extractOutputText(data);
  return parseJsonLoose(text);
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const parts=[];
  for (const item of (data.output||[])) {
    for (const c of (item.content||[])) {
      if (typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n");
}

function parseJsonLoose(text) {
  const raw = String(text||"").trim().replace(/^```json\s*/i,"").replace(/```$/,"").trim();
  try { return JSON.parse(raw); } catch {}
  const a=raw.indexOf("{"), b=raw.lastIndexOf("}");
  if (a>=0 && b>a) return JSON.parse(raw.slice(a,b+1));
  throw new Error("AI gaf geen geldig JSON-resultaat.");
}


function deterministicConfidence(facts, visual) {
  const pageFactor = clamp(55 + (facts.page_count * 6), 55, 85);
  const visualBoost = visual?.used ? 12 : 0;
  const mobile = visual?.used ? 90 : 58;
  return {
    first_impression: clamp(pageFactor + visualBoost, 0, 96),
    mobile,
    trust: clamp(pageFactor + (facts.aggregate.review_signal || facts.aggregate.project_signal ? 8 : 0), 0, 94),
    conversion: clamp(pageFactor + 5, 0, 92),
    seo: clamp(pageFactor + 8, 0, 95),
    overall: clamp(Math.round((pageFactor*4 + mobile)/5), 0, 94)
  };
}

function normalizeConfidence(aiConf, facts, visual) {
  const fallback = deterministicConfidence(facts, visual);
  const out = {...fallback};
  for (const k of ["first_impression","mobile","trust","conversion","seo","overall"]) {
    const n = Number(aiConf?.[k]);
    if (Number.isFinite(n)) out[k]=clamp(Math.round(n), 0, 100);
  }
  if (!visual?.used) out.mobile=Math.min(out.mobile,65);
  out.overall=Math.round((out.first_impression+out.mobile+out.trust+out.conversion+out.seo)/5);
  return out;
}

function fallbackPersonalization(facts,det){const h=facts.home||{},a=facts.aggregate||{};const hook=h.h1s?.[0]||h.ctas?.[0]||"";const strength=a.project_signal?"Projecten of cases zijn aantoonbaar aanwezig.":a.review_signal?"Klantbewijs is aantoonbaar aanwezig.":h.ctas?.length?`Er is een duidelijke actie aanwezig: ${h.ctas[0]}.`:"";const opportunity=det.analysis?.commercial_observation||"";const confidence=hook&&strength&&opportunity?68:40;return {hook,strength,opportunity,confidence,usable:confidence>=65}}function normalizePersonalization(p,facts,det){const f=fallbackPersonalization(facts,det),confidence=clamp(Number(p?.confidence||f.confidence),0,100),hook=String(p?.hook||f.hook||"").trim(),strength=String(p?.strength||f.strength||"").trim(),opportunity=String(p?.opportunity||f.opportunity||"").trim();return {hook,strength,opportunity,confidence,usable:Boolean(p?.usable)&&confidence>=65&&hook.length>8&&strength.length>8&&opportunity.length>8}}function mergeAssessment(facts, det, ai, visual = null) {
  if (!ai) {
    return {
      hostname:facts.hostname,
      company_name:facts.hostname.split(".")[0].replace(/[-_]/g," ").replace(/\b\w/g,m=>m.toUpperCase()),
      scanned_pages:facts.scanned_pages,
      ...det,
      confidence:det.confidence || deterministicConfidence(facts, visual),
      visual:safeVisualForClient(visual),
      personalization:fallbackPersonalization(facts,det),
      ai_used:false
    };
  }
  const scores={...det.scores};
  const keys=["first_impression","mobile","trust","conversion","seo"];
  for (const k of keys) {
    const proposed=Number(ai.scores?.[k]);
    if (Number.isFinite(proposed)) scores[k]=clamp(proposed, Math.max(0,det.scores[k]-3), Math.min(20,det.scores[k]+3));
  }
  scores.website_total=keys.reduce((sum,k)=>sum+scores[k],0);

  // Recompute improvement portion based on final score, keep factual business components.
  const o={...det.opportunity, breakdown:{...det.opportunity.breakdown}};
  o.breakdown.improvement=clamp(Math.round((100-scores.website_total)*0.42),5,30);
  o.total=Object.values(o.breakdown).reduce((a,b)=>a+b,0);
  o.label=o.total>=80?"Prioriteit":o.total>=65?"Interessant":o.total>=45?"Lage prioriteit":"Overslaan";
  o.match=o.total>=80?"Sterke Maatwerk-match":o.total>=65?"Interessante Maatwerk-kans":"Beperkte match";

  return {
    hostname:facts.hostname,
    company_name:ai.company_name || facts.hostname.split(".")[0],
    scanned_pages:facts.scanned_pages,
    scores,
    opportunity:o,
    evidence:det.evidence,
    analysis:{
      commercial_observation:ai.analysis?.commercial_observation || det.analysis.commercial_observation,
      contact_angle:ai.analysis?.contact_angle || det.analysis.contact_angle,
      best_evidence:ai.analysis?.best_evidence || det.analysis.best_evidence,
      evidence_note:ai.analysis?.evidence_note || det.analysis.evidence_note,
      why_contact:Array.isArray(ai.analysis?.why_contact) ? ai.analysis.why_contact.slice(0,3) : det.analysis.why_contact
    },
    mail:{
      subject:ai.mail?.subject || det.mail.subject,
      body:ai.mail?.body || det.mail.body
    },
    confidence:normalizeConfidence(ai.confidence, facts, visual),
    visual:safeVisualForClient(visual),
    personalization:normalizePersonalization(ai.personalization,facts,det),
    visual_findings:Array.isArray(ai.visual_findings) ? ai.visual_findings.slice(0,5) : [],
    ai_used:true
  };
}

function json(obj,status=200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store",
      "X-Content-Type-Options":"nosniff"
    }
  });
}
