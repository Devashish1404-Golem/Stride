// Route helpers: Google/Strava polyline decoding, SVG outlines, GPX generation.

export function decodePolyline(str) {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

export const routePoints = (run) => (run.route?.length > 1 ? run.route : run.polyline ? decodePolyline(run.polyline) : null);

// Strava-style outline: equirectangular projection scaled to fit the box.
export function routeSvg(run, { w = 120, h = 90, cls = 'route' } = {}) {
  const pts = routePoints(run);
  if (!pts || pts.length < 2) return '';
  const k = Math.cos((pts.reduce((a, p) => a + p[0], 0) / pts.length) * Math.PI / 180);
  const xs = pts.map((p) => p[1] * k), ys = pts.map((p) => -p[0]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 6, sc = Math.min((w - pad * 2) / (maxX - minX || 1e-9), (h - pad * 2) / (maxY - minY || 1e-9));
  const ox = (w - (maxX - minX) * sc) / 2, oy = (h - (maxY - minY) * sc) / 2;
  const step = Math.max(1, Math.floor(pts.length / 400));
  const idx = [];
  for (let i = 0; i < xs.length; i += step) idx.push(i);
  if (idx.at(-1) !== xs.length - 1) idx.push(xs.length - 1);
  const d = idx.map((i, j) => `${j ? 'L' : 'M'}${(ox + (xs[i] - minX) * sc).toFixed(1)},${(oy + (ys[i] - minY) * sc).toFixed(1)}`).join('');
  const [sx, sy] = [ox + (xs[0] - minX) * sc, oy + (ys[0] - minY) * sc];
  const [ex, ey] = [ox + (xs.at(-1) - minX) * sc, oy + (ys.at(-1) - minY) * sc];
  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" aria-label="Route outline"><path d="${d}"/><circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="3" class="start"/><circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3" class="end"/></svg>`;
}

// GPX for uploading to Strava. Points without timestamps are spread evenly over the run.
export function toGpx(run) {
  const pts = run.route || [];
  const t0 = Date.parse(run.startTime || `${run.date}T07:00:00`);
  const n = pts.length;
  const trkpts = pts.map((p, i) => {
    const off = p[2] != null ? p[2] : (run.durSec * i) / Math.max(1, n - 1);
    return `<trkpt lat="${p[0]}" lon="${p[1]}"><time>${new Date(t0 + off * 1000).toISOString()}</time></trkpt>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Stride" xmlns="http://www.topografix.com/GPX/1/1"><metadata><time>${new Date(t0).toISOString()}</time></metadata>
<trk><name>${(run.name || 'Run').replace(/[<&]/g, '')}</name><type>running</type><trkseg>${trkpts}</trkseg></trk></gpx>`;
}
