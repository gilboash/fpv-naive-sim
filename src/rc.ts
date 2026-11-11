/**
 * The NacoSim-for-your-radio page. Static text; this only brings in the site's
 * stylesheet and the brand logo so it looks like the rest of the site.
 */
import './style.css';
import brandLogo from './assets/breaking-carbon.jpg';

const logo = document.getElementById('brand-logo');
if (logo instanceof HTMLImageElement) logo.src = brandLogo;
