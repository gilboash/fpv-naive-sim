/**
 * Put every stored setting back to its default.
 *
 * Discovers the keys by prefix rather than listing them.
 *
 * A hard-coded list is the obvious way to write this and it is wrong: the next
 * feature that persists something gets a key, nobody remembers to add it here,
 * and "reset all" quietly stops meaning all. The prefix is the contract — every
 * key this application owns begins `fpvsim.` — and a check asserts that nothing
 * outside the prefix is stored.
 *
 * It reloads rather than trying to rebuild the UI in place. Every panel reads
 * its state once, in its constructor, so a live reset would mean each of them
 * growing a re-read path that exists for this button alone and is exercised by
 * nothing else. A reload is one line and cannot be subtly incomplete.
 */

const PREFIX = 'fpvsim.';

export function storedKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k);
    }
  } catch {
    // Private mode: nothing is stored, so there is nothing to clear.
  }
  return out.sort();
}

/** Clears everything and returns what was removed. */
export function clearStored(): string[] {
  const keys = storedKeys();
  try {
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* nothing worth failing over */
  }
  return keys;
}

/** What each key holds, for a confirmation a pilot can actually read. */
const LABELS: Record<string, string> = {
  'fpvsim.mappings.v1': 'channel mapping and calibration, for every radio',
  'fpvsim.tune.v1': 'rates, PIDs and filters',
  'fpvsim.scene.v1': 'FOV, camera tilt, map and reset mode',
  'fpvsim.tab.v1': 'which tab was open',
};

export function describeStored(): string[] {
  return storedKeys().map((k) => LABELS[k] ?? k);
}
