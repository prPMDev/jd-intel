export { fetchGreenhouse, hasGreenhouse } from './greenhouse.js';
export { fetchLever, hasLever } from './lever.js';
export { fetchAshby, hasAshby } from './ashby.js';

export const ADAPTERS = {
  greenhouse: { fetch: (...args) => import('./greenhouse.js').then(m => m.fetchGreenhouse(...args)), has: (...args) => import('./greenhouse.js').then(m => m.hasGreenhouse(...args)) },
  lever: { fetch: (...args) => import('./lever.js').then(m => m.fetchLever(...args)), has: (...args) => import('./lever.js').then(m => m.hasLever(...args)) },
  ashby: { fetch: (...args) => import('./ashby.js').then(m => m.fetchAshby(...args)), has: (...args) => import('./ashby.js').then(m => m.hasAshby(...args)) },
};

export const ATS_NAMES = Object.keys(ADAPTERS);
