import { http } from '@google-cloud/functions-framework';
import { webkit } from 'playwright-webkit';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import dayjs from 'dayjs';

// --- ENV VARS ---
const SHEET_ID = process.env.SHEET_ID as string;

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

interface TrendsParams {
  geo?: string;       // e.g. 'US', 'GB', 'AU'
  category?: number;  // 3 = Business & Finance
  sortByVolume?: boolean;
}

interface TrendKeyword {
  keyword: string;
  searchVolume: string;
  date: string;
}

interface FinanceNews {
  title: string;
  summary: string;
  url: string;
}

// -----------------------------------------------------------------------
// Google Sheets Auth
// -----------------------------------------------------------------------

function getSheetsClient() {
  // Load credentials from GOOGLE_CREDENTIALS_JSON env var (JSON string)
  // or fall back to key.json on disk. fromJSON handles all credential types
  // (service account, OAuth2, ExternalAccountAuthorizedUserClient, etc.)
  // without the type-mismatch errors caused by GoogleAuth.getClient().
  const raw = process.env.GOOGLE_CREDENTIALS_JSON
    ? process.env.GOOGLE_CREDENTIALS_JSON
    : readFileSync('./key.json', 'utf-8');

  const key = JSON.parse(raw);
  const auth = google.auth.fromJSON(key);

  // fromJSON returns a narrowly-typed credential — cast to `any` to satisfy
  // the googleapis overloads that still expect OAuth2Client specifically.
  return google.sheets({ version: 'v4', auth: auth as any });
}

// -----------------------------------------------------------------------
// Google Sheets Writer — two tabs
// -----------------------------------------------------------------------

async function writeToSheets(
  trends: TrendKeyword[],
  financeNews: FinanceNews[]
): Promise<void> {
  const sheets = getSheetsClient();

  // ---- Ensure both tabs exist ----
  const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existingSheets = sheetMeta.data.sheets?.map((s) => s.properties?.title) || [];

  const tabsToCreate: string[] = [];
  if (!existingSheets.includes('Google Trends')) tabsToCreate.push('Google Trends');
  if (!existingSheets.includes('Google Finance News')) tabsToCreate.push('Google Finance News');

  if (tabsToCreate.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: tabsToCreate.map((title) => ({
          addSheet: { properties: { title } },
        })),
      },
    });
  }

  const date = dayjs().format('DD-MM-YYYY HH:mm');

  // ---- Tab 1: Google Trends ----
  const trendsRows: string[][] = [
    ['Date Fetched', 'Keyword', 'Search Volume'],
    ...trends.map((t) => [t.date, t.keyword, t.searchVolume]),
  ];

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'Google Trends!A1:Z10000',
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Google Trends!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: trendsRows },
  });

  // ---- Tab 2: Google Finance News ----
  const newsRows: string[][] = [
    ['Date Fetched', 'Title', 'Summary', 'URL'],
    ...financeNews.map((n) => [date, n.title, n.summary, n.url]),
  ];

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'Google Finance News!A1:Z10000',
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Google Finance News!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: newsRows },
  });

  console.log('Sheets updated successfully.');
}

// -----------------------------------------------------------------------
// Scraper: Google Trends (Playwright)
// -----------------------------------------------------------------------

