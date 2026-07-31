const CACHE = 'friendmap-v1'

// Cache only the shell — never cache map tiles or API calls
const SHELL = ['/', '/manifest.json']

self.addEventListener('install', e => {
  self.skipWaiting()
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  )
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)

  // Never intercept Supabase, tile, or API requests
  if (
    url.hostname.includes('supabase') ||
    url.hostname.includes('openstreetmap') ||
    url.hostname.includes('tile') ||
    url.pathname.startsWith('/api/')
  ) {
    return
  }

  // Network-first for everything else (avoids stale JS)
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  )
})
