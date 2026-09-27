// Reads track info from Spotify's public track pages (no API key needed).
const UA = 'facebookexternalhit/1.1'; // link-preview bots get the page with og: tags

const TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/;
const cache = new Map();

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function metaTag(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

// Accepts spotify:track:ID or an open.spotify.com/track/ID link.
function toTrackUri(input) {
  input = String(input || '').trim();
  if (TRACK_URI.test(input)) return input;
  const m = input.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/);
  return m ? `spotify:track:${m[1]}` : null;
}

// og:description on a track page looks like "Artist · Album · Song · Year".
async function trackMeta(uri) {
  if (cache.has(uri)) return cache.get(uri);
  const id = uri.split(':')[2];
  let meta = { name: 'Unknown track', artist: '', image: null, duration: null };
  try {
    const res = await fetch(`https://open.spotify.com/track/${id}`, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const html = await res.text();
      const desc = metaTag(html, 'og:description');
      const duration = Number(metaTag(html, 'music:duration'));
      meta = {
        name: metaTag(html, 'og:title') || meta.name,
        artist: desc ? desc.split(' · ')[0] : '',
        image: metaTag(html, 'og:image'),
        duration: duration > 0 ? duration : null,
      };
      cache.set(uri, meta);
    }
  } catch {}
  return meta;
}

module.exports = { toTrackUri, trackMeta, TRACK_URI };
