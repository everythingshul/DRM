// utils/hebcal.js — Hebrew calendar dates via Hebcal's public REST API
// https://www.hebcal.com/home/197/jewish-calendar-rest-api
// https://www.hebcal.com/home/1663/hebrew-date-converter-rest-api
//
// Used for: (1) advancing "recurring on Hebrew day N of every month" schedules,
// (2) listing Rosh Chodesh / Erev Rosh Chodesh dates in Settings.
// All date math here works on 'YYYY-MM-DD' strings only (never Date objects
// or timezone-sensitive parsing) to avoid off-by-one-day bugs across server TZs.
'use strict';

const BASE = 'https://www.hebcal.com';

// Hebrew month order for calendar-year progression (Tishrei -> Elul), matching
// Hebcal's `hm` names. Used as a fast path; nextHebrewMonth() falls back to
// probing the live API if a name here doesn't match what Hebcal returns.
const MONTHS_REGULAR = ['Tishrei','Cheshvan','Kislev','Tevet','Shevat','Adar','Nisan','Iyyar','Sivan','Tammuz','Av','Elul'];
const MONTHS_LEAP    = ['Tishrei','Cheshvan','Kislev','Tevet','Shevat','Adar I','Adar II','Nisan','Iyyar','Sivan','Tammuz','Av','Elul'];

// Metonic-cycle leap year rule for the Hebrew calendar
function isLeapYear(hy) {
  return (7 * hy + 1) % 19 < 7;
}

function monthOrder(hy) {
  return isLeapYear(hy) ? MONTHS_LEAP : MONTHS_REGULAR;
}

function _ymd(dateInput) {
  const s = typeof dateInput === 'string' ? dateInput : dateInput.toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) throw new Error(`Unrecognized date: ${s}`);
  return { y: parseInt(m[1], 10), m: parseInt(m[2], 10), d: parseInt(m[3], 10) };
}

function _addDays(dateStr, n) {
  const { y, m, d } = _ymd(dateStr);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

function _diffDays(aStr, bStr) {
  const a = _ymd(aStr), b = _ymd(bStr);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hebcal request failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.error) throw new Error(`Hebcal error: ${data.error}`);
  return data;
}

// 'YYYY-MM-DD' (or any string/Date starting with one) -> { hy, hm, hd }
async function gregorianToHebrew(dateInput) {
  const { y, m, d } = _ymd(dateInput);
  const r = await fetchJson(`${BASE}/converter?cfg=json&g2h=1&gy=${y}&gm=${m}&gd=${d}`);
  return { hy: r.hy, hm: r.hm, hd: r.hd };
}

// { hy, hm, hd } -> 'YYYY-MM-DD' (Gregorian)
async function hebrewToGregorian(hy, hm, hd) {
  const r = await fetchJson(`${BASE}/converter?cfg=json&h2g=1&hy=${hy}&hm=${encodeURIComponent(hm)}&hd=${hd}`);
  return `${String(r.gy).padStart(4, '0')}-${String(r.gm).padStart(2, '0')}-${String(r.gd).padStart(2, '0')}`;
}

// Advance { hy, hm } to the next Hebrew month, rolling the year over after Elul.
// `anchorGregorianDate` (the Gregorian date that produced hy/hm) is only used as a
// fallback probe start if `hm` doesn't match our hardcoded month table.
async function nextHebrewMonth(hy, hm, anchorGregorianDate) {
  const order = monthOrder(hy);
  const idx = order.indexOf(hm);
  if (idx !== -1) {
    if (idx === order.length - 1) return { hy: hy + 1, hm: monthOrder(hy + 1)[0] }; // Elul -> Tishrei
    return { hy, hm: order[idx + 1] };
  }
  if (!anchorGregorianDate) throw new Error(`Unrecognized Hebrew month "${hm}"`);
  // Table mismatch (unexpected API spelling) — probe forward day-by-day until
  // the Hebrew month actually changes, so this stays correct either way.
  let probe = _addDays(anchorGregorianDate, 20);
  let cur = await gregorianToHebrew(probe);
  while (cur.hy === hy && cur.hm === hm) {
    probe = _addDays(probe, 1);
    cur = await gregorianToHebrew(probe);
  }
  return { hy: cur.hy, hm: cur.hm };
}

