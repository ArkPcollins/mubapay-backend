'use strict';
/**
 * Minimal 5-field cron evaluator (minute hour day-of-month month day-of-week)
 * supporting "*", "*\/n", "a-b", "a,b,c" and numbers. Evaluated in Africa/Lagos
 * time (UTC+1, no daylight saving). Used by the Redis-free scheduler; BullMQ
 * evaluates cron patterns natively in the Redis variant.
 */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

function parseField(field, min, max) {
  const out = new Set();
  for (const part of field.split(',')) {
    let [range, step] = part.split('/');
    step = step ? parseInt(step, 10) : 1;
    let lo;
    let hi;
    if (range === '*') [lo, hi] = [min, max];
    else if (range.includes('-')) [lo, hi] = range.split('-').map((n) => parseInt(n, 10));
    else {
      lo = parseInt(range, 10);
      hi = step > 1 ? max : lo;
    }
    if ([lo, hi, step].some((n) => Number.isNaN(n)) || lo < min || hi > max) throw new Error(`Invalid cron field "${field}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function parse(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`Cron expression must have 5 fields: "${expr}"`);
  return { minute: parseField(f[0], 0, 59), hour: parseField(f[1], 0, 23), dom: parseField(f[2], 1, 31), month: parseField(f[3], 1, 12), dow: parseField(f[4], 0, 6), domAny: f[2] === '*', dowAny: f[4] === '*' };
}

/** Next run strictly after `from` (Date). */
function next(expr, from = new Date()) {
  const c = typeof expr === 'string' ? parse(expr) : expr;
  const t = new Date(Math.floor((from.getTime() + LAGOS_OFFSET_MS) / 60000) * 60000 + 60000); // lagos-shifted, next minute
  for (let i = 0; i < 60 * 24 * 400; i++) {
    const m = t.getUTCMonth() + 1;
    const dom = t.getUTCDate();
    const dow = t.getUTCDay();
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? c.dow.has(dow) : c.dowAny ? c.dom.has(dom) : c.dom.has(dom) || c.dow.has(dow);
    if (c.month.has(m) && dayOk && c.hour.has(t.getUTCHours()) && c.minute.has(t.getUTCMinutes())) {
      return new Date(t.getTime() - LAGOS_OFFSET_MS);
    }
    t.setTime(t.getTime() + 60000);
  }
  throw new Error(`No next run found for cron "${expr}"`);
}

module.exports = { parse, next };
