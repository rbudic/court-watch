#!/usr/bin/env node
/**
 * Tyneside court watch
 * -------------------------------------------------------------
 * Checks the ClubSpark / play.tennis.com.au booking sheet for the next N
 * Sundays and reports when a court flips from "not open yet" to bookable.
 *
 *   node check.js --discover     dump everything the page gives us (run this first)
 *   node check.js                normal run: compare against state.json, notify on change
 *   node check.js --dry-run      normal run but never send a notification
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- config

const ARGS = process.argv.slice(2);
const DISCOVER = ARGS.includes('--discover');
const DRY_RUN = ARGS.includes('--dry-run');

const CFG = {
  venue: process.env.VENUE || 'TynesideTennisCourts',
  courts: (process.env.COURTS || '1,2,4,5').split(',').map((s) => s.trim()).filter(Boolean),
  slotStart: toMinutes(process.env.SLOT_START || '09:30'),
  slotEnd: toMinutes(process.env.SLOT_END || '11:30'),
  sundaysAhead: parseInt(process.env.SUNDAYS_AHEAD || '3', 10),
  role: process.env.ROLE || 'guest',
  ntfyTopic: process.env.NTFY_TOPIC || '',
  timezone: 'Australia/Sydney',
  settleMs: parseInt(process.env.SETTLE_MS || '9000', 10),
};

const STATE_PATH = path.join(__dirname, 'state.json');
const DEBUG_DIR = path.join(__dirname, 'debug');

// The phrase that marks a court that has not been released yet.
const NOT_OPEN_RE = /not\s*open\s*yet/i;

// ---------------------------------------------------------------- helpers

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

function fromMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Today's date in Sydney, as YYYY-MM-DD, regardless of where this runs. */
function sydneyToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: CFG.timezone });
}

