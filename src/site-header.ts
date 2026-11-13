/**
 * The header every page shares: Breaking Carbon left of the title, Race Drones
 * hard right, and the web sim's release number wherever a page asks for it with
 * `data-web-version`. One place, so the three pages cannot drift apart.
 */
import breakingCarbon from './assets/breaking-carbon.jpg';
import raceDrones from './assets/race-drones.png';

export const WEB_VERSION = __FPVSIM_VERSION__;

export function setupSiteHeader(): void {
  const bc = document.getElementById('brand-logo');
  if (bc instanceof HTMLImageElement) bc.src = breakingCarbon;
  const rd = document.getElementById('partner-logo');
  if (rd instanceof HTMLImageElement) rd.src = raceDrones;
  for (const el of document.querySelectorAll<HTMLElement>('[data-web-version]')) {
    el.textContent = `v${WEB_VERSION}`;
  }
}
