/* ============================================================================
 * SKOL-IF WEBBEN – OFFLINE SERVICE WORKER (Network-First)
 * Hämtar alltid färskaste versionen när internet finns, men sparar en lokal
 * reservkopia så att lektions- och föreningsverktygen fungerar även i en
 * idrottshall i källaren eller i skogen utan täckning.
 * ============================================================================ */

const CACHE_NAME = 'skolif-offline-v4';

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
    './klasser.js?v=9',
    './manifest.json',
    './icon.svg',
    './apple-touch-icon.png',
    './icon-192.png',
    './icon-512.png'
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
        caches.open(CACHE_NAME).then((cache) =>
            Promise.allSettled(
                PRECACHE_URLS.map((url) =>
                    fetch(url, { cache: 'reload' }).then((res) => {
                        if (res && res.ok) {
                            return cache.put(url, res);
                        }
                    })
                )
            )
        ).then(() => self.skipWaiting())
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

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    // Låt ljud-/videoströmmar med Range-headers (t.ex. Safari <audio>) gå direkt
    if (req.headers && req.headers.has('range')) return;

    let url;
    try {
        url = new URL(req.url);
    } catch (e) {
        return;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    // Fånga ALDRIG anrop till externa domäner (Firebase, Firestore, Google Auth, CDN, AdSense m.m.)
    if (url.origin !== self.location.origin) return;

    if (BYPASS_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
        return;
    }

    // Network-First: försök alltid hämta senaste versionen från nätet först
    event.respondWith(
        fetch(req)
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
