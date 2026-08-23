/**
 * Pure parsing / classification for the ClubSpark GetVenueSessions payload.
 * No network, no filesystem — so it can be tested against saved fixtures.
 *
 * What the payload actually looks like (confirmed from a live capture):
 *
 *   Category 0     "Non DLS (Winter) 2026"  the normal bookable base session
 *                                            (Cost 10.50, Capacity 4, Interval 30)
 *   Category 1000  "Booking"                someone already has this slot
 *   Category 1000  "Not Open Yet"           released later; Recurrence is true
 *   Category 8000  "Closed"                 venue closed
 *
 * The 09:30-11:30 Sunday sessions are Category 1000 overlays sitting on top of
 * the day. When one is released it stops being a "Not Open Yet" overlay — either
 * a bookable session appears in its place, or the overlay simply disappears.
 * Both of those count as news.
 */

const CAT = { BOOKABLE: 0, OVERLAY: 1000, CLOSED: 8000 };

/** Ranked most to least restrictive — the winner for a cell covered by several. */
const RANK = ['closed', 'not-open', 'booked', 'bookable', 'unblocked'];

const NOT_OPEN_RE = /not\s*open\s*yet/i;

/** Statuses that mean "Rob could act on this right now". */
const ACTIONABLE = new Set(['bookable', 'unblocked']);

function minutesToHHMM(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function classify(session) {
  const name = String(session.Name || '');
  if (session.Category === CAT.CLOSED) return 'closed';
  if (session.Category === CAT.OVERLAY) {
    // Name and Recurrence agree in every sample seen; either alone is enough.
    if (NOT_OPEN_RE.test(name) || session.Recurrence === true) return 'not-open';
    return 'booked';
  }
  if (session.Category === CAT.BOOKABLE) return 'bookable';
  return 'booked'; // unknown overlay type — assume it blocks, don't cry wolf
}

/** YYYY-MM-DD out of "2026-08-30T00:00:00". */
function dayDate(day) {
  return String(day.Date || '').slice(0, 10);
}

/**
 * Build a per-court, per-cell status grid for one date.
 * Returns [{ court, date, start, end, label, status, detail }] at cell resolution.
 */
function grid(payload, opts) {
  const { courts, startMin, endMin } = opts;
  const cellSize = payload.MinimumInterval || 30;
  const out = [];

  for (const resource of payload.Resources || []) {
    const court = String(resource.Name || '').trim();
    const courtNumber = (court.match(/(\d+)/) || [])[1];
    if (courts.length && !courts.includes(courtNumber)) continue;

    for (const day of resource.Days || []) {
      const date = dayDate(day);
      const sessions = day.Sessions || [];

      for (let t = startMin; t < endMin; t += cellSize) {
        const covering = sessions.filter((s) => s.StartTime < t + cellSize && s.EndTime > t);
        let status = 'unblocked';
        let detail = 'nothing covers this slot';

        for (const s of covering) {
          const c = classify(s);
          if (RANK.indexOf(c) < RANK.indexOf(status)) {
            status = c;
            detail = s.Name || `category ${s.Category}`;
            if (s.Cost != null) detail += ` ($${s.Cost})`;
          }
        }

        out.push({
          court,
          courtNumber,
          date,
          start: t,
          end: t + cellSize,
          label: `${minutesToHHMM(t)}-${minutesToHHMM(t + cellSize)}`,
          status,
          detail,
        });
      }
    }
  }
  return out;
}

/** Collapse adjacent cells with the same status, for readable output. */
function merge(cells) {
  const sorted = [...cells].sort(
    (a, b) => a.date.localeCompare(b.date) || a.court.localeCompare(b.court) || a.start - b.start
  );
  const runs = [];
  for (const c of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.date === c.date && last.court === c.court && last.status === c.status && last.end === c.start) {
      last.end = c.end;
      last.label = `${minutesToHHMM(last.start)}-${minutesToHHMM(last.end)}`;
    } else {
      runs.push({ ...c });
    }
  }
  return runs;
}

/** Stable identity for a cell, used as the key in state.json. */
function cellKey(cell) {
  return `${cell.date}|${cell.court}|${minutesToHHMM(cell.start)}`;
}

/** How many days ahead a date is, from a YYYY-MM-DD "today". */
function daysAhead(todayISO, dateISO) {
  const a = Date.parse(`${todayISO}T00:00:00Z`);
  const b = Date.parse(`${dateISO}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

module.exports = {
  CAT,
  ACTIONABLE,
  classify,
  grid,
  merge,
  cellKey,
  daysAhead,
  minutesToHHMM,
};
