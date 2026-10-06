/* Service worker: guarda la app en el dispositivo para que abra sin cobertura.
   Estrategia "red primero": con conexión siempre carga la versión más reciente
   (no hace falta cambiar nada aquí al actualizar la app); sin conexión, o si la
   red tarda más de 5 s, usa la copia guardada. Las llamadas al servidor de
   Google no pasan por aquí. */
const CACHE = 'pedidos-app-v1';
const ARCHIVOS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
const ESPERA_RED_MS = 5000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // el servidor de Google va directo
  e.respondWith(redPrimero(req, url));
});

async function redPrimero(req, url) {
  const cache = await caches.open(CACHE);
  const clave = url.origin + url.pathname; // sin parámetros
  const red = fetch(clave, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
    if (res && res.ok) cache.put(clave, res.clone());
    return res;
  });
  red.catch(() => {}); // si la red falla después de usar la copia, no es un error
  try {
    return await conLimite(red, ESPERA_RED_MS);
  } catch (err) {
    const copia = await cache.match(clave);
    if (copia) return copia;
    if (req.mode === 'navigate') {
      const inicio = (await cache.match(new URL('./index.html', self.registration.scope).href)) ||
                     (await cache.match(self.registration.scope));
      if (inicio) return inicio;
    }
    return new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

function conLimite(promesa, ms) {
  return new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error('tiempo')), ms);
    promesa.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); ko(e); });
  });
}