async function fetchTrends({
  geo = 'US',
  category = 3,
  sortByVolume = true,
}: TrendsParams = {}): Promise<TrendKeyword[]> {
  const url = `https://trends.google.com/trending?geo=${geo}&category=${category}`;

  const browser = await webkit.launch();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    if (sortByVolume) {
      const volumeHeader = await page.$(
        '[data-col="searchVolume"], th:has-text("Search volume"), button:has-text("Search volume")'
      );
      if (volumeHeader) {
        await volumeHeader.click();
        await page.waitForTimeout(1000);
      }
    }

    let keywords = await page.evaluate(() => {
      const results: { keyword: string; searchVolume: string }[] = [];
      const rows = document.querySelectorAll(
        'tr.trending-searches-item, div[jsname] table tr, .fe-atoms-trending-table-row, tr'
      );
      rows.forEach((row) => {
        const keywordEl =
          row.querySelector('.mZ3RIc, .title, td:nth-child(2), [data-trend-title]') ||
          row.querySelector('a, td');
        const volumeEl =
          row.querySelector('.search-count-title, .TXt85b, td:nth-child(3), [data-volume]') ||
          row.querySelector('td:last-child');

        const keyword = keywordEl?.textContent?.trim();
        const searchVolume = volumeEl?.textContent?.trim();

        if (keyword && keyword.length > 1 && searchVolume) {
          results.push({ keyword, searchVolume });
        }
      });
      return results;
    });

    // Fallback: broader table row selector
    if (keywords.length === 0) {
      keywords = await page.evaluate(() => {
        const results: { keyword: string; searchVolume: string }[] = [];
        document.querySelectorAll('table tbody tr').forEach((row) => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) {
            const keyword = cells[1]?.textContent?.trim() || cells[0]?.textContent?.trim();
            const searchVolume =
              cells[2]?.textContent?.trim() || cells[cells.length - 1]?.textContent?.trim();
            if (keyword && keyword.length > 1) {
              results.push({ keyword, searchVolume: searchVolume || '' });
            }
          }
        });
        return results;
      });
    }

    const date = dayjs().format('DD-MM-YYYY');
    return keywords.map((k) => ({ ...k, date }));
  } finally {
    await browser.close();
  }
}

// -----------------------------------------------------------------------
// Scraper: Google Finance News (Playwright)
// -----------------------------------------------------------------------

async function fetchFinance(): Promise<FinanceNews[]> {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto('https://www.google.com/finance/beta', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    const news = await page.evaluate(() => {
      const results: { title: string; summary: string; url: string }[] = [];

      const articles = document.querySelectorAll(
        'article, .yY3Lee, .Yfwt5, [data-article-source-name], .z4rs2b, .F4T3yd'
      );

      articles.forEach((article) => {
        const titleEl = article.querySelector(
          'a, .Yfwt5, .gPFEn, h3, h4, [class*="title"], [class*="headline"]'
        );
        const summaryEl = article.querySelector(
          '.Bvmkz, .SEtOe, p, [class*="summary"], [class*="snippet"], [class*="description"]'
        );
        const linkEl = article.querySelector('a[href]') as HTMLAnchorElement | null;

        const title = titleEl?.textContent?.trim() || '';
        const summary = summaryEl?.textContent?.trim() || '';
        const url = linkEl?.href || '';

        if (title && title.length > 2) {
          results.push({ title, summary, url });
        }
      });

      // Fallback: any /news/ links
      if (results.length === 0) {
        document.querySelectorAll('a[href*="/news/"]').forEach((link) => {
          const title = link.textContent?.trim() || '';
          const url = (link as HTMLAnchorElement).href || '';
          if (title.length > 5) {
            results.push({ title, summary: '', url });
          }
        });
      }

      return results;
    });

    // Deduplicate by title
    const seen = new Set<string>();
    return news.filter((item) => {
      if (seen.has(item.title)) return false;
      seen.add(item.title);
      return true;
    });
  } finally {
    await browser.close();
  }
}

// -----------------------------------------------------------------------
// Cloud Function Entry Point
// -----------------------------------------------------------------------

http('scrapeTrendsAndFinance', async (req, res) => {
  try {
    const geo = (req.query.geo as string) || 'US';
    const category = parseInt((req.query.category as string) || '3', 10);
    const sortByVolume = req.query.sortByVolume !== 'false';

    const [trends, financeNews] = await Promise.all([
      fetchTrends({ geo, category, sortByVolume }),
      fetchFinance(),
    ]);

    console.log(
      `Fetched ${trends.length} trending keywords and ${financeNews.length} finance news items.`
    );

    await writeToSheets(trends, financeNews);

    res.status(200).json({
      success: true,
      trendsInserted: trends.length,
      newsInserted: financeNews.length,
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});