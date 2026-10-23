// Display units (km or miles). Everything is stored in km and sec/km; only display converts.

import { state } from './store.js';
import { fmtPace, fmtKm } from './util.js';

export const KM_PER_MI = 1.609344;
export const isMi = () => state.settings?.units === 'mi';
export const distUnit = () => (isMi() ? 'mi' : 'km');
export const paceUnit = () => (isMi() ? '/mi' : '/km');
export const toUnit = (km) => (isMi() ? km / KM_PER_MI : km);
export const unitMetres = () => (isMi() ? 1609.344 : 1000);

export const fmtD = (km) => `${fmtKm(toUnit(km))} ${distUnit()}`;
export const fmtP = (secPerKm) => fmtPace(isMi() ? secPerKm * KM_PER_MI : secPerKm);
// plan text like "12 km easy" or "the last 6 km" → miles when needed
export const uText = (str) => (isMi() ? String(str).replace(/(\d+(?:\.\d+)?)\s?km\b/g, (_, n) => `${+(n / KM_PER_MI).toFixed(1)} mi`) : str);