/** The next N Sundays strictly after today (Sydney time), as YYYY-MM-DD. */
function nextSundays(n) {
  const [y, m, d] = sydneyToday().split('-').map(Number);
  let t = Date.UTC(y, m - 1, d) + 86400000;
  const out = [];
  while (out.length < n) {
    const dt = new Date(t);
    if (dt.getUTCDay() === 0) out.push(dt.toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}

function bookingUrl(date) {
  return `https://play.tennis.com.au/${CFG.venue}/Booking/BookByDate#?date=${date}&role=${CFG.role}`;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { firstRun: true, slots: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function notify(title, body) {
  console.log(`\n>>> ${title}\n${body}\n`);
  if (DRY_RUN || !CFG.ntfyTopic) {
    console.log('(notification not sent — dry run or NTFY_TOPIC unset)');
    return;
  }
  try {
    const res = await fetch(`https://ntfy.sh/${CFG.ntfyTopic}`, {
      method: 'POST',
      headers: { Title: title, Priority: 'high', Tags: 'tennis' },
      body,
    });
    console.log('notification sent:', res.status);
  } catch (err) {
    console.error('notification failed:', err.message);
  }
}

// ---------------------------------------------------------------- scraping

/** Load one date and capture both the JSON the page fetches and the rendered DOM. */
async function loadDate(context, date) {
  const page = await context.newPage();
  const json = [];

  page.on('response', async (res) => {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      json.push({ url: res.url(), status: res.status(), body: await res.text() });
    } catch {
      /* body already consumed / binary */
    }
  });

  await page.goto(bookingUrl(date), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(CFG.settleMs);

  // Every element on the sheet that looks like a bookable/blocked slot, with
  // enough context to work out which court and which time it belongs to.
  const cells = await page.evaluate(() => {
    const seen = [];
    document.querySelectorAll('a, button, div, td, li').forEach((el) => {
      const text = (el.innerText || '').trim();
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      if (!text && !label) return;
      if (el.children.length > 3) return; // skip big containers
      const blob = `${text} ${label}`;
      if (!/not\s*open|book|available|unavailable|\d{1,2}:\d{2}/i.test(blob)) return;
      seen.push({
        tag: el.tagName,
        className: String(el.className || ''),
        attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value.slice(0, 300)])),
        text: text.slice(0, 200),
        label: label.slice(0, 200),
      });
    });
    return seen.slice(0, 600);
  });

  const bodyText = await page.evaluate(() => document.body.innerText);
  const html = await page.content();
  return { page, date, json, cells, bodyText, html };
}

/**
 * Try to read the booking sheet out of the JSON the page fetched.
 * ClubSpark normally returns { Resources: [ { Name, Days: [ { Sessions: [...] } ] } ] }
 * with times as minutes past midnight. Returns null if we can't recognise it.
 */
function readFromJson(captured) {
  for (const c of captured) {
    let parsed;
    try {
      parsed = JSON.parse(c.body);
    } catch {
      continue;
    }
    const resources = parsed.Resources || parsed.resources;
    if (!Array.isArray(resources) || !resources.length) continue;

    const slots = [];
    for (const r of resources) {
      const name = String(r.Name ?? r.name ?? r.Number ?? r.ID ?? '');
      const court = (name.match(/(\d+)/) || [])[1];
      if (!court) continue;
      const days = r.Days || r.days || [];
      for (const day of days) {
        for (const s of day.Sessions || day.sessions || []) {
          const start = s.StartTime ?? s.startTime;
          const end = s.EndTime ?? s.endTime;
          if (typeof start !== 'number') continue;
          slots.push({
            court,
            start,
            end,
            notOpen: NOT_OPEN_RE.test(JSON.stringify(s)),
            raw: s,
          });
        }
      }
    }
    if (slots.length) return { source: c.url, slots };
  }
  return null;
}

/**
 * Fallback: read status straight off the rendered page. Less precise than the
 * JSON, but it only needs the words "not open yet" to be visible.
 */
function readFromDom(cells) {
  const slots = [];
  for (const cell of cells) {
    const blob = `${cell.text} ${cell.label} ${JSON.stringify(cell.attrs)}`;
    const time = blob.match(/\b(\d{1,2}):(\d{2})\b/);
    const court = blob.match(/court\s*(\d+)/i);
    if (!time || !court) continue;
    slots.push({
      court: court[1],
      start: Number(time[1]) * 60 + Number(time[2]),
      end: null,
      notOpen: NOT_OPEN_RE.test(blob),
      raw: cell,
    });
  }
  return slots.length ? { source: 'dom', slots } : null;
}

function inWindow(slot) {
  const end = slot.end ?? slot.start + 60;
  return slot.start < CFG.slotEnd && end > CFG.slotStart;
}

// ---------------------------------------------------------------- main

(async () => {
  const dates = nextSundays(CFG.sundaysAhead);
  console.log(`Sydney date: ${sydneyToday()}`);
  console.log(`Watching Sundays: ${dates.join(', ')}`);
  console.log(`Courts: ${CFG.courts.join(', ')}  Window: ${fromMinutes(CFG.slotStart)}-${fromMinutes(CFG.slotEnd)}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'en-AU',
    timezoneId: CFG.timezone,
    viewport: { width: 1440, height: 1200 },
  });

  const state = loadState();
  const previous = state.slots || {};
  const current = {};
  const opened = [];
  let parseFailed = false;

  for (const date of dates) {
    let loaded;
    try {
      loaded = await loadDate(context, date);
    } catch (err) {
      console.error(`FAILED to load ${date}: ${err.message}`);
      parseFailed = true;
      continue;
    }

    const { page, json, cells, bodyText, html } = loaded;

    if (DISCOVER) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DEBUG_DIR, `discover-${date}.json`),
        JSON.stringify({ url: bookingUrl(date), json, cells, bodyText }, null, 2)
      );
      fs.writeFileSync(path.join(DEBUG_DIR, `page-${date}.html`), html);
      await page.screenshot({ path: path.join(DEBUG_DIR, `shot-${date}.png`), fullPage: true });
      console.log(`[discover] wrote debug files for ${date} (${json.length} JSON responses, ${cells.length} candidate cells)`);
    }

    const sheet = readFromJson(json) || readFromDom(cells);

    if (!sheet) {
      console.error(`Could not read the booking sheet for ${date}.`);
      console.error(`  JSON responses seen: ${json.length}, candidate cells: ${cells.length}`);
      console.error(`  Page mentions "not open yet": ${NOT_OPEN_RE.test(bodyText)}`);
      parseFailed = true;
      if (!DISCOVER) {
        fs.mkdirSync(DEBUG_DIR, { recursive: true });
        fs.writeFileSync(path.join(DEBUG_DIR, `page-${date}.html`), html);
        await page.screenshot({ path: path.join(DEBUG_DIR, `shot-${date}.png`), fullPage: true });
      }
      await page.close();
      continue;
    }

    console.log(`\n${date}  (read from ${sheet.source === 'dom' ? 'rendered page' : 'schedule JSON'})`);

    for (const slot of sheet.slots) {
      if (!CFG.courts.includes(slot.court)) continue;
      if (!inWindow(slot)) continue;

      const key = `${date}|court${slot.court}|${fromMinutes(slot.start)}`;
      const status = slot.notOpen ? 'not-open' : 'open';
      current[key] = status;

      const was = previous[key];
      const changed = was && was !== status;
      console.log(`  court ${slot.court} ${fromMinutes(slot.start)}  ${status}${changed ? `  <-- was ${was}` : ''}`);

      if (was === 'not-open' && status === 'open') {
        opened.push({ date, court: slot.court, time: fromMinutes(slot.start) });
      }
    }

    await page.close();
  }

  await browser.close();

  // ---- report

  if (opened.length) {
    const lines = opened.map((o) => `Court ${o.court} — ${o.date} at ${o.time}`);
    const first = opened[0];
    await notify(
      `Court open: ${first.date}`,
      `${lines.join('\n')}\n\nBook: ${bookingUrl(first.date)}`
    );
  } else if (state.firstRun) {
    const openNow = Object.entries(current).filter(([, v]) => v === 'open');
    console.log(`\nFirst run — recorded ${Object.keys(current).length} slots (${openNow.length} already open). No alert sent.`);
  } else {
    console.log('\nNo change since last run.');
  }

  saveState({
    firstRun: false,
    lastChecked: new Date().toISOString(),
    lastCheckedSydney: new Date().toLocaleString('en-AU', { timeZone: CFG.timezone }),
    watching: dates,
    slots: current,
  });

  if (parseFailed && Object.keys(current).length === 0) {
    console.error('\nNothing could be read from any date — check the debug artifacts.');
    process.exit(1);
  }
})();
