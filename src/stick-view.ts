/**
 * The two sticks, drawn over the corner of the FPV view.
 *
 * SVG in the DOM rather than in the GL scene: it is a 30 Hz overlay of four
 * numbers and has no business in the render path.
 *
 * Which stick carries which channel follows the pilot's configured stick mode.
 * Hard-coding mode 2 would quietly lie to anyone on 1, 3 or 4 — and this
 * project already knows its mode presets are unreliable, so the display has to
 * read the setting rather than assume the common case.
 */

import type { Commands } from './mapping.ts';
import type { StickMode } from './mapping.ts';

const NS = 'http://www.w3.org/2000/svg';

/**
 * Which channel sits on which physical stick axis, per mode.
 * Each entry is [horizontal, vertical] for [left, right].
 */
const STICK_LAYOUT: Record<StickMode, { left: [keyof Commands, keyof Commands]; right: [keyof Commands, keyof Commands] }> = {
  1: { left: ['yaw', 'pitch'], right: ['roll', 'throttle'] },
  2: { left: ['yaw', 'throttle'], right: ['roll', 'pitch'] },
  3: { left: ['roll', 'pitch'], right: ['yaw', 'throttle'] },
  4: { left: ['roll', 'throttle'], right: ['yaw', 'pitch'] },
};

interface Gimbal {
  dot: SVGCircleElement;
  h: keyof Commands;
  v: keyof Commands;
}

export class StickView {
  readonly root: SVGSVGElement;
  private left: Gimbal;
  private right: Gimbal;

  constructor(parent: HTMLElement) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 108 52');
    svg.setAttribute('class', 'stick-view');
    this.root = svg;

    const make = (cx: number): Gimbal => {
      const box = document.createElementNS(NS, 'rect');
      box.setAttribute('x', String(cx - 24));
      box.setAttribute('y', '2');
      box.setAttribute('width', '48');
      box.setAttribute('height', '48');
      box.setAttribute('rx', '6');
      box.setAttribute('class', 'stick-box');
      svg.appendChild(box);
      for (const d of [
        `M${cx - 24} 26 H${cx + 24}`,
        `M${cx} 2 V50`,
      ]) {
        const line = document.createElementNS(NS, 'path');
        line.setAttribute('d', d);
        line.setAttribute('class', 'stick-cross');
        svg.appendChild(line);
      }
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('r', '4.5');
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', '26');
      dot.setAttribute('class', 'stick-dot');
      svg.appendChild(dot);
      return { dot, h: 'yaw', v: 'throttle' };
    };

    this.left = make(26);
    this.right = make(82);
    this.setMode(2);
    parent.appendChild(svg);
  }

  setMode(mode: StickMode): void {
    const layout = STICK_LAYOUT[mode] ?? STICK_LAYOUT[2];
    [this.left.h, this.left.v] = layout.left;
    [this.right.h, this.right.v] = layout.right;
  }

  update(cmd: Commands): void {
    for (const [g, cx] of [
      [this.left, 26],
      [this.right, 82],
    ] as [Gimbal, number][]) {
      const h = cmd[g.h] ?? 0;
      const raw = cmd[g.v] ?? 0;
      // Throttle is unipolar: it rests at the bottom of the gimbal, not the
      // centre, which is where a pilot's eye expects to find it.
      const v = g.v === 'throttle' ? raw * 2 - 1 : raw;
      g.dot.setAttribute('cx', String(cx + Math.max(-1, Math.min(1, h)) * 20));
      g.dot.setAttribute('cy', String(26 - Math.max(-1, Math.min(1, v)) * 20));
    }
  }
}
