// ── Rose Tinsley Consulting · Map Demo Service Worker ────────────────────────
// Strategy:
//   Static assets & GeoJSON  → Cache First  (data doesn't change between demos)
//   CartoDB map tiles         → Cache First  (up to TILE_MAX entries, then LRU evict)
//   Everything else           → Network First with cache fallback

const STATIC_CACHE  = 'rtc-map-static-v1';
const TILE_CACHE    = 'rtc-map-tiles-v1';
const TILE_MAX      = 600;   // ~50 MB worth of tiles at typical tile sizes

// All static assets to pre-cache on install
const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    // Leaflet
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    // Leaflet.Draw
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.css',
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.js',
    // Turf
    'https://unpkg.com/@turf/turf@6/turf.min.js',
    // GeoJSON data layers
    './ancient_woodland_esx.geojson',
    './conservation_areas_esx.geojson',
    './listed_buildings_esx.geojson',
    './sssi_esx.geojson',
    './essex_boundaries.geojson',
    './osm_roads.geojson',
];

// ── Install: pre-cache all static assets ─────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(STATIC_CACHE).then(cache => {
            // Cache assets individually so one failure doesn't block everything
            return Promise.allSettled(
                STATIC_ASSETS.map(url =>
                    cache.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err))
                )
            );
        }).then(() => self.skipWaiting())
    );
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
    const keep = [STATIC_CACHE, TILE_CACHE];
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => !keep.includes(k)).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // 1. CartoDB / OpenStreetMap tile requests → tile cache
    if (url.hostname.includes('basemaps.cartocdn.com') ||
        url.hostname.includes('tile.openstreetmap.org')) {
        event.respondWith(tileFirst(event.request));
        return;
    }

    // 2. Google Fonts → stale-while-revalidate (fonts cache in browser anyway)
    if (url.hostname.includes('fonts.googleapis.com') ||
        url.hostname.includes('fonts.gstatic.com')) {
        event.respondWith(staleWhileRevalidate(event.request, STATIC_CACHE));
        return;
    }

    // 3. GeoJSON data + all other static assets → cache first
    event.respondWith(cacheFirst(event.request));
});

// ── Strategies ────────────────────────────────────────────────────────────────

async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        return new Response('Offline – resource not cached', { status: 503 });
    }
}

async function tileFirst(request) {
    const cache  = await caches.open(TILE_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            // Evict oldest entries if over limit
            const keys = await cache.keys();
            if (keys.length >= TILE_MAX) {
                await cache.delete(keys[0]);
            }
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        return new Response('Tile unavailable offline', { status: 503 });
    }
}

async function staleWhileRevalidate(request, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    const fetchPromise = fetch(request).then(response => {
        if (response.ok) cache.put(request, response.clone());
        return response;
    }).catch(() => null);
    return cached || fetchPromise;
}
