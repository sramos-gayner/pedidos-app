/* =====================================================================
   PEDIDOS COMERCIALES · App (PWA)
   No hace falta tocar este archivo: la configuración está en config.js
   ---------------------------------------------------------------------
   Cómo funciona el envío:
   1. Al pulsar "Enviar", el pedido se guarda PRIMERO en el dispositivo
      (cola) con un identificador único.
   2. La app intenta enviarlo. Si hay conexión y el servidor lo acepta,
      sale de la cola y pasa a "Enviados" con su nº de pedido.
   3. Si no hay conexión, se queda en la cola y se reintenta solo: al
      recuperar cobertura, al volver a abrir la app y cada minuto.
   4. El servidor ignora un pedido que ya tenga (mismo identificador),
      así que los reintentos nunca crean duplicados.
   ===================================================================== */
'use strict';

(function () {
  const CFG = Object.assign({ API_URL: '', EMPRESA: 'Pedidos', VERSION: '1.0.0' }, window.APP_CONFIG || {});
  const K = { sesion: 'pc_sesion', datos: 'pc_datos', cola: 'pc_cola', enviados: 'pc_enviados', borrador: 'pc_borrador', aviso: 'pc_aviso_instalar' };
  const TIEMPO_ESPERA_MS = 30000;
  const REINTENTO_MS = 60000;
  const MAX_ENVIADOS = 100;
  const DIAS_ENVIADOS = 30;
  const VENTANA_PARECIDO_MS = 30 * 60 * 1000;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // ------------------------------------------------------------------ almacenamiento
  function leer(k, porDefecto) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : porDefecto; } catch (e) { return porDefecto; }
  }
  function escribir(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }
  function borrar(k) { try { localStorage.removeItem(k); } catch (e) { /* nada */ } }

  // ------------------------------------------------------------------ utilidades
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function normalizar(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }
  function fechaHora(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function hoyISO() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }
  function el(tag, props) {
    const n = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const h = arguments[i];
      if (h == null || h === false) continue;
      if (Array.isArray(h)) h.forEach((x) => x != null && n.append(x)); else n.append(h);
    }
    return n;
  }
  function plural(n, uno, varios) { return n === 1 ? uno : varios.replace('#', n); }
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------ estado
  const estado = {
    sesion: leer(K.sesion, null),
    datos: leer(K.datos, { clientes: [], condiciones: [] }),
    indice: [],
    cliente: null,
    editandoId: null,
  };

  // ------------------------------------------------------------------ servidor
  class ErrorRed extends Error {}

  async function api(accion, datos) {
    if (!CFG.API_URL || CFG.API_URL.indexOf('PEGA_AQUI') !== -1) {
      throw new ErrorRed('La app no está configurada (falta API_URL en config.js)');
    }
    if (navigator.onLine === false) throw new ErrorRed('Sin conexión');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIEMPO_ESPERA_MS);
    try {
      // text/plain evita la "petición previa" CORS que Apps Script no admite.
      const res = await fetch(CFG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ accion: accion }, datos)),
        redirect: 'follow',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new ErrorRed('Error del servidor (HTTP ' + res.status + ')');
      const txt = await res.text();
      try { return JSON.parse(txt); } catch (e) { throw new ErrorRed('Respuesta no válida del servidor'); }
    } catch (e) {
      if (e instanceof ErrorRed) throw e;
      throw new ErrorRed(e && e.name === 'AbortError' ? 'Tiempo de espera agotado' : 'Sin conexión');
    } finally {
      clearTimeout(t);
    }
  }

  // ------------------------------------------------------------------ sesión y datos
  async function entrar(ev) {
    ev.preventDefault();
    const pin = $('#pin').value.trim();
    const msg = $('#loginMsg');
    msg.textContent = '';
    if (!/^\d{4,10}$/.test(pin)) { msg.textContent = 'El PIN tiene entre 4 y 10 cifras.'; return; }
    const btn = $('#btnLogin');
    btn.disabled = true; btn.textContent = 'Comprobando…';
    try {
      const r = await api('datos', { pin: pin });
      if (!r.ok) { msg.textContent = r.mensaje || 'No se pudo entrar.'; return; }
      estado.sesion = { pin: pin, comercial: r.comercial };
      escribir(K.sesion, estado.sesion);
      guardarDatos(r);
      $('#pin').value = '';
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      mostrarVista();
      sincronizar();
    } catch (e) {
      msg.textContent = e.message === 'Sin conexión'
        ? 'Necesitas conexión para entrar la primera vez.'
        : 'No se pudo conectar: ' + e.message + '.';
    } finally {
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  }

  function guardarDatos(r) {
    estado.datos = { clientes: r.clientes || [], condiciones: r.condiciones || [], actualizado: new Date().toISOString() };
    escribir(K.datos, estado.datos);
    construirIndice();
    pintarCondiciones();
    pintarInfo();
  }

  async function refrescarDatos() {
    if (!estado.sesion || navigator.onLine === false) return;
    try {
      const r = await api('datos', { pin: estado.sesion.pin });
      if (r.ok) guardarDatos(r);
      else if (r.codigo === 'PIN_INVALIDO') sesionCaducada();
    } catch (e) { /* sin conexión: seguimos con la lista guardada */ }
  }

  function sesionCaducada() {
    const pendientes = colaPropia().length;
    estado.sesion = null;
    borrar(K.sesion); borrar(K.datos);
    estado.datos = { clientes: [], condiciones: [] };
    construirIndice();
    mostrarVista();
    $('#loginMsg').textContent = 'Tu PIN ya no es válido. Pide uno nuevo al administrador.' +
      (pendientes ? ' Hay ' + plural(pendientes, '1 pedido', '# pedidos') + ' sin enviar guardado en este dispositivo; se enviará al entrar con tu nuevo PIN.' : '');
  }

  function salir() {
    const n = colaPropia().length;
    const texto = n
      ? 'Tienes ' + plural(n, '1 pedido', '# pedidos') + ' sin enviar. Se quedarán guardados en este dispositivo y se enviarán cuando vuelvas a entrar con tu PIN.\n\n¿Cerrar sesión?'
      : '¿Cerrar sesión en este dispositivo?';
    if (!confirm(texto)) return;
    estado.sesion = null;
    borrar(K.sesion); borrar(K.datos); borrar(K.borrador);
    estado.datos = { clientes: [], condiciones: [] };
    limpiarFormulario();
    mostrarVista();
  }

  // ------------------------------------------------------------------ vistas
  function mostrarVista() {
    const dentro = !!estado.sesion;
    $('#vLogin').hidden = dentro;
    $('#vApp').hidden = !dentro;
    $('#quien').textContent = dentro ? estado.sesion.comercial : '';
    if (dentro) {
      construirIndice();
      pintarCondiciones();
      restaurarBorrador();
      pintarListas();
      pintarInfo();
    } else {
      setTimeout(() => $('#pin').focus(), 50);
    }
    pintarRed();
  }

  function cambiarPestana(nombre) {
    $$('.pestanas [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === nombre)));
    $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== nombre; });
    window.scrollTo(0, 0);
    if (nombre === 'envios') pintarListas();
  }

  let enviandoAhora = false;
  function pintarRed() {
    const chip = $('#estadoRed');
    const enLinea = navigator.onLine !== false;
    chip.className = 'chip ' + (enviandoAhora ? 'enviando' : enLinea ? 'ok' : 'off');
    chip.textContent = enviandoAhora ? 'Enviando…' : enLinea ? 'En línea' : 'Sin conexión';
  }

  function pintarInfo() {
    const info = $('#infoDatos');
    if (!info) return;
    const n = estado.datos.clientes ? estado.datos.clientes.length : 0;
    info.textContent = 'Versión ' + CFG.VERSION + ' · ' + n + ' clientes' +
      (estado.datos.actualizado ? ', lista actualizada el ' + fechaHora(estado.datos.actualizado) : '');
  }

  // ------------------------------------------------------------------ buscador de clientes
  function construirIndice() {
    estado.indice = (estado.datos.clientes || []).map((c) => ({ id: c.id, nombre: c.nombre, n: normalizar(c.id + ' ' + c.nombre) }));
  }

  function buscarClientes(q) {
    const trozos = normalizar(q).split(/\s+/).filter(Boolean);
    if (!trozos.length) return estado.indice.slice(0, 30);
    const res = [];
    for (const c of estado.indice) {
      if (trozos.every((t) => c.n.indexOf(t) !== -1)) { res.push(c); if (res.length >= 40) break; }
    }
    return res;
  }

  let activa = -1;
  function pintarSugerencias() {
    const lista = $('#clienteLista');
    const res = buscarClientes($('#clienteBuscar').value);
    lista.replaceChildren();
    activa = -1;
    if (!estado.indice.length) {
      lista.append(el('li', { class: 'vacio', text: 'No hay clientes descargados. Abre la app con conexión.' }));
    } else if (!res.length) {
      lista.append(el('li', { class: 'vacio', text: 'Ningún cliente coincide. Prueba con otra palabra o con el código.' }));
    } else {
      res.forEach((c) => {
        lista.append(el('li', {
          role: 'option',
          onmousedown: (e) => e.preventDefault(),
          onclick: () => elegirCliente(c),
        }, el('strong', { text: c.nombre }), el('span', { text: c.id })));
      });
    }
    lista.hidden = false;
    $('#clienteBuscar').setAttribute('aria-expanded', 'true');
  }

  function ocultarSugerencias() {
    $('#clienteLista').hidden = true;
    $('#clienteBuscar').setAttribute('aria-expanded', 'false');
  }

  function elegirCliente(c) {
    estado.cliente = c ? { id: c.id, nombre: c.nombre } : null;
    pintarCliente();
    marcarError('cliente', '');
    guardarBorrador();
  }

  function pintarCliente() {
    const c = estado.cliente;
    const buscar = $('#clienteBuscar');
    ocultarSugerencias();
    if (c && document.activeElement === buscar) buscar.blur(); // cierra el teclado al elegir
    $('#buscador').hidden = !!c;
    $('#clienteElegido').hidden = !c;
    if (c) $('.elegido-texto').textContent = c.nombre + ' · ' + c.id;
    else buscar.value = '';
  }

  function teclaBuscador(e) {
    const items = $$('#clienteLista li[role=option]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      activa = (activa + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('activa', i === activa));
      items[activa].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault(); // nunca enviar el formulario desde el buscador
      const res = buscarClientes($('#clienteBuscar').value);
      if (activa >= 0 && items[activa]) items[activa].click();
      else if (res.length === 1) elegirCliente(res[0]);
    } else if (e.key === 'Escape') {
      ocultarSugerencias();
    }
  }

  // ------------------------------------------------------------------ formulario
  function nuevaLinea(cant, prod) {
    const fila = el('div', { class: 'linea' },
      el('input', { class: 'cant', type: 'text', inputmode: 'decimal', placeholder: 'Cant.', 'aria-label': 'Cantidad', maxlength: '10', enterkeyhint: 'next' }),
      el('input', { class: 'prod', type: 'text', placeholder: 'Producto o referencia', 'aria-label': 'Producto', maxlength: '200', autocapitalize: 'sentences', enterkeyhint: 'next' }),
      el('button', { type: 'button', class: 'x', 'aria-label': 'Quitar línea', text: '×' }));
    $('.cant', fila).value = cant || '';
    $('.prod', fila).value = prod || '';
    $('.x', fila).addEventListener('click', () => {
      if ($$('#lineas .linea').length > 1) fila.remove();
      else $$('input', fila).forEach((i) => { i.value = ''; });
      guardarBorrador();
    });
    $('#lineas').append(fila);
    return fila;
  }

  function pintarCondiciones() {
    const sel = $('#pago');
    const actual = sel.value;
    const lista = (estado.datos.condiciones && estado.datos.condiciones.length) ? estado.datos.condiciones : ['Las habituales del cliente'];
    sel.replaceChildren(...lista.map((c) => el('option', { value: c, text: c })));
    if (actual && lista.indexOf(actual) !== -1) sel.value = actual;
  }

  function marcarError(campo, texto) {
    const p = $('[data-error="' + campo + '"]');
    if (!p) return;
    p.textContent = texto || '';
    const cont = p.closest('.campo');
    if (cont) cont.classList.toggle('mal', !!texto);
  }

  function recogerPedido() {
    const errores = {};
    if (!estado.cliente) errores.cliente = 'Elige un cliente de la lista.';

    const lineas = [];
    let lineaMal = false;
    $$('#lineas .linea').forEach((f) => {
      const c = $('.cant', f).value.trim();
      const p = $('.prod', f).value.trim();
      f.classList.remove('mal');
      if (!c && !p) return; // línea vacía: se ignora
      const n = Number(c.replace(',', '.'));
      if (!p || !c || !isFinite(n) || n <= 0) { f.classList.add('mal'); lineaMal = true; return; }
      lineas.push({ cantidad: n, producto: p });
    });
    if (lineaMal) errores.lineas = 'Revisa las líneas en rojo: cada una necesita cantidad (mayor que 0) y producto.';
    else if (!lineas.length) errores.lineas = 'Añade al menos un producto.';

    const fecha = $('#fechaEntrega').value;
    if (fecha && fecha < hoyISO()) errores.fecha = 'La fecha de entrega no puede ser anterior a hoy.';

    const distinta = $('#chkDireccion').checked;
    const dir = $('#direccion').value.trim();
    if (distinta && dir.length < 8) errores.direccion = 'Escribe la dirección de entrega completa.';

    ['cliente', 'lineas', 'fecha', 'direccion'].forEach((k) => marcarError(k, errores[k]));
    const primero = $('.msg-error:not(:empty)');
    if (primero) {
      primero.closest('.campo').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return null;
    }
    return {
      clienteId: estado.cliente.id,
      clienteNombre: estado.cliente.nombre,
      lineas: lineas,
      pago: $('#pago').value,
      fechaEntrega: fecha,
      direccion: distinta ? dir : '',
      observaciones: $('#obs').value.trim(),
    };
  }

  function firma(p) {
    return p.clienteId + '|' + p.lineas.map((l) => l.cantidad + 'x' + normalizar(l.producto)).sort().join(';');
  }

  /** Detecta un pedido igual (mismo cliente y productos) hecho hace poco: suele ser un doble envío. */
  function buscarParecido(p) {
    const f = firma(p);
    const desde = Date.now() - VENTANA_PARECIDO_MS;
    const cola = colaPropia().filter((i) => i.id !== estado.editandoId && new Date(i.creadoEn).getTime() > desde && firma(i.pedido) === f);
    const env = enviadosPropios().filter((e) => e.firma === f && new Date(e.creadoEn).getTime() > desde);
    return cola[0] || env[0] || null;
  }

  async function enviar(ev) {
    ev.preventDefault();
    const btn = $('#btnEnviar');
    if (btn.disabled) return;
    const datos = recogerPedido();
    if (!datos) return;

    const parecido = buscarParecido(datos);
    if (parecido && !confirm('Hace menos de 30 minutos ya registraste un pedido igual para ' + datos.clienteNombre +
      (parecido.numero ? ' (nº ' + parecido.numero + ')' : '') + '.\n\n¿Quieres enviar OTRO pedido igual?')) return;

    btn.disabled = true;
    const id = estado.editandoId || uuid();
    const creadoEn = new Date().toISOString();
    const item = {
      id: id,
      comercial: estado.sesion.comercial,
      creadoEn: creadoEn,
      estado: 'pendiente',
      intentos: 0,
      ultimoError: '',
      pedido: Object.assign({ id: id, creadoEn: creadoEn }, datos),
    };
    const cola = leer(K.cola, []).filter((i) => i.id !== id);
    cola.push(item);
    if (!escribir(K.cola, cola)) {
      btn.disabled = false;
      modal('error', 'No se pudo guardar', 'El dispositivo no ha permitido guardar el pedido.',
        'No se ha borrado nada del formulario. Haz una captura de pantalla y avisa al administrador.');
      return;
    }
    limpiarFormulario();
    btn.textContent = 'Enviando…';
    await procesarCola();
    btn.disabled = false;
    btn.textContent = 'Enviar pedido';

    const enviado = leer(K.enviados, []).find((e) => e.id === id);
    const enCola = leer(K.cola, []).find((i) => i.id === id);
    if (enviado) {
      modal('ok', 'Pedido recibido', null, 'Ya está en la hoja del equipo interno.', [
        'Nº ', el('b', { text: enviado.numero }), el('br'), enviado.cliente,
      ]);
    } else if (enCola && enCola.estado === 'error') {
      modal('error', 'Pedido no aceptado', enCola.ultimoError, 'Corrígelo en "Mis envíos" → Corregir.');
    } else {
      modal('pendiente', 'Guardado en el dispositivo', 'Ahora mismo no se ha podido enviar (' + ((enCola && enCola.ultimoError) || 'sin conexión').toLowerCase() + ').',
        'Se enviará solo en cuanto haya cobertura. Si cierras la app, se enviará al volver a abrirla. Lo verás en "Mis envíos".');
    }
  }

  function limpiarFormulario() {
    estado.cliente = null;
    estado.editandoId = null;
    pintarCliente();
    $('#lineas').replaceChildren();
    nuevaLinea();
    $('#fechaEntrega').value = '';
    $('#chkDireccion').checked = false;
    $('#direccion').value = '';
    $('#direccion').hidden = true;
    $('#obs').value = '';
    if ($('#pago').options.length) $('#pago').selectedIndex = 0;
    ['cliente', 'lineas', 'fecha', 'direccion'].forEach((k) => marcarError(k, ''));
    $('#avisoEdicion').hidden = true;
    borrar(K.borrador);
  }

  // Borrador: lo que se está escribiendo sobrevive si se cierra la app o se agota la batería.
  function guardarBorrador() {
    if (!estado.sesion) return;
    escribir(K.borrador, {
      comercial: estado.sesion.comercial,
      editandoId: estado.editandoId,
      cliente: estado.cliente,
      lineas: $$('#lineas .linea').map((f) => [$('.cant', f).value, $('.prod', f).value]),
      pago: $('#pago').value,
      fecha: $('#fechaEntrega').value,
      distinta: $('#chkDireccion').checked,
      direccion: $('#direccion').value,
      obs: $('#obs').value,
    });
  }

  function restaurarBorrador() {
    const b = leer(K.borrador, null);
    if (!b || !estado.sesion || b.comercial !== estado.sesion.comercial) { limpiarFormulario(); return; }
    cargarEnFormulario(b);
  }

  function cargarEnFormulario(b) {
    estado.cliente = b.cliente || null;
    estado.editandoId = b.editandoId || null;
    pintarCliente();
    $('#lineas').replaceChildren();
    (b.lineas && b.lineas.length ? b.lineas : [['', '']]).forEach((l) => nuevaLinea(l[0], l[1]));
    if (b.pago) {
      if (!Array.from($('#pago').options).some((o) => o.value === b.pago)) $('#pago').append(el('option', { value: b.pago, text: b.pago }));
      $('#pago').value = b.pago;
    }
    $('#fechaEntrega').value = b.fecha || '';
    $('#chkDireccion').checked = !!b.distinta;
    $('#direccion').hidden = !b.distinta;
    $('#direccion').value = b.direccion || '';
    $('#obs').value = b.obs || '';
    $('#avisoEdicion').hidden = !estado.editandoId;
  }

  // ------------------------------------------------------------------ cola de envío
  function colaPropia() {
    const quien = estado.sesion && estado.sesion.comercial;
    return leer(K.cola, []).filter((i) => i.comercial === quien);
  }
  function enviadosPropios() {
    const quien = estado.sesion && estado.sesion.comercial;
    return leer(K.enviados, []).filter((e) => e.comercial === quien);
  }
  function actualizarItem(id, cambios) {
    escribir(K.cola, leer(K.cola, []).map((i) => (i.id === id ? Object.assign({}, i, cambios) : i)));
  }
  function quitarDeCola(id) {
    escribir(K.cola, leer(K.cola, []).filter((i) => i.id !== id));
  }
  function anadirEnviado(item, r) {
    const limite = Date.now() - DIAS_ENVIADOS * 86400000;
    const lista = leer(K.enviados, []).filter((e) => e.id !== item.id && new Date(e.recibido).getTime() > limite);
    lista.unshift({
      id: item.id,
      numero: r.numero,
      comercial: item.comercial,
      cliente: item.pedido.clienteNombre,
      lineas: item.pedido.lineas.length,
      firma: firma(item.pedido),
      creadoEn: item.creadoEn,
      recibido: r.recibido || new Date().toISOString(),
    });
    escribir(K.enviados, lista.slice(0, MAX_ENVIADOS));
  }

  let enCurso = null;
  /** Envía los pedidos pendientes de uno en uno. Devuelve cuántos se han enviado. */
  function procesarCola() {
    if (!enCurso) {
      enCurso = recorrerCola().finally(() => {
        enCurso = null; enviandoAhora = false; pintarRed(); pintarListas();
      });
    }
    return enCurso;
  }

  async function recorrerCola() {
    const intentados = new Set();
    let enviados = 0;
    while (estado.sesion) {
      const item = leer(K.cola, []).find((i) => i.estado === 'pendiente' && i.comercial === estado.sesion.comercial && !intentados.has(i.id));
      if (!item) break;
      intentados.add(item.id);
      enviandoAhora = true; pintarRed();
      let r;
      try {
        r = await api('pedido', { pin: estado.sesion.pin, pedido: item.pedido });
      } catch (e) {
        // Sin red / tiempo agotado: se queda pendiente y paramos (el resto también fallaría).
        actualizarItem(item.id, { intentos: (item.intentos || 0) + 1, ultimoIntento: new Date().toISOString(), ultimoError: e.message });
        break;
      }
      if (r && r.ok) {
        quitarDeCola(item.id);
        anadirEnviado(item, r);
        enviados++;
      } else if (r && r.codigo === 'PIN_INVALIDO') {
        sesionCaducada();
        break;
      } else if (r && r.reintentar) {
        actualizarItem(item.id, { intentos: (item.intentos || 0) + 1, ultimoIntento: new Date().toISOString(), ultimoError: r.mensaje || 'Error temporal' });
        break;
      } else {
        // Rechazo definitivo (datos no válidos): necesita que el comercial lo corrija.
        actualizarItem(item.id, { estado: 'error', ultimoIntento: new Date().toISOString(), ultimoError: (r && r.mensaje) || 'Respuesta desconocida del servidor' });
      }
    }
    return enviados;
  }

  /** Sincronización en segundo plano (al abrir, al recuperar red, cada minuto). */
  function sincronizar() {
    if (!estado.sesion) return;
    const habia = colaPropia().filter((i) => i.estado === 'pendiente').length;
    procesarCola().then((n) => {
      if (n && habia) toast(n === 1 ? '✓ 1 pedido pendiente enviado' : '✓ ' + n + ' pedidos pendientes enviados');
    });
    refrescarDatos();
  }

  // ------------------------------------------------------------------ "Mis envíos"
  function pintarListas() {
    if (!estado.sesion) return;
    const cola = colaPropia();
    const pendientes = cola.filter((i) => i.estado === 'pendiente').length;
    const errores = cola.filter((i) => i.estado === 'error').length;

    const badge = $('#badge');
    badge.hidden = !(pendientes + errores);
    badge.textContent = String(pendientes + errores);
    badge.classList.toggle('error', errores > 0);

    const lc = $('#listaCola');
    lc.replaceChildren();
    if (!cola.length) lc.append(el('p', { class: 'vacio-lista', text: 'No hay pedidos pendientes. Todo enviado.' }));
    cola.slice().sort((a, b) => a.creadoEn.localeCompare(b.creadoEn)).forEach((i) => {
      const p = i.pedido;
      let textoEstado;
      if (i.estado === 'error') textoEstado = 'No aceptado: ' + i.ultimoError;
      else if (i.estado === 'editando') textoEstado = 'Abierto para corregir en "Nuevo pedido".';
      else textoEstado = 'Esperando para enviarse' + (i.ultimoError ? ' · último intento: ' + i.ultimoError.toLowerCase() : '') + '.';
      lc.append(el('article', { class: 'item ' + i.estado },
        el('div', { class: 'item-cab' }, el('strong', { text: p.clienteNombre })),
        el('div', { class: 'item-meta', text: 'Creado ' + fechaHora(i.creadoEn) + ' · ' + plural(p.lineas.length, '1 línea', '# líneas') }),
        el('div', { class: 'item-estado', text: textoEstado }),
        i.estado === 'editando' ? null : el('div', { class: 'item-acciones' },
          el('button', { type: 'button', class: 'btn secundario peque', text: 'Corregir', onclick: () => corregir(i.id) }),
          el('button', { type: 'button', class: 'btn peligro peque', text: 'Eliminar', onclick: () => eliminar(i.id) }))));
    });
    $('#btnReintentar').hidden = !pendientes;

    const le = $('#listaEnviados');
    le.replaceChildren();
    const env = enviadosPropios();
    if (!env.length) le.append(el('p', { class: 'vacio-lista', text: 'Aún no hay pedidos enviados desde este dispositivo.' }));
    env.forEach((e) => {
      le.append(el('article', { class: 'item ok' },
        el('div', { class: 'item-cab' }, el('strong', { text: e.cliente }), el('span', { class: 'num', text: e.numero })),
        el('div', { class: 'item-meta', text: '✓ Recibido ' + fechaHora(e.recibido) + ' · ' + plural(e.lineas, '1 línea', '# líneas') })));
    });
  }

  function corregir(id) {
    if (enCurso) { toast('Espera a que termine el envío en curso.'); return; }
    const item = leer(K.cola, []).find((i) => i.id === id);
    if (!item) return;
    if (estado.editandoId && estado.editandoId !== id) cancelarEdicion(true);
    actualizarItem(id, { estado: 'editando', estadoPrevio: item.estado === 'editando' ? item.estadoPrevio : item.estado });
    const p = item.pedido;
    cargarEnFormulario({
      editandoId: id,
      cliente: estado.indice.find((c) => c.id === p.clienteId) || null, // si el cliente ya no existe, hay que elegirlo de nuevo
      lineas: p.lineas.map((l) => [String(l.cantidad).replace('.', ','), l.producto]),
      pago: p.pago, fecha: p.fechaEntrega, distinta: !!p.direccion, direccion: p.direccion, obs: p.observaciones,
    });
    guardarBorrador();
    cambiarPestana('nuevo');
    if (!estado.cliente) marcarError('cliente', 'El cliente anterior ya no está en la lista. Elige uno.');
  }

  function cancelarEdicion(silencioso) {
    if (!estado.editandoId) return;
    const item = leer(K.cola, []).find((i) => i.id === estado.editandoId);
    if (item) actualizarItem(item.id, { estado: item.estadoPrevio || 'pendiente' });
    limpiarFormulario();
    pintarListas();
    if (!silencioso) { toast('Corrección cancelada. El pedido sigue en "Mis envíos".'); sincronizar(); }
  }

  function eliminar(id) {
    const item = leer(K.cola, []).find((i) => i.id === id);
    if (!item) return;
    if (!confirm('¿Eliminar el pedido de ' + item.pedido.clienteNombre + '? No se ha enviado y no se podrá recuperar.')) return;
    quitarDeCola(id);
    pintarListas();
  }

  // ------------------------------------------------------------------ mensajes
  function modal(tipo, titulo, texto, detalle, nodos) {
    const iconos = { ok: '✓', pendiente: '⏳', error: '!' };
    const icono = $('#modalIcono');
    icono.className = 'modal-icono ' + tipo;
    icono.textContent = iconos[tipo] || '';
    $('#modalTitulo').textContent = titulo;
    const t = $('#modalTexto');
    t.replaceChildren();
    if (nodos) nodos.forEach((n) => t.append(n)); else t.textContent = texto || '';
    $('#modalDetalle').textContent = detalle || '';
    $('#modal').hidden = false;
    $('#modalOk').focus();
  }

  let toastTimer = null;
  function toast(texto) {
    const t = $('#toast');
    t.textContent = texto;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // ------------------------------------------------------------------ instalación
  let eventoInstalar = null;
  function esInstalada() {
    return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }
  function esIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function avisoInstalar() {
    if (esInstalada() || leer(K.aviso, false)) return;
    if (esIOS()) {
      $('#avisoInstalarTexto').textContent = 'Instala la app: pulsa el botón Compartir de Safari y luego «Añadir a pantalla de inicio».';
      $('#avisoInstalar').hidden = false;
    }
  }

  // ------------------------------------------------------------------ arranque
  function iniciar() {
    $('#empresa').textContent = CFG.EMPRESA;
    document.title = CFG.EMPRESA;

    if (!CFG.API_URL || CFG.API_URL.indexOf('PEGA_AQUI') !== -1) {
      $('#loginMsg').textContent = 'Falta configurar la dirección del servidor (API_URL en config.js).';
    }

    $('#fLogin').addEventListener('submit', entrar);
    $('#fPedido').addEventListener('submit', enviar);
    $('#fPedido').addEventListener('input', (e) => {
      // Al corregir un campo, desaparece su mensaje de error.
      const campo = e.target.closest('.campo');
      const msg = campo && $('.msg-error[data-error]', campo);
      if (msg && msg.textContent && e.target.id !== 'clienteBuscar') marcarError(msg.dataset.error, '');
      const fila = e.target.closest('.linea');
      if (fila) fila.classList.remove('mal');
      guardarBorrador();
    });
    $('#fPedido').addEventListener('change', guardarBorrador);
    $$('.pestanas [role=tab]').forEach((b) => b.addEventListener('click', () => cambiarPestana(b.dataset.tab)));

    const buscar = $('#clienteBuscar');
    buscar.addEventListener('input', pintarSugerencias);
    buscar.addEventListener('focus', pintarSugerencias);
    buscar.addEventListener('keydown', teclaBuscador);
    buscar.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== buscar) ocultarSugerencias(); }, 200));
    $('#btnCambiarCliente').addEventListener('click', () => { elegirCliente(null); setTimeout(() => $('#clienteBuscar').focus(), 30); });

    $('#btnLinea').addEventListener('click', () => { $('.cant', nuevaLinea()).focus(); guardarBorrador(); });
    $('#lineas').addEventListener('keydown', (e) => {
      // "Intro" en una línea pasa al siguiente campo en lugar de enviar el pedido.
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      const fila = e.target.closest('.linea');
      if (e.target.classList.contains('cant')) { $('.prod', fila).focus(); return; }
      const siguiente = fila.nextElementSibling || nuevaLinea();
      $('.cant', siguiente).focus();
    });
    $('#chkDireccion').addEventListener('change', (e) => {
      $('#direccion').hidden = !e.target.checked;
      if (e.target.checked) $('#direccion').focus(); else marcarError('direccion', '');
    });
    $('#fechaEntrega').min = hoyISO();
    $('#btnCancelarEdicion').addEventListener('click', () => cancelarEdicion(false));

    $('#btnReintentar').addEventListener('click', () => {
      if (navigator.onLine === false) { toast('Sin conexión. Se enviará cuando vuelva la cobertura.'); return; }
      procesarCola().then((n) => toast(n ? '✓ ' + plural(n, '1 pedido enviado', '# pedidos enviados') : 'No se ha podido enviar. Se reintentará solo.'));
    });
    $('#btnSalir').addEventListener('click', salir);
    $('#modalOk').addEventListener('click', () => { $('#modal').hidden = true; });

    $('#btnCerrarAviso').addEventListener('click', () => { escribir(K.aviso, true); $('#avisoInstalar').hidden = true; });
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      eventoInstalar = e;
      if (leer(K.aviso, false)) return;
      $('#avisoInstalarTexto').textContent = 'Instala la app en este dispositivo para abrirla desde un icono.';
      $('#btnInstalar').hidden = false;
      $('#avisoInstalar').hidden = false;
    });
    $('#btnInstalar').addEventListener('click', async () => {
      if (!eventoInstalar) return;
      eventoInstalar.prompt();
      await eventoInstalar.userChoice.catch(() => {});
      eventoInstalar = null;
      $('#avisoInstalar').hidden = true;
    });
    avisoInstalar();

    window.addEventListener('online', () => { pintarRed(); sincronizar(); });
    window.addEventListener('offline', pintarRed);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizar(); });
    setInterval(() => {
      if (estado.sesion && navigator.onLine !== false && colaPropia().some((i) => i.estado === 'pendiente')) sincronizar();
    }, REINTENTO_MS);

    // Si quedó un pedido marcado "editando" sin borrador (p. ej. se borró), vuelve a la cola.
    const b = leer(K.borrador, null);
    const editando = b && b.editandoId;
    leer(K.cola, []).forEach((i) => {
      if (i.estado === 'editando' && i.id !== editando) actualizarItem(i.id, { estado: i.estadoPrevio || 'pendiente' });
    });

    mostrarVista();
    if (estado.sesion) sincronizar();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* sin modo offline, la app sigue funcionando */ });
    }
  }

  // Expuesto solo para pruebas automáticas.
  window.__pedidos = { procesarCola: procesarCola, esperar: esperar };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
