/**
 * Offline test: runs the parser over saved debug dumps and checks the result
 * against what a human read off the screenshots.
 *
 *   node test-parse.js path/to/unzipped/debug
 *
 * Run this after any change to parse.js. It needs no network.
 */

const fs = require('fs');
const path = require('path');
const { grid, merge, classify } = require('./parse');

const dir = process.argv[2] || './debug';
const OPTS = { courts: ['1', '2', '4', '5'], startMin: 570, endMin: 690 };

// What the 2026-08-23 capture should produce. Court 3 is excluded by config.
const EXPECTED = {
  '2026-08-30': {
    'Court 1': ['booked', 'booked', 'booked', 'booked'],
    'Court 2': ['booked', 'booked', 'booked', 'booked'],
    'Court 4': ['booked', 'booked', 'not-open', 'not-open'],
    'Court 5': ['booked', 'booked', 'booked', 'booked'],
  },
  '2026-09-06': 'all-not-open',
  '2026-09-13': 'all-not-open',
};

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};

// --- unit: classify ---------------------------------------------------------

console.log('classify()');
check('Not Open Yet overlay', classify({ Category: 1000, Name: 'Not Open Yet', Recurrence: true }), 'not-open');
check('Booking overlay', classify({ Category: 1000, Name: 'Booking', Recurrence: false }), 'booked');
check('Closed', classify({ Category: 8000, Name: 'Closed' }), 'closed');
check('base session', classify({ Category: 0, Name: 'Non DLS (Winter) 2026', Cost: 10.5 }), 'bookable');
check('unknown overlay is treated as blocking', classify({ Category: 1000, Name: 'Coaching' }), 'booked');

// --- fixtures ---------------------------------------------------------------

const files = fs.readdirSync(dir).filter((f) => /^discover-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
if (!files.length) {
  console.error(`\nNo discover-*.json files in ${path.resolve(dir)}`);
  process.exit(1);
}

for (const file of files) {
  const date = file.slice(9, 19);
  const dump = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const call = (dump.json || []).find((j) => j.url.includes('GetVenueSessions'));

  console.log(`\n${file}`);
  if (!call) {
    console.log('  FAIL  no GetVenueSessions response captured');
    failures++;
    continue;
  }

  const cells = grid(JSON.parse(call.body), OPTS);
  const byCourt = {};
  for (const c of cells) (byCourt[c.court] ||= []).push(c.status);

  const expected = EXPECTED[date];
  if (expected === 'all-not-open') {
    for (const [court, statuses] of Object.entries(byCourt)) {
      check(`${court} all not-open`, statuses, statuses.map(() => 'not-open'));
    }
  } else if (expected) {
    for (const [court, want] of Object.entries(expected)) {
      check(court, byCourt[court], want);
    }
    check('court 3 excluded', Object.keys(byCourt).includes('Court 3'), false);
  }

  for (const run of merge(cells)) {
    console.log(`        ${run.court.padEnd(8)} ${run.label}  ${run.status.padEnd(9)} ${run.detail}`);
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
