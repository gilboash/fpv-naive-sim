/**
 * Copy the whole state of a FlightSim or a Race out, and back into another one.
 *
 * Generic on purpose: it walks every own field (numbers, booleans, strings,
 * arrays, typed arrays, nested objects such as motors, filters and the PID
 * controller) rather than listing them, so a field added to the model later is
 * covered without touching this file. The replay check in tools/flight-check.ts
 * is what proves nothing is missed: a sim restored from a snapshot must fly on
 * bit-identically to the one it was taken from.
 *
 * Skipped: functions, and the fields in SKIP, which are references to scenery
 * the replay supplies itself (the obstacle list, the race course).
 *
 * Pure TypeScript with no DOM, like src/flight, so it runs under plain Node.
 */

const SKIP = new Set(['obstacles', 'course']);

export type Snapshot = Record<string, unknown>;

function clone(v: unknown, seen: Set<object>): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) return (v as unknown as Float64Array).slice();
  if (seen.has(v)) throw new Error('snapshot: the state has a cycle, which this copier does not handle');
  seen.add(v);
  let out: unknown;
  if (Array.isArray(v)) out = v.map((x) => clone(x, seen));
  else {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      if (SKIP.has(k)) continue;
      const x = (v as Record<string, unknown>)[k];
      if (typeof x === 'function') continue;
      o[k] = clone(x, seen);
    }
    out = o;
  }
  seen.delete(v);
  return out;
}

/** A deep, plain copy of an object's state. */
export function snapshot(obj: object): Snapshot {
  return clone(obj, new Set()) as Snapshot;
}

/** Write a snapshot back into a live object, in place, keeping its class instances. */
export function restore(target: object, snap: Snapshot): void {
  const t = target as Record<string, unknown>;
  for (const k of Object.keys(snap)) {
    const s = snap[k];
    const cur = t[k];
    if (s === null || typeof s !== 'object') {
      t[k] = s;
    } else if (ArrayBuffer.isView(s)) {
      const src = s as unknown as Float64Array;
      if (cur && ArrayBuffer.isView(cur) && (cur as unknown as Float64Array).length === src.length) {
        (cur as unknown as Float64Array).set(src);
      } else t[k] = src.slice();
    } else if (Array.isArray(s)) {
      if (Array.isArray(cur)) restoreArray(cur, s);
      else t[k] = clone(s, new Set());
    } else if (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
      restore(cur, s as Snapshot);
    } else {
      t[k] = clone(s, new Set());
    }
  }
}

function restoreArray(cur: unknown[], s: unknown[]): void {
  cur.length = s.length;
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    const c = cur[i];
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && c !== null && typeof c === 'object' && !Array.isArray(c)) {
      restore(c, v as Snapshot);
    } else if (Array.isArray(v) && Array.isArray(c)) {
      restoreArray(c, v);
    } else {
      cur[i] = clone(v, new Set());
    }
  }
}

/**
 * Where two snapshots first differ, or null when they are identical to the bit
 * (Object.is, so -0 and NaN count). For the determinism checks.
 */
export function firstDifference(a: unknown, b: unknown, path = ''): string | null {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return Object.is(a, b) ? null : `${path || '(root)'}: ${String(a)} vs ${String(b)}`;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b) || Array.isArray(a) || Array.isArray(b)) {
    const x = a as ArrayLike<unknown>;
    const y = b as ArrayLike<unknown>;
    if (x.length !== y.length) return `${path}: length ${x.length} vs ${y.length}`;
    for (let i = 0; i < x.length; i++) {
      const d = firstDifference(x[i], y[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  for (const k of new Set([...ka, ...kb])) {
    const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}
