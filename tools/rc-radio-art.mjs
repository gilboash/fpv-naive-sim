/**
 * Draws the radio for the front page: a generic handheld transmitter (two
 * gimbals, three keys, a roller, a small screen) with the sim's own flight
 * screen on it. The screen is not drawn here: it is lifted from
 * public/nacosim/fly-gate.svg, which lua edgetx/test/shots.lua produced from
 * the real view code, so the picture cannot drift from what the radio shows.
 *
 *   node tools/rc-radio-art.mjs        (npm run rc:shots runs it after shots.lua)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const screenSvg = readFileSync('public/nacosim/fly-gate.svg', 'utf8');
const m = /^<svg[^>]*viewBox="0 0 (\d+) (\d+)"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(screenSvg);
if (!m) throw new Error('fly-gate.svg is not in the expected shape; run lua edgetx/test/shots.lua first');
const [, sw, sh, inner] = m;

const gimbal = (cx, cy, dx, dy) => `
  <g>
    <rect x="${cx - 98}" y="${cy - 98}" width="196" height="196" rx="38" fill="#0e1318" stroke="#3a4655" stroke-width="2"/>
    <circle cx="${cx}" cy="${cy}" r="74" fill="none" stroke="#252e39" stroke-width="2"/>
    <circle cx="${cx}" cy="${cy}" r="46" fill="none" stroke="#252e39" stroke-width="2"/>
    <line x1="${cx - 74}" y1="${cy}" x2="${cx + 74}" y2="${cy}" stroke="#252e39" stroke-width="2"/>
    <line x1="${cx}" y1="${cy - 74}" x2="${cx}" y2="${cy + 74}" stroke="#252e39" stroke-width="2"/>
    <line x1="${cx}" y1="${cy}" x2="${cx + dx}" y2="${cy + dy}" stroke="#7d8795" stroke-width="9" stroke-linecap="round"/>
    <circle cx="${cx + dx}" cy="${cy + dy}" r="25" fill="#2f8fc2"/>
    <circle cx="${cx + dx}" cy="${cy + dy}" r="25" fill="none" stroke="#4fc3f7" stroke-width="3"/>
    <circle cx="${cx + dx - 6}" cy="${cy + dy - 7}" r="8" fill="#9adcf9" opacity="0.55"/>
  </g>`;

const toggle = (x) => `<rect x="${x}" y="92" width="16" height="34" rx="6" fill="#171e27" stroke="#3a4655" stroke-width="2"/><rect x="${x + 3}" y="96" width="10" height="14" rx="4" fill="#9aa4b2"/>`;
const key = (y) => `<rect x="76" y="${y}" width="62" height="22" rx="11" fill="#171e27" stroke="#3a4655" stroke-width="2"/>`;
const ridges = Array.from({ length: 9 }, (_, i) => `<line x1="540" y1="${296 + i * 9}" x2="562" y2="${296 + i * 9}" stroke="#222a34" stroke-width="2"/>`).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 470" role="img" aria-label="A handheld radio transmitter with the NacoSim flight screen on its display">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d3643"/><stop offset="1" stop-color="#181e26"/></linearGradient>
    <linearGradient id="wheel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3b4655"/><stop offset="0.5" stop-color="#8a94a3"/><stop offset="1" stop-color="#3b4655"/></linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.6"><stop offset="0" stop-color="#4fc3f7" stop-opacity="0.22"/><stop offset="1" stop-color="#4fc3f7" stop-opacity="0"/></radialGradient>
  </defs>
  <ellipse cx="320" cy="360" rx="300" ry="90" fill="url(#glow)"/>
  <rect x="452" y="4" width="24" height="86" rx="12" fill="#222a35" stroke="#3a4655" stroke-width="2"/>
  <rect x="22" y="66" width="596" height="378" rx="76" fill="url(#body)" stroke="#3f4b5b" stroke-width="3"/>
  ${toggle(118)}${toggle(196)}${toggle(426)}${toggle(504)}
  ${gimbal(152, 224, -16, 12)}
  ${gimbal(488, 224, 14, -12)}
  <rect x="204" y="286" width="232" height="134" rx="12" fill="#030609" stroke="#445063" stroke-width="2"/>
  <rect x="190" y="316" width="8" height="66" rx="4" fill="#2f8fc2"/>
  <rect x="442" y="316" width="8" height="66" rx="4" fill="#2f8fc2"/>
  <svg x="216" y="298" width="208" height="104" viewBox="0 0 ${sw} ${sh}" shape-rendering="crispEdges">${inner}</svg>
  ${key(306)}${key(340)}${key(374)}
  <rect x="534" y="288" width="34" height="96" rx="16" fill="url(#wheel)" stroke="#222a34" stroke-width="2"/>
  ${ridges}
</svg>
`;
writeFileSync('public/nacosim/radio.svg', svg);
console.log(`wrote public/nacosim/radio.svg (${svg.length} bytes), screen from fly-gate.svg ${sw}x${sh}`);
