#!/usr/bin/env node
/**
 * Tyneside court watch
 * -------------------------------------------------------------
 * Reads the ClubSpark booking sheet for the next N Sundays and reports when a
 * court stops saying "Not Open Yet".
 *
 *   node check.js --discover     dump everything for debugging
 *   node check.js --dry-run      run normally but never notify
 *   node check.js                normal run
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { grid, merge, cellKey, daysAhead, ACTIONABLE } = require('./parse');

const ARGS = process.argv.slice(2);
const DISCOVER = ARGS.includes('--discover');
const DRY_RUN = ARGS.includes('--dry-run');

const CFG = {
  venue: process.env.VENUE || 'TynesideTennisCourts',
  courts: (process.env.COURTS || '1,2,4,5').split(',').map((s) => s.trim()).filter(Boolean),
  startMin: toMinutes(process.env.SLOT_START || '09:30'),
  endMin: toMinutes(process.env.SLOT_END || '11:30'),
  sundaysAhead: parseInt(process.env.SUNDAYS_AHEAD || '3', 10),
  role: process.env.ROLE || 'guest',
  ntfyTopic: process.env.NTFY_TOPIC || '',
  notifyMissed: process.env.NOTIFY_MISSED !== 'false',
  timezone: 'Australia/Sydney',
};

const STATE_PATH = path.join(__dirname, 'state.json');
const DEBUG_DIR = path.join(__dirname, 'debug');

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

function sydneyToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: CFG.timezone });
}

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

const pageUrl = (date) =>
  `https://play.tennis.com.au/${CFG.venue}/Booking/BookByDate#?date=${date}&role=${CFG.role}`;

const apiUrl = (date) =>
  `https://play.tennis.com.au/v0/VenueBooking/${CFG.venue}/GetVenueSessions` +
  `?resourceID=&startDate=${date}&endDate=${date}&roleId=&_=${Date.now()}`;

const settingsUrl = () =>
  `https://play.tennis.com.au/v0/VenueBooking/${CFG.venue}/GetSettings?_=${Date.now()}`;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { firstRun: true, slots: {} };
  }
}

async function notify(title, body, priority = 'high') {
  console.log(`\n>>> [${priority}] ${title}\n${body}\n`);
  if (DRY_RUN || !CFG.ntfyTopic) {
    console.log('(not sent — dry run or NTFY_TOPIC unset)');
    return;
  }
  try {
    const res = await fetch(`https://ntfy.sh/${CFG.ntfyTopic}`, {
      method: 'POST',
      headers: { Title: title, Priority: priority, Tags: 'tennis' },
      body,
    });
    console.log('notification sent:', res.status);
  } catch (err) {
    console.error('notification failed:', err.message);
  }
}

/** Fall back to loading the date's page and grabbing the XHR the app makes. */
async function viaPageLoad(context, date) {
  const page = await context.newPage();
  const seen = [];
  page.on('response', async (res) => {
    if (!res.url().includes('GetVenueSessions')) return;
    try {
      seen.push(JSON.parse(await res.text()));
    } catch {}
  });
  await page.goto(pageUrl(date), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000);
  if (DISCOVER) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `page-${date}.html`), await page.content());
    await page.screenshot({ path: path.join(DEBUG_DIR, `shot-${date}.png`), fullPage: true });
  }
  await page.close();
  return seen[0] || null;
}

(async () => {
  const today = sydneyToday();
  const dates = nextSundays(CFG.sundaysAhead);
  console.log(`Sydney date : ${today}`);
  console.log(`Sundays     : ${dates.map((d) => `${d} (+${daysAhead(today, d)}d)`).join(', ')}`);
  console.log(`Courts      : ${CFG.courts.join(', ')}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'en-AU',
    timezoneId: CFG.timezone,
    viewport: { width: 1440, height: 1200 },
  });

  // One page load establishes the session cookies the API calls need.
  const seed = await context.newPage();
  await seed.goto(pageUrl(dates[0]), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await seed.waitForTimeout(6000);

  // Venue settings tell us the booking rules — worth recording every run.
  let settings = null;
  try {
    const r = await seed.request.get(settingsUrl());
    if (r.ok()) settings = await r.json();
  } catch {}
  if (settings) {
    console.log(`Server time : ${settings.ServerDateTime}`);
    console.log(`Roles       : ${JSON.stringify(settings.Roles)}`);
    console.log(`New-day release time: ${settings.NewDayBookingAvailabilityTime} (minutes past midnight)`);
  }

  const state = loadState();
  const previous = state.slots || {};
  const current = {};
  const nowOpen = [];
  const missed = [];
  let failed = 0;

  for (const date of dates) {
    let payload = null;
    try {
      const res = await seed.request.get(apiUrl(date));
      if (res.ok()) payload = await res.json();
    } catch (err) {
      console.error(`  API call failed for ${date}: ${err.message}`);
    }
    if (!payload || !payload.Resources) {
      console.error(`  falling back to a full page load for ${date}`);
      payload = await viaPageLoad(context, date);
    }
    if (!payload || !payload.Resources) {
      console.error(`  could not read ${date}`);
      failed++;
      continue;
    }

    if (DISCOVER) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DEBUG_DIR, `discover-${date}.json`),
        JSON.stringify({ url: apiUrl(date), json: [{ url: apiUrl(date), body: JSON.stringify(payload) }], settings }, null, 2)
      );
    }

    const cells = grid(payload, { courts: CFG.courts, startMin: CFG.startMin, endMin: CFG.endMin });
    console.log(`\n${date}  (+${daysAhead(today, date)} days)`);
    for (const run of merge(cells)) {
      console.log(`  ${run.court.padEnd(8)} ${run.label}  ${run.status.padEnd(9)} ${run.detail}`);
    }

    for (const cell of cells) {
      const key = cellKey(cell);
      current[key] = cell.status;
      const was = previous[key];
      if (was === 'not-open' && ACTIONABLE.has(cell.status)) {
        nowOpen.push({ ...cell });
      } else if (was === 'not-open' && cell.status === 'booked') {
        missed.push({ ...cell });
      }
    }
  }

  await browser.close();

  // ---- alerts

  if (nowOpen.length) {
    const runs = merge(nowOpen);
    await notify(
      `Court open — ${runs[0].date}`,
      runs.map((r) => `${r.court}  ${r.label}  (${r.detail})`).join('\n') +
        `\n\n${pageUrl(runs[0].date)}`,
      'urgent'
    );
  }

  if (missed.length && CFG.notifyMissed) {
    const runs = merge(missed);
    await notify(
      'Released, already taken',
      runs.map((r) => `${r.court}  ${r.date}  ${r.label}`).join('\n') +
        '\n\nThe release happened since the last check — useful for working out the timing.',
      'low'
    );
  }

  if (!nowOpen.length && !missed.length) {
    console.log(state.firstRun ? '\nFirst run — baseline recorded, no alerts.' : '\nNo change since last run.');
  }

  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify(
      {
        firstRun: false,
        lastChecked: new Date().toISOString(),
        lastCheckedSydney: new Date().toLocaleString('en-AU', { timeZone: CFG.timezone }),
        serverDateTime: settings ? settings.ServerDateTime : null,
        roles: settings ? settings.Roles : null,
        newDayReleaseMinute: settings ? settings.NewDayBookingAvailabilityTime : null,
        watching: dates.map((d) => ({ date: d, daysAhead: daysAhead(today, d) })),
        slots: current,
      },
      null,
      2
    ) + '\n'
  );

  if (failed === dates.length) {
    console.error('\nEvery date failed to load.');
    process.exit(1);
  }
})();
