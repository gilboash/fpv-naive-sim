/**
 * Three tabs: fly, set up, read instruments.
 *
 * Plain buttons toggling `hidden`, no router and no framework, matching the
 * rest of the project. Two things this has to get right:
 *
 *   The physics must not care. It runs on the worker ticker rather than
 *   requestAnimationFrame, so a hidden tab keeps flying — which is correct: a
 *   pilot who ducks into Settings mid-flight should not have the quad freeze
 *   and drop.
 *
 *   Rendering must care. Two WebGL contexts drawing frames nobody can see is
 *   pure waste, so `visible()` gates them.
 */

const STORAGE_KEY = 'fpvsim.tab.v1';

export type TabId = 'fly' | 'settings' | 'instruments';
const TABS: TabId[] = ['fly', 'settings', 'instruments'];

export class Tabs {
  private active: TabId = 'fly';
  private buttons = new Map<TabId, HTMLButtonElement>();
  private panels = new Map<TabId, HTMLElement>();
  onChange: ((id: TabId) => void) | null = null;

  constructor() {
    for (const id of TABS) {
      const btn = document.getElementById(`tab-${id}`) as HTMLButtonElement | null;
      const panel = document.getElementById(`panel-${id}`);
      if (!btn || !panel) continue;
      this.buttons.set(id, btn);
      this.panels.set(id, panel);
      btn.onclick = () => this.show(id);
    }

    let initial: TabId = 'fly';
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && (TABS as string[]).includes(saved)) initial = saved as TabId;
    } catch {
      // Private mode: the default is fine.
    }
    this.show(initial);
  }

  get current(): TabId {
    return this.active;
  }

  visible(id: TabId): boolean {
    return this.active === id;
  }

  show(id: TabId): void {
    this.active = id;
    for (const [tab, panel] of this.panels) {
      const on = tab === id;
      panel.hidden = !on;
      const btn = this.buttons.get(tab);
      if (btn) {
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      }
    }
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* not worth failing over */
    }
    this.onChange?.(id);
  }
}
