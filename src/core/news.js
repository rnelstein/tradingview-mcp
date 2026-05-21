/**
 * Core news & economic calendar logic.
 * Makes direct Node.js fetch() calls to TradingView's public APIs.
 * No CDP / TradingView session required.
 *
 * News API:      https://news-mediator.tradingview.com/public/news-flow/v2/news
 * Calendar API:  https://economic-calendar.tradingview.com/events
 *
 * URL patterns discovered by inspecting TradingView's news_overview_landing.js bundle.
 * Filter format:  filter=category:commodities  |  filter=symbol:OANDA:XAUUSD
 * Calendar importance field in response: 1 = high, 0 = medium, -1 = low
 *
 * Permission levels returned by the news API:
 *   "provider" → full article requires paid subscription (Dow Jones, MarketWatch)
 *   "headline" → headline only (Reuters)
 *   "preview"  → partial content available (Trading Economics)
 *   absent     → open access (Moneycontrol, TradingView-authored)
 */

const NEWS_API     = 'https://news-mediator.tradingview.com/public/news-flow/v2/news';
const CALENDAR_API = 'https://economic-calendar.tradingview.com/events';

// Headers required to be treated as a TradingView web client (CORS + UA).
const TV_HEADERS = {
  'Origin'    : 'https://www.tradingview.com',
  'Referer'   : 'https://www.tradingview.com/',
  'Accept'    : 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

// ─── news_get ────────────────────────────────────────────────────────────────

/**
 * Fetch recent news from TradingView's news-mediator public API.
 * Filter format discovered from bundle: filter=category:commodities or filter=symbol:OANDA:XAUUSD
 *
 * The API requires the exchange-prefixed symbol (e.g. "OANDA:XAUUSD", not "XAUUSD").
 * If a bare symbol is passed and the API returns HTTP 422, we retry with category:all
 * so callers always receive results rather than a hard error.
 */
export async function getNews({ max_items = 20, symbol = null } = {}) {
  // The TV news API requires the full exchange-prefixed symbol (e.g. OANDA:XAUUSD).
  // Bare symbols (no colon) work for major FX pairs but fail for commodities/indices.
  const buildFilter = (sym) => sym ? `symbol:${sym.trim().toUpperCase()}` : 'category:all';

  const fetchNews = async (filter) => {
    const params = new URLSearchParams({ locale: 'en', client: 'web', streaming: 'false', filter });
    const response = await fetch(`${NEWS_API}?${params}`, { headers: TV_HEADERS });
    return response;
  };

  let filter = buildFilter(symbol);
  let response = await fetchNews(filter);

  // If the symbol filter was rejected (422 = unrecognised symbol format), fall back to
  // category:all so callers always get news rather than a hard error.
  let fallback_note = null;
  if (!response.ok && response.status === 422 && symbol) {
    fallback_note = `Symbol filter "${filter}" returned HTTP 422 (exchange prefix likely required, e.g. "OANDA:${symbol.trim().toUpperCase()}"). Fell back to category:all.`;
    filter = 'category:all';
    response = await fetchNews(filter);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TradingView news API: HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const d = await response.json();
  // API returns { items: [...], pagination: {...} }
  const arr = d?.items ?? d?.news ?? (Array.isArray(d) ? d : []);

  const TV_STORY_BASE = 'https://www.tradingview.com';
  const items = arr.slice(0, max_items).map(n => {
    const permission = n.permission ?? null;  // null = open access
    const storyPath  = n.storyPath ?? null;
    const externalUrl = n.link ?? n.url ?? null;
    return {
      headline   : n.title    ?? n.headline ?? '',
      source     : n.provider?.name ?? n.provider ?? n.source ?? '',
      published  : n.published ? new Date(n.published * 1000).toISOString() : (n.time ?? ''),
      url        : externalUrl ?? '',
      tv_url     : storyPath ? `${TV_STORY_BASE}${storyPath}` : '',
      permission,   // null=open, "preview"=partial, "headline"=headline only, "provider"=paywalled
      symbols    : (n.relatedSymbols ?? n.symbols ?? []).map(s => s.symbol ?? s).filter(Boolean),
    };
  });

  const result = { success: true, fetched_at: new Date().toISOString(), filter, count: items.length, news: items };
  if (fallback_note) result.note = fallback_note;
  return result;
}

// ─── news_read_article ───────────────────────────────────────────────────────

// Headers for fetching external article pages (no TradingView CORS spoof needed).
const ARTICLE_HEADERS = {
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

/**
 * Fetch and extract the full text of a news article using Mozilla Readability.
 *
 * Pass the `url` (external link) or `tv_url` from news_get output.
 * Paywalled articles (permission: "provider" or "headline") yield little or no
 * body text — callers should check the `paywall` flag in the response.
 */
export async function readArticle({ url, max_chars = 3000 } = {}) {
  if (!url) throw new Error('url is required');

  // Use TV origin headers for tradingview.com URLs, generic browser UA for external sites.
  const isTv = url.includes('tradingview.com');
  const headers = isTv
    ? { ...TV_HEADERS, Accept: 'text/html,application/xhtml+xml,*/*' }
    : ARTICLE_HEADERS;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching article: ${url}`);
  }

  const html = await response.text();

  // Dynamic imports so the module loads even if jsdom/readability are absent.
  const { JSDOM }      = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');

  const dom     = new JSDOM(html, { url });
  const reader  = new Readability(dom.window.document);
  const article = reader.parse();

  const rawText = article?.textContent?.trim() ?? '';

  // Short content is usually a paywall page, login wall, or JS-rendered shell.
  // 400 chars filters out TradingView's paywall stub (~341 chars of copyright text).
  if (rawText.length < 400) {
    return {
      success: true, url, paywall: true, body: null,
      note: 'Article body could not be extracted — likely paywalled, JS-rendered, or requires login.',
    };
  }

  const body      = rawText.replace(/\s+/g, ' ').slice(0, max_chars);
  const truncated = rawText.length > max_chars;

  return {
    success   : true,
    url,
    title     : article.title    ?? '',
    byline    : article.byline   ?? '',
    body,
    char_count: rawText.length,
    truncated,
    paywall   : false,
  };
}

// ─── calendar_get ─────────────────────────────────────────────────────────────

// Response `importance` field: 1 = high, 0 = medium, -1 = low
// Filtering is done client-side (server-side importance[] params are unreliable).
const IMPORTANCE_THRESHOLD = { high: 1, medium: 0, low: -1, all: -Infinity };
const IMPACT_LABEL         = { '1': 'HIGH', '0': 'MEDIUM', '-1': 'LOW' };

export async function getCalendar({ hours_ahead = 24, countries = null, impact = 'high' } = {}) {
  const from = new Date().toISOString();
  const to   = new Date(Date.now() + hours_ahead * 3_600_000).toISOString();

  // Build URL manually (not via URLSearchParams) to avoid double-encoding brackets.
  let url = `${CALENDAR_API}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  if (countries) {
    String(countries).split(',').map(c => c.trim().toUpperCase()).filter(Boolean)
      .forEach(c => { url += `&countries[]=${encodeURIComponent(c)}`; });
  }

  const response = await fetch(url, { headers: TV_HEADERS });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TradingView calendar API: HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const d   = await response.json();
  const all = d?.result ?? d?.events ?? (Array.isArray(d) ? d : []);

  // Client-side importance filter (1=high, 0=medium, -1=low)
  const threshold = IMPORTANCE_THRESHOLD[impact] ?? 1;
  const arr = threshold === -Infinity ? all : all.filter(ev => (ev.importance ?? -1) >= threshold);

  const events = arr.map(ev => ({
    title   : ev.title    ?? ev.event ?? '',
    country : ev.country  ?? '',
    date    : ev.date     ?? '',
    impact  : IMPACT_LABEL[String(ev.importance)] ?? String(ev.importance ?? ''),
    forecast: ev.forecast ?? null,
    previous: ev.previous ?? null,
    actual  : ev.actual   ?? null,
    unit    : ev.unit     ?? '',
    currency: ev.currency ?? '',
  }));

  return {
    success      : true,
    fetched_at   : new Date().toISOString(),
    period       : { from, to },
    impact_filter: impact,
    count        : events.length,
    events,
  };
}
