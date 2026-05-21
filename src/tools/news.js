import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/news.js';

export function registerNewsTools(server) {
  server.tool(
    'news_get',
    'Fetch the latest financial news headlines from TradingView. Optionally filter by symbol (e.g. "XAUUSD"). Returns headline, source, publish time, URL, and related symbols.',
    {
      max_items: z.coerce.number().optional().describe('Max headlines to return (default 20)'),
      symbol   : z.string().optional().describe('Filter news for a specific symbol. Use the exchange-prefixed form for best results (e.g. "OANDA:XAUUSD", "NASDAQ:AAPL"). Bare symbols like "XAUUSD" are accepted but may fall back to category:all for commodities/indices. Omit for top headlines across all markets.'),
    },
    async ({ max_items, symbol }) => {
      try { return jsonResult(await core.getNews({ max_items, symbol })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'calendar_get',
    'Fetch upcoming economic calendar events from TradingView (FOMC, NFP, CPI, central bank decisions, etc). Use before entering a trade to check for scheduled news risk.',
    {
      hours_ahead: z.coerce.number().optional().describe('How many hours ahead to look (default 24)'),
      impact     : z.enum(['high', 'medium', 'low', 'all']).optional().describe('Minimum impact level to include (default "high" = red-folder events only)'),
      countries  : z.string().optional().describe('Comma-separated ISO country codes to filter by e.g. "US,EU,GB". Omit for all countries.'),
    },
    async ({ hours_ahead, impact, countries }) => {
      try { return jsonResult(await core.getCalendar({ hours_ahead, impact, countries })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'news_read_article',
    [
      'Fetch and extract the full body text of a news article. Pass the `url` (external link) or `tv_url` from news_get output.',
      '',
      'Workflow:',
      '1. Call news_get to retrieve headlines.',
      '2. For each item where permission is null or "preview", call this tool with item.url (if set) or item.tv_url.',
      '3. Skip items where permission is "provider" or "headline" — full text requires a paid subscription.',
      '',
      'Returns: { title, byline, body (trimmed to max_chars), char_count, truncated, paywall }.',
      'If paywall=true, the site blocked access or requires login — body will be null.',
    ].join('\n'),
    {
      url      : z.string().describe('Article URL to fetch. Use item.url (external link) if present, otherwise item.tv_url (TradingView story page).'),
      max_chars: z.coerce.number().optional().describe('Maximum characters of article body to return (default 3000). Increase for deeper analysis.'),
    },
    async ({ url, max_chars }) => {
      try { return jsonResult(await core.readArticle({ url, max_chars })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
