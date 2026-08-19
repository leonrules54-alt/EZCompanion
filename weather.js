/* === Wolf Weather — real forecast via Open-Meteo (free, no key) ===
   Shared by the planner popup (app.html) and the Info window (info.html).
   Geolocates by IP (ipwho.is) once, then fetches the current forecast +
   today's high/low. Location and the forecast are cached in localStorage so
   both windows share one fetch and the card still works offline (last known
   good). Loaded as a classic <script> — sets window.WolfWeather.get(). */
(function () {
  'use strict';
  const LOC_KEY = 'wolf-location';
  const WX_KEY = 'wolf-weather';
  const TTL = 10 * 60 * 1000;     // refresh the forecast at most every 10 min
  const LOC_TTL = 7 * 86400000;   // re-geolocate at most once a week

  // WMO weather code → { icon, label }
  function wxFromCode(code) {
    if (code == null) return { icon: '🌡️', label: '—' };
    if (code === 0) return { icon: '☀️', label: 'Sunny' };
    if (code === 1) return { icon: '🌤️', label: 'Mostly sunny' };
    if (code === 2) return { icon: '⛅', label: 'Partly cloudy' };
    if (code === 3) return { icon: '☁️', label: 'Overcast' };
    if (code === 45 || code === 48) return { icon: '🌫️', label: 'Foggy' };
    if (code >= 51 && code <= 57) return { icon: '🌦️', label: 'Drizzle' };
    if (code >= 61 && code <= 67) return { icon: '🌧️', label: 'Rain' };
    if (code >= 71 && code <= 77) return { icon: '🌨️', label: 'Snow' };
    if (code >= 80 && code <= 82) return { icon: '🌧️', label: 'Showers' };
    if (code === 85 || code === 86) return { icon: '🌨️', label: 'Snow showers' };
    if (code >= 95) return { icon: '⛈️', label: 'Thunderstorm' };
    return { icon: '🌡️', label: 'Weather' };
  }

  function cached(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function cache(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  async function locate() {
    const saved = cached(LOC_KEY);
    if (saved && saved.lat != null && Date.now() - (saved.t || 0) < LOC_TTL) return saved;
    try {
      const res = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const j = await res.json();
        if (j && j.success !== false && typeof j.latitude === 'number' && typeof j.longitude === 'number') {
          const loc = { lat: j.latitude, lon: j.longitude, city: j.city || '', country: j.country_code || '', t: Date.now() };
          cache(LOC_KEY, loc);
          return loc;
        }
      }
    } catch (e) { /* fall through to a sensible default */ }
    return { lat: 40.71, lon: -74.0, city: 'New York', country: 'US', t: Date.now() };
  }

  function format(data, loc) {
    const cur = data.current || {};
    const daily = data.daily || {};
    const w = wxFromCode(cur.weather_code);
    return {
      ok: true,
      icon: w.icon,
      temp: cur.temperature_2m != null ? Math.round(cur.temperature_2m) + '°F' : '',
      desc: w.label,
      city: loc.city || '',
      hi: daily.temperature_2m_max && daily.temperature_2m_max[0] != null ? Math.round(daily.temperature_2m_max[0]) : null,
      lo: daily.temperature_2m_min && daily.temperature_2m_min[0] != null ? Math.round(daily.temperature_2m_min[0]) : null,
      feels: cur.apparent_temperature != null ? Math.round(cur.apparent_temperature) : null,
      humidity: cur.relative_humidity_2m != null ? Math.round(cur.relative_humidity_2m) : null,
      wind: cur.wind_speed_10m != null ? Math.round(cur.wind_speed_10m) : null,
    };
  }

  async function fetchFresh() {
    const loc = await locate();
    const q = new URLSearchParams({
      latitude: loc.lat,
      longitude: loc.lon,
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min,weather_code',
      temperature_unit: 'fahrenheit',
      timezone: 'auto',
      forecast_days: '1',
    });
    const res = await fetch('https://api.open-meteo.com/v1/forecast?' + q.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('weather HTTP ' + res.status);
    const data = await res.json();
    const out = format(data, loc);
    out.t = Date.now();
    cache(WX_KEY, out);
    return out;
  }

  async function get(force) {
    const saved = cached(WX_KEY);
    if (!force && saved && saved.ok && Date.now() - (saved.t || 0) < TTL) return saved;
    try {
      return await fetchFresh();
    } catch (e) {
      if (saved) { saved.stale = true; return saved; } // last known good
      return { ok: false, icon: '—', temp: '', desc: 'Weather unavailable', city: '' };
    }
  }

  window.WolfWeather = { get };
})();