// Number of days in a given Hebrew month (29 or 30), derived from two conversions
// rather than a hard-coded table, so it stays correct for every leap/non-leap year.
async function daysInHebrewMonth(hy, hm, anchorGregorianDate) {
  const first = await hebrewToGregorian(hy, hm, 1);
  const next = await nextHebrewMonth(hy, hm, anchorGregorianDate || first);
  const firstOfNext = await hebrewToGregorian(next.hy, next.hm, 1);
  return _diffDays(first, firstOfNext);
}

// Given a Gregorian anchor date, return the Gregorian date of `hebrewDay` in the
// Hebrew month AFTER the anchor's Hebrew month. Days that don't exist in a 29-day
// month are clamped to the month's last day (same rule Gregorian "monthly on the
// 31st" uses for short months).
async function advanceToNextHebrewMonthDate(anchorDate, hebrewDay) {
  const { hy, hm } = await gregorianToHebrew(anchorDate);
  const next = await nextHebrewMonth(hy, hm, anchorDate);
  const len = await daysInHebrewMonth(next.hy, next.hm, anchorDate);
  return hebrewToGregorian(next.hy, next.hm, Math.min(hebrewDay, len));
}

// Given a Gregorian start date and a target Hebrew day-of-month, return the
// Gregorian date of the FIRST occurrence of that Hebrew day on or after start —
// this month if the day hasn't passed yet, otherwise next month.
async function firstHebrewMonthlyRun(startDate, hebrewDay) {
  const { hy, hm, hd } = await gregorianToHebrew(startDate);
  const lenThisMonth = await daysInHebrewMonth(hy, hm, startDate);
  const clampedDay = Math.min(hebrewDay, lenThisMonth);
  if (hd <= clampedDay) return hebrewToGregorian(hy, hm, clampedDay);
  return advanceToNextHebrewMonthDate(startDate, hebrewDay);
}

// ── Rosh Chodesh / Erev Rosh Chodesh listing ────────────────────────────────────
let _rcCache = null; // { key, expiresAt, data }

async function getRoshChodeshList({ start, end }) {
  const key = `${start}|${end}`;
  if (_rcCache && _rcCache.key === key && _rcCache.expiresAt > Date.now()) return _rcCache.data;

  const url = `${BASE}/hebcal?cfg=json&v=1&start=${start}&end=${end}` +
    `&maj=off&min=off&mod=off&nx=on&mf=off&ss=off&c=off&geo=none`;
  const r = await fetchJson(url);
  const items = (r.items || []).filter(i => i.category === 'roshchodesh');
  items.sort((a, b) => a.date.localeCompare(b.date));

  // Group consecutive-day items that share a title into one Rosh Chodesh event —
  // a 30-day outgoing Hebrew month makes Rosh Chodesh a 2-day observance.
  const grouped = [];
  for (const item of items) {
    const day = item.date.slice(0, 10);
    const last = grouped[grouped.length - 1];
    if (last && last.title === item.title && _addDays(last.lastDate, 1) === day) {
      last.lastDate = day;
      last.days = 2;
    } else {
      grouped.push({ title: item.title, hebrew: item.hebrew || '', firstDate: day, lastDate: day, days: 1 });
    }
  }

  const data = grouped.map(g => ({
    month: g.title.replace(/^Rosh Chodesh\s+/, ''),
    title: g.title,
    hebrew: g.hebrew,
    days: g.days,
    roshChodeshStart: g.firstDate,
    roshChodeshEnd: g.lastDate,
    erevRoshChodesh: _addDays(g.firstDate, -1)
  }));

  _rcCache = { key, expiresAt: Date.now() + 24 * 60 * 60 * 1000, data };
  return data;
}

module.exports = {
  isLeapYear, monthOrder,
  gregorianToHebrew, hebrewToGregorian, nextHebrewMonth, daysInHebrewMonth,
  advanceToNextHebrewMonthDate, firstHebrewMonthlyRun,
  getRoshChodeshList
};
