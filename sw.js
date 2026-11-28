/* ============================================================================
 * SKOL-IF WEBBEN – OFFLINE SERVICE WORKER (Network-First)
 * Hämtar alltid färskaste versionen när internet finns, men sparar en lokal
 * reservkopia så att lektions- och föreningsverktygen fungerar även i en
 * idrottshall i källaren eller i skogen utan täckning.
 * ============================================================================ */

const CACHE_NAME = 'skolif-offline-v9';

const PRECACHE_URLS = [
    './',
    './index.html',
    './tabata.html',
    './beeptest.html',
    './lopning.html',
    './lagdelaren.html',
    './hjulet.html',
    './turnering.html',
    './kiosk.html',
    './redskapsboden.html',
    './kalender.html',
    './integritet.html',
    './om.html',
    './seo-shared.css',
    './klasser.js?v=14',
    './manifest.json',
    './icon.svg',
    './apple-touch-icon.png',
    './icon-192.png',
    './icon-512.png'
];

const BACKGROUND_AUDIO_URLS = [
    './beeptest.mp3'
];

// Domäner som alltid ska gå direkt mot nätet (Firebase, Auth, Annonser m.m.)
const BYPASS_HOSTS = [
    'firestore.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'googleapis.com',
    'googlesyndication.com',
    'doubleclick.net',
    'googleadservices.com',
    'googletagmanager.com',
    'google-analytics.com',
    'accounts.google.com',
    'apis.google.com',
    'api.qrserver.com'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            await Promise.allSettled(
                PRECACHE_URLS.map((url) =>
                    fetch(url, { cache: 'reload' }).then((res) => {
                        if (res && res.ok) {
                            return cache.put(url, res);
                        }
                    })
                )
            );
            // Cacha även beep-testets ljudfil i bakgrunden utan att blockera installationen
            BACKGROUND_AUDIO_URLS.forEach((audioUrl) => {
                fetch(audioUrl).then((res) => {
                    if (res && res.ok && res.status === 200) {
                        cache.put(audioUrl, res).catch(() => {});
                    }
                }).catch(() => {});
            });
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((oldKey) => caches.delete(oldKey))
            )
        ).then(() => self.clients.claim())
    );
});

async function serveCachedRangeResponse(req) {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (!cached) throw new Error('Offline audio miss');
    const rangeHeader = req.headers.get('range');
    if (!rangeHeader) return cached;

    const buf = await cached.arrayBuffer();
    const total = buf.byteLength;
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (!match) return cached;

    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : total - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
        return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${total}` }
        });
    }

    const sliced = buf.slice(start, end + 1);
    return new Response(sliced, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
            'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(sliced.byteLength)
        }
    });
}

function fetchWithTimeout(request, timeoutMs) {
    if (typeof AbortController === 'undefined') return fetch(request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    let url;
    try {
        url = new URL(req.url);
    } catch (e) {
        return;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    if (BYPASS_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
        return;
    }

    // Versionslåsta, oföränderliga skriptbibliotek (Firebase SDK, Chart.js, QRCode, Confetti, ExcelJS):
    // Servera blixtsnabbt ur lokal cache om den finns (skyddar mot segt källar-WiFi & ger offline-stöd!)
    const isImmutableCdnLib =
        (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) ||
        (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/')) ||
        (url.hostname === 'cdnjs.cloudflare.com' && url.pathname.startsWith('/ajax/libs/'));

    if (isImmutableCdnLib) {
        event.respondWith(
            caches.match(req).then((cachedLib) => {
                if (cachedLib) return cachedLib;
                return fetchWithTimeout(req, 4000).then((netRes) => {
                    if (netRes && (netRes.status === 200 || netRes.type === 'opaque')) {
                        const clone = netRes.clone();
                        caches.open(CACHE_NAME).then((c) => c.put(req, clone).catch(() => {}));
                    }
                    return netRes;
                });
            })
        );
        return;
    }

    // Fånga ALDRIG övriga anrop till externa domäner
    if (url.origin !== self.location.origin) return;

    // Ljudströmmar med Range-headers (t.ex. Safari/Chrome <audio src="beeptest.mp3">):
    // Gå direkt mot nätet när online, men servera 206 Partial Content ur cachen när offline!
    if (req.headers && req.headers.has('range')) {
        event.respondWith(
            fetchWithTimeout(req, 4500).catch(() => serveCachedRangeResponse(req))
        );
        // Om filen ännu inte ligger i cachen när online, spara hela filen i bakgrunden
        caches.open(CACHE_NAME).then(async (cache) => {
            const exists = await cache.match(url.pathname, { ignoreSearch: true });
            if (!exists) {
                fetch(url.pathname).then((fullRes) => {
                    if (fullRes && fullRes.ok && fullRes.status === 200) {
                        cache.put(url.pathname, fullRes).catch(() => {});
                    }
                }).catch(() => {});
            }
        }).catch(() => {});
        return;
    }

    // Network-First med 4s timeout mot "zombie-WiFi" i idrottshallar: hämta färsk version om nätet svarar, annars cachen direkt!
    event.respondWith(
        fetchWithTimeout(req, 4000)
            .then((networkRes) => {
                if (networkRes && networkRes.status === 200 && (networkRes.type === 'basic' || networkRes.type === 'cors')) {
                    const copy = networkRes.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(req, copy).catch(() => {});
                    });
                }
                return networkRes;
            })
            .catch(async () => {
                const exact = await caches.match(req);
                if (exact) return exact;
                const withoutQuery = await caches.match(req, { ignoreSearch: true });
                if (withoutQuery) return withoutQuery;
                if (req.mode === 'navigate') {
                    const fallbackIndex = await caches.match('./index.html');
                    if (fallbackIndex) return fallbackIndex;
                }
                throw new Error('Offline');
            })
    );
});
