// ==UserScript==
// @name         LSS Personal-Zuweisung
// @namespace    lss-personal-zuweisung
// @version      0.5.5
// @description  Leitstelle wählen, benötigte Ausbildungen je Fahrzeug von den Kaufseiten lesen, passendes Personal auf den Wachen suchen und zuweisen (nur per Klick, mit Vorschau)
// @match        https://www.leitstellenspiel.de/*
// @match        https://leitstellenspiel.de/*
// @grant        GM_xmlhttpRequest
// @connect      api.lss-manager.de
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return; // nicht in iframes laden

  // ======================================================================
  // Einstellungen
  // ======================================================================
  const BUILDING_PAGE = id => '/buildings/' + id;
  // Seiten, auf denen die Fahrzeug-Kaufliste stehen kann (erste mit Treffern gewinnt)
  const BUY_PAGES = [id => '/buildings/' + id + '/vehicles/new', id => '/buildings/' + id];
  const PERSONALS_PAGE = id => '/buildings/' + id + '/personals'; // Personalliste einer Wache (mit Ausbildungen)
  const ASSIGN_PAGE = id => '/vehicles/' + id + '/zuweisung';     // Zuweisungsseite eines Fahrzeugs
  const MAX_BUY_PAGES_PER_GROUP = 4;  // so viele Wachen je Wachentyp werden höchstens nach Kauf-Infos gelesen
  const DELAY_MIN = 500;              // ms Pause zwischen Zuweisungen (min)
  const DELAY_MAX = 1000;             // ms Pause zwischen Zuweisungen (max)
  const PAGE_DELAY = 250;             // ms Pause zwischen Seitenabrufen
  const MAX_FAILS_IN_ROW = 3;         // Abbruch nach so vielen Fehlern hintereinander
  const OVERRIDE_KEY = 'lsspz-overrides-v1';

  // ======================================================================
  // Hilfsfunktionen
  // ======================================================================
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rndDelay = () => DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = x => (typeof x === 'number' && isFinite(x) ? x : null);
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
  const trainCore = n => String(n).replace(/[\s-]*(ausbildung|schulung|lehrgang)\s*$/i, '').trim();
  function hasTraining(text, name) {
    const n = norm(name);
    if (n.length < 3) return false;
    const t = norm(text);
    if (t.includes(n)) return true;
    const c = norm(trainCore(name));
    return c.length >= 4 && t.includes(c);
  }
  const trainOf = r => (r.train != null ? r.train : r.text); // nur Ausbildungsspalte (nicht Fahrzeugnamen)
  // Text aus data-filterable-by (dort stehen vermutlich die Ausbildungen der Person)
  function filterText(el) {
    const v = el.getAttribute('data-filterable-by');
    if (!v || v === '[]') return '';
    try { const a = JSON.parse(v); return Array.isArray(a) ? a.join(' ') : String(a); } catch (e) { return v; }
  }
  const dataCells = tr => [...tr.children].filter(c => c.tagName === 'TD');
  const nameIndex = tds => tds.findIndex(td => {
    const t = td.textContent.replace(/\s+/g, ' ').trim();
    return t && !/^verfügbar$/i.test(t) && !td.querySelector('input');
  });
  const cellAfterName = (tr, offset) => {
    const tds = dataCells(tr);
    const n = tds[nameIndex(tds) + offset];
    return n ? n.textContent.replace(/\s+/g, ' ').trim() : '';
  };
  const trainCell = tr => cellAfterName(tr, 1);     // Spalte "Ausbildung"
  const vehicleCell = tr => cellAfterName(tr, 2);   // Spalte "Fahrzeug" (nur Personalliste)
  // Name = erste nicht-leere Zelle, die kein Status ist
  function cellName(el) {
    const t = [...el.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim()).find(x => x && !/^verfügbar$/i.test(x));
    return t ? t.slice(0, 40) : null;
  }
  const BUILDING_TYPES = {
    0: 'Feuerwache', 1: 'Feuerwehrschule', 2: 'Rettungswache', 3: 'Rettungsschule',
    4: 'Krankenhaus', 5: 'Rettungshubschrauber-Station', 6: 'Polizeiwache', 7: 'Leitstelle',
    8: 'Polizeischule', 9: 'THW', 10: 'THW Bundesschule', 11: 'Bereitschaftspolizei',
    12: 'Schnelleinsatzgruppe (SEG)', 13: 'Polizeihubschrauber-Station'
  };
  const btName = t => BUILDING_TYPES[t] || ('Gebäudetyp ' + t);

  let buildings = [];
  let vehicles = [];
  let lastLoad = 0;
  let lsBuildings = [];   // Wachen der gewählten Leitstelle
  let reqInfo = {};       // Fahrzeugtyp-ID -> { req, raw, name, max, text, src }
  let overrides = {};     // Fahrzeugtyp-ID -> "Notarzt:1, Atemschutz:2" (manuell)
  let personnel = {};     // Wachen-ID -> { source, rows }
  let entries = [];       // pro Fahrzeug mit Bedarf
  let plan = [];          // Liste einzelner Zuweisungen
  let busy = false;
  let lastCheck = { vehicles: 0, buildings: 0, inLs: 0 };
  let abort = false;
  const buyCache = {};

  // ======================================================================
  // Daten laden (API mit Fallback-Endpunkten, Retry, kurzem Cache)
  // ======================================================================
  const API_CANDIDATES = {
    vehicles: ['/api/vehicles', '/api/v2/vehicles', '/api2/vehicles'],
    buildings: ['/api/buildings', '/api/v2/buildings', '/api2/buildings']
  };

  function unwrapList(d) {
    if (Array.isArray(d)) return d;
    if (d && typeof d === 'object') {
      for (const k of ['result', 'vehicles', 'buildings', 'data']) {
        if (Array.isArray(d[k])) return d[k];
      }
    }
    return null;
  }

  // Seiten-Schemata, falls die API nur einen Teil der Liste liefert (z. B. genau 8000 Fahrzeuge)
  const PAGE_SCHEMES = [
    (url, n, page) => url + '?page=' + page,
    (url, n, page) => url + '?offset=' + n,
    (url, n, page) => url + '?start=' + n
  ];
  const pageScheme = {};
  let dataNote = '';

  async function fetchMorePages(kind, url, first) {
    const ids = new Set(first.map(x => x.id));
    const all = first.slice();
    let schemeIdx = pageScheme[kind];
    let page = 2;
    for (let guard = 0; guard < 40; guard++) {
      let got = null;
      const order = schemeIdx != null ? [schemeIdx] : PAGE_SCHEMES.map((_, i) => i);
      for (const i of order) {
        try {
          const r = await fetch(PAGE_SCHEMES[i](url, all.length, page), { credentials: 'same-origin' });
          if (r.ok) {
            const l = unwrapList(await r.json());
            if (l && l.length && !ids.has(l[0].id)) { got = l; schemeIdx = i; break; }
          }
        } catch (e) { /* nächstes Schema */ }
        await sleep(300);
      }
      if (!got) break;
      pageScheme[kind] = schemeIdx;
      got.forEach(x => { if (!ids.has(x.id)) { ids.add(x.id); all.push(x); } });
      page++;
      await sleep(300);
    }
    return all;
  }

  // Bei "runden" Längen (z. B. 8000) besteht der Verdacht auf eine Begrenzung: andere Endpunkte/Seiten versuchen
  async function completeList(kind, url, list) {
    if (list.length < 1000 || list.length % 1000 !== 0) return list;
    const label = kind === 'vehicles' ? 'Fahrzeuge' : 'Gebäude';
    let best = list, bestUrl = url;
    for (const other of API_CANDIDATES[kind]) {
      if (other === url) continue;
      try {
        const r = await fetch(other, { credentials: 'same-origin' });
        if (r.ok) { const l = unwrapList(await r.json()); if (l && l.length > best.length) { best = l; bestUrl = other; } }
      } catch (e) { /* egal */ }
      await sleep(300);
    }
    const full = await fetchMorePages(kind, bestUrl, best);
    dataNote += full.length > list.length
      ? `Die API lieferte zunächst genau ${list.length} ${label} (Begrenzung) – nachgeladen: insgesamt ${full.length}. `
      : `Die API lieferte genau ${list.length} ${label}. Falls du mehr hast, fehlen die übrigen (Diagnose ausführen und Ergebnis schicken). `;
    return full;
  }

  async function getList(kind) {
    let lastErr = new Error('Unbekannter Fehler');
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const url of API_CANDIDATES[kind].slice()) {
        try {
          const r = await fetch(url, { credentials: 'same-origin' });
          if (!r.ok) { lastErr = new Error(url + ' -> HTTP ' + r.status); continue; }
          const list = unwrapList(await r.json());
          if (!list) { lastErr = new Error(url + ' -> unerwartetes Format'); continue; }
          API_CANDIDATES[kind] = [url, ...API_CANDIDATES[kind].filter(u => u !== url)];
          return await completeList(kind, url, list);
        } catch (e) { lastErr = e; }
      }
      await sleep(1500 * (attempt + 1));
    }
    throw lastErr;
  }

  async function loadData(force) {
    if (!force && buildings.length && vehicles.length && Date.now() - lastLoad < 120000) return;
    dataNote = '';
    const b = await getList('buildings');
    await sleep(300);
    const v = await getList('vehicles');
    // Leere Antworten (z. B. Abfragelimit der API) dürfen vorhandene Daten nicht überschreiben
    if (b.length || !buildings.length) buildings = b;
    else dataNote += 'Die API lieferte keine Gebäude – vorherige Daten werden weiterverwendet. ';
    if (v.length || !vehicles.length) vehicles = v;
    else dataNote += 'Die API lieferte keine Fahrzeuge – vorherige Daten werden weiterverwendet. ';
    lastLoad = Date.now();
  }

  // ---------- Fahrzeugtyp-Namen und Maximalbesatzung (lss-manager-API, optional) ----------
  const META_KEY = 'lsspz-typemeta-v3';
  let typeNames = {};
  let typeMax = {};
  const nm = (type, custom) => typeNames[type] || reqInfo[type]?.name || custom || ('Typ ' + type);

  function loadCaches() {
    try {
      const m = JSON.parse(localStorage.getItem(META_KEY) || '{}');
      typeNames = m.names || {}; typeMax = m.max || {};
    } catch (e) { typeNames = {}; typeMax = {}; }
    try { overrides = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}'); } catch (e) { overrides = {}; }
  }
  const saveOverrides = () => { try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(overrides)); } catch (e) { /* egal */ } };

  function gmGetJson(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('GM_xmlhttpRequest nicht verfügbar'));
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 10000,
        onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
        onerror: () => reject(new Error('Netzwerkfehler')),
        ontimeout: () => reject(new Error('Timeout'))
      });
    });
  }

  async function loadTypeMeta() {
    try {
      const data = await gmGetJson('https://api.lss-manager.de/de_DE/vehicles');
      let n = 0;
      for (const [key, v] of Object.entries(data)) {
        if (!v || !v.caption) continue;
        const id = String(v.id ?? key);
        typeNames[id] = v.caption;
        const mx = num(v.maxPersonnel) ?? num(v.max_personnel) ?? num(v.staff?.max);
        if (mx != null) typeMax[id] = mx;
        n++;
      }
      try { localStorage.setItem(META_KEY, JSON.stringify({ names: typeNames, max: typeMax })); } catch (e) { /* egal */ }
      return n;
    } catch (e) {
      console.warn('[LSS Personal-Zuweisung] Typ-Daten konnten nicht geladen werden', e);
      return 0;
    }
  }

  // ======================================================================
  // Kaufseite einer Wache lesen: welche Fahrzeuge brauchen welche Ausbildung?
  // ======================================================================
  const BUY_RE = /\/buildings\/\d+\/vehicle\/\d+\/(\d+)\/credits(?:\?.*)?$/;

  function typesIn(node) {
    const s = new Set();
    node.querySelectorAll('a[href]').forEach(x => {
      const m = (x.getAttribute('href') || '').match(BUY_RE);
      if (m) s.add(m[1]);
    });
    return s;
  }

  // größter Container um den Kauf-Link, der nur Infos zu EINEM Fahrzeugtyp enthält
  function findContainer(a) {
    let best = a.parentElement || a;
    let node = a;
    for (let d = 0; d < 8; d++) {
      const p = node.parentElement;
      if (!p || p.tagName === 'BODY') break;
      if (p.textContent.length > 1500) break;
      if (typesIn(p).size > 1) break;
      best = p; node = p;
      if (p.tagName === 'TR' || p.tagName === 'LI') break;
    }
    return best;
  }

  const ATTRS = ['title', 'data-content', 'data-original-title', 'data-bs-content', 'aria-label'];
  function containerText(c) {
    const parts = [c.textContent];
    const addAttrs = n => ATTRS.forEach(k => { const v = n.getAttribute(k); if (v) parts.push(v.replace(/<[^>]*>/g, ' ')); });
    addAttrs(c);
    c.querySelectorAll(ATTRS.map(k => '[' + k + ']').join(',')).forEach(addAttrs);
    return parts.join(' | ').replace(/\s+/g, ' ').trim();
  }

  function guessName(c) {
    const hd = c.querySelector('.vehicle_type h3, .vehicle_type h4');
    if (hd) { const t = hd.textContent.replace(/\s+/g, ' ').trim(); if (t) return t.slice(0, 60); }
    const cand = [...c.querySelectorAll('h1,h2,h3,h4,h5,strong,b,.vehicle_caption,td')];
    for (const n of cand) {
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if (t.length >= 2 && t.length <= 60 && !/credits|coins|kaufen|^\d/i.test(t)) return t;
    }
    return null;
  }

  // Kaufseite: "Benötigt eine Sonderausbildung an der Schule: (A)" | "(A, B)" | "(A (X))" | "1x A 1x B"
  // (andere "Benötigt …"-Hinweise wie Erweiterungen oder Tragefahrzeuge sind KEINE Ausbildungen)
  function splitTop(str) {
    const out = []; let depth = 0, cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function parseBuyRequirement(text) {
    const out = {};
    const raws = [];
    const add = (name, cnt) => {
      const n = name.replace(/^[\s.:;,\-–]+|[\s.:;,\-–]+$/g, '').trim();
      if (n.length >= 2 && n.length <= 60) out[n] = Math.max(out[n] || 0, cnt || 1);
    };
    const re = /Sonderausbildung(?:en)?\s+an\s+der\s+Schule\s*:\s*/gi;
    let m;
    while ((m = re.exec(text))) {
      const rest = text.slice(m.index + m[0].length);
      let seg;
      if (rest.startsWith('(')) {
        let depth = 0, end = -1;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '(') depth++;
          else if (rest[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
        }
        seg = end > 0 ? rest.slice(1, end) : rest.slice(1, 120);
        splitTop(seg).forEach(item => add(item, 1));
      } else {
        const stop = /\||\$\(|Dieses Fahrzeug|Wird ab|Benötigt|Anzahl der|Kann |Max\. Personen|Min\. Personen|\d+\s*Coins/i.exec(rest);
        seg = (stop ? rest.slice(0, stop.index) : rest).slice(0, 200);
        seg.split(/(?=\b\d+\s*x\s)/i).map(x => x.trim()).filter(Boolean).forEach(part => {
          const mm = part.match(/^(\d+)\s*x\s+(.+)$/i);
          if (mm) add(mm[2], parseInt(mm[1], 10)); else add(part, 1);
        });
      }
      raws.push(seg.trim().slice(0, 120));
    }
    return { req: out, raw: raws.join(' | ') };
  }

  const parseMaxHint = text => {
    const m = text.match(/Max\.\s*Personen\s*:\s*(\d+)/i) || text.match(/(?:Besatzung|Personal|Mannschaft)[^\d]{0,25}(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  };

  function parseBuyDoc(doc) {
    const types = {};
    doc.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      const m = href.match(BUY_RE);
      if (!m || types[m[1]]) return;
      const c = findContainer(a);
      const text = containerText(c);
      const { req, raw } = parseBuyRequirement(text);
      types[m[1]] = { req, raw, name: guessName(c), max: parseMaxHint(text), text: text.slice(0, 500), html: c.outerHTML.slice(0, 1500) };
    });
    return types;
  }

  async function readBuyPage(buildingId) {
    if (buyCache[buildingId]) return buyCache[buildingId];
    const out = { ok: false, types: {}, tried: [] };
    for (const mk of BUY_PAGES) {
      const url = mk(buildingId);
      try {
        const r = await fetch(url, { credentials: 'same-origin' });
        out.tried.push(url + ' -> ' + r.status);
        if (r.ok) {
          const types = parseBuyDoc(new DOMParser().parseFromString(await r.text(), 'text/html'));
          if (Object.keys(types).length) { out.types = types; out.url = url; out.ok = true; break; }
        }
      } catch (e) { out.tried.push(url + ' -> ' + e.message); }
      await sleep(PAGE_DELAY);
    }
    if (!out.ok) { out.error = 'keine Kauf-Links gefunden (' + out.tried.join('; ') + ')'; return out; }
    return (buyCache[buildingId] = out);
  }

  // ---------- Anforderungen: manuell > Kaufseite ----------
  function parseReqString(str) {
    const out = {};
    String(str || '').split(/[,;\n]/).forEach(part => {
      const m = part.trim().match(/^(.*?)(?:\s*[:=×x]\s*(\d+))?$/i);
      const name = (m && m[1] || '').trim();
      if (name) out[name] = parseInt(m[2], 10) || 1;
    });
    return out;
  }
  const reqToString = req => Object.entries(req).map(([k, c]) => c > 1 ? k + ':' + c : k).join(', ');
  const hasOverride = t => Object.prototype.hasOwnProperty.call(overrides, t);

  function reqFor(typeId) {
    if (hasOverride(typeId)) return { req: parseReqString(overrides[typeId]), src: 'manuell' };
    if (reqInfo[typeId]) return { req: reqInfo[typeId].req, src: 'Kaufseite' };
    return { req: {}, src: '' };
  }

  function buildVocab() {
    const set = new Set();
    Object.values(reqInfo).forEach(i => Object.keys(i.req).forEach(k => set.add(k)));
    Object.values(overrides).forEach(str => Object.keys(parseReqString(str)).forEach(k => set.add(k)));
    return [...set];
  }

  // ======================================================================
  // Zuweisungsseite eines Fahrzeugs und Personalliste lesen (Heuristik, siehe Diagnose)
  // ======================================================================
  const REMOVE_RE = /entfern|(^|[^a-z])remove([^a-z]|$)|abzieh|unassign|löschen|delete|danger/i;
  const ASSIGN_RE = /zuweis|(^|[^a-z])assign|(^|[^a-z])add([^a-z]|$)|hinzu|besetz|einteil/i;
  const kindOf = label => (REMOVE_RE.test(label) ? 'remove' : ASSIGN_RE.test(label) ? 'assign' : 'unknown');

  function actionOf(n) {
    const raw = n.getAttribute('href') || n.getAttribute('data-url') || n.getAttribute('data-href') || '';
    if (!raw || raw === '#' || /^javascript:/i.test(raw)) return null;
    let url;
    try { url = new URL(raw, location.origin); } catch (e) { return null; }
    if (url.origin !== location.origin) return null;
    const method = (n.getAttribute('data-method') || 'get').toUpperCase();
    const label = [n.textContent.replace(/\s+/g, ' ').trim(), n.getAttribute('title') || '', String(n.className || ''), url.pathname].join(' ');
    return { url: url.pathname + url.search, method, body: null, label, remote: n.hasAttribute('data-remote'), kind: kindOf(label) };
  }

  function formAction(f) {
    try {
      const url = new URL(f.getAttribute('action'), location.origin);
      if (url.origin !== location.origin) return null;
      const body = new URLSearchParams();
      new FormData(f).forEach((v, k) => { if (typeof v === 'string') body.append(k, v); });
      const method = (body.get('_method') || f.getAttribute('method') || 'get').toUpperCase();
      body.delete('_method');
      const btns = [...f.querySelectorAll('button,input[type=submit]')].map(b => b.value || b.textContent);
      const label = [f.textContent.replace(/\s+/g, ' ').trim(), String(f.className || ''), url.pathname, ...btns].join(' ');
      return { url: url.pathname + url.search, method, body, label, remote: f.hasAttribute('data-remote'), kind: kindOf(label) };
    } catch (e) { return null; }
  }

  function parseRow(el, vehicleId) {
    if (el.querySelector('tr, li')) return null; // nur "Blatt"-Zeilen
    const acts = [];
    el.querySelectorAll('a[href], [data-url], [data-href]').forEach(n => { const a = actionOf(n); if (a) acts.push(a); });
    el.querySelectorAll('form[action]').forEach(f => { const a = formAction(f); if (a) acts.push(a); });
    if (!acts.length) return null;

    const baseText = el.textContent.replace(/\s+/g, ' ').trim();
    const text = (baseText + ' ' + filterText(el)).trim();
    const tcell = trainCell(el);
    const status = el.querySelector('.label')?.textContent.replace(/\s+/g, ' ').trim() || '';
    const here = acts.some(a => a.kind === 'remove');
    const canAssign = acts.some(a => a.kind === 'assign');
    const elsewhere = [...el.querySelectorAll('a[href]')].some(a => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/vehicles\/(\d+)/);
      return m && +m[1] !== +vehicleId && !/zuweisung/i.test(href);
    });

    let pid = (el.id || '').match(/\d+/)?.[0] || el.getAttribute('data-personal-id') || el.getAttribute('data-id') || null;
    const main = acts.find(a => a.kind === 'assign' || a.kind === 'remove');
    if (!pid && main) {
      const nums = (main.url.match(/\d+/g) || []).filter(n => +n !== +vehicleId);
      pid = nums[nums.length - 1] || null;
    }

    let state = here ? 'here' : (canAssign ? (elsewhere ? 'elsewhere' : 'free') : 'none');
    if (state === 'free' && status && !/verfügbar/i.test(status)) state = 'busy'; // z. B. in Ausbildung / im Einsatz

    return {
      pid,
      name: cellName(el) || baseText.slice(0, 40),
      text,
      train: (tcell + ' ' + filterText(el)).trim(),
      trainLabel: tcell,
      status,
      acts,
      state,
      html: el.outerHTML.slice(0, 1200)
    };
  }

  async function readAssignPage(vehicleId) {
    const out = { url: ASSIGN_PAGE(vehicleId), ok: false, rows: [], here: 0, maxHint: null, doc: null };
    try {
      const r = await fetch(out.url, { credentials: 'same-origin' });
      if (!r.ok) { out.error = 'HTTP ' + r.status; return out; }
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      out.doc = doc;
      doc.querySelectorAll('tr, li').forEach(el => {
        const row = parseRow(el, vehicleId);
        if (row) out.rows.push(row);
      });
      out.here = out.rows.filter(x => x.state === 'here').length;
      const t = (doc.body?.textContent || '').replace(/\s+/g, ' ');
      const m = t.match(/(?:Besatzung|Personal)[^\d]{0,30}\d+\s*\/\s*(\d+)/i) || t.match(/max(?:imal)?\.?[^\d]{0,15}(\d+)\s*(?:Personen|Mann|Personal)/i);
      if (m) out.maxHint = parseInt(m[1], 10);
      out.ok = true;
    } catch (e) { out.error = e.message; }
    return out;
  }

  // Einfache Zeilen ohne Aktionen (Personalliste)
  function parsePlainRows(doc) {
    const rows = [];
    doc.querySelectorAll('tr').forEach(tr => {
      if (tr.querySelector('tr') || !tr.querySelector('td')) return;
      const baseText = tr.textContent.replace(/\s+/g, ' ').trim();
      if (!baseText) return;
      const text = (baseText + ' ' + filterText(tr)).trim();
      let pid = (tr.id || '').match(/\d+/)?.[0] || tr.getAttribute('data-personal-id') || tr.getAttribute('data-id') || null;
      let vehicleId = null;
      tr.querySelectorAll('a[href]').forEach(a => {
        const m = (a.getAttribute('href') || '').match(/\/vehicles\/(\d+)/);
        if (m && vehicleId == null) vehicleId = +m[1];
      });
      if (!pid) {
        const a = tr.querySelector('a[href*="personal"]');
        const m = a && (a.getAttribute('href') || '').match(/\d+/g);
        if (m) pid = m[m.length - 1];
      }
      const tcell = trainCell(tr);
      rows.push({ pid, name: cellName(tr) || baseText.slice(0, 40), text, train: (tcell + ' ' + filterText(tr)).trim(), trainLabel: tcell, assigned: !!vehicleCell(tr), vehicleId, html: tr.outerHTML.slice(0, 1200) });
    });
    return rows;
  }

  // Personal einer Wache samt Ausbildungen: Personalseite, sonst Zuweisungsseite eines Fahrzeugs
  async function readPersonnel(buildingId, vehicleId) {
    try {
      const r = await fetch(PERSONALS_PAGE(buildingId), { credentials: 'same-origin' });
      if (r.ok) {
        const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
        const rows = parsePlainRows(doc);
        if (rows.length) return { source: 'Personalseite', rows: rows.map(x => ({ ...x, free: !x.assigned && x.vehicleId == null })) };
      }
    } catch (e) { /* Fallback unten */ }
    if (vehicleId) {
      const p = await readAssignPage(vehicleId);
      if (p.ok && p.rows.length) {
        return { source: 'Zuweisungsseite', rows: p.rows.filter(x => x.state !== 'none').map(x => ({ pid: x.pid, name: x.name, text: x.text, train: x.train, trainLabel: x.trainLabel, vehicleId: null, assigned: x.state !== 'free', free: x.state === 'free' })) };
      }
    }
    return { source: null, rows: [] };
  }

  // ======================================================================
  // Auswahl der Personen (mit Ausbildungen)
  // ======================================================================
  function pickPeople(req, strict, vocab, page, capacity, fill) {
    const hereRows = page.rows.filter(r => r.state === 'here');
    let pool = page.rows.filter(r => r.state === 'free');
    const picks = [];
    const notes = [];
    let lackAny = false;

    // 1) benötigte Ausbildungen abdecken (vorhandene Besatzung zählt mit)
    for (const [name, count] of Object.entries(req)) {
      if (!page.rows.some(r => hasTraining(trainOf(r), name))) {
        notes.push('Ausbildung „' + name + '“ bei niemandem auf der Wache erkennbar');
        lackAny = true;
        continue;
      }
      const have = [...hereRows, ...picks].filter(r => hasTraining(trainOf(r), name)).length;
      let lack = Math.max(0, count - have);
      for (const c of pool.filter(c => hasTraining(trainOf(c), name))) {
        if (!lack || picks.length >= capacity) break;
        picks.push(c);
        pool = pool.filter(x => x !== c);
        lack--;
      }
      if (lack > 0) {
        lackAny = true;
        notes.push('Ausbildung „' + name + '“ fehlt (' + lack + '×)' + (picks.length >= capacity ? ', Fahrzeug voll' : ''));
      }
    }
    if (lackAny && strict) return { picks: [], note: notes.join(', '), skip: true };

    // 2) optional: Rest mit Personen mit möglichst wenigen Spezial-Ausbildungen auffüllen
    if (fill) {
      // "Frei" = Personal ohne Ausbildung. Wer eine Ausbildung hat, ist für ein Fahrzeug reserviert, das sie braucht.
      pool = pool.filter(c => !String(c.trainLabel || '').trim());
      const reqNames = Object.keys(req);
      const special = c => vocab.filter(v => !reqNames.includes(v) && hasTraining(trainOf(c), v)).length;
      pool.sort((a, b) => special(a) - special(b));
      while (picks.length < capacity && pool.length) picks.push(pool.shift());
      if (isFinite(capacity) && picks.length < capacity) notes.push('nur ' + picks.length + ' von ' + capacity + ' freien Plätzen besetzbar');
    }
    return { picks, note: notes.join(', '), skip: false };
  }

  // ======================================================================
  // Zuweisung ausführen
  // ======================================================================
  // Varianten: 'get' = wie ein normaler Klick auf den Link, 'xhr' = GET wie per Ajax, 'post' = POST mit Token
  const VARIANTS = ['get', 'xhr', 'post'];
  let workingVariant = null;

  // Weiterleitungen werden NICHT verfolgt: die Aktion kann gelingen, auch wenn die Zielseite danach 404 liefert
  async function sendAction(a, variant) {
    const headers = { 'X-CSRF-Token': csrf() };
    const opts = { credentials: 'same-origin', headers, redirect: 'manual' };
    if (variant === 'post') {
      opts.method = 'POST';
      const body = a.body ? new URLSearchParams(a.body) : new URLSearchParams();
      body.set('authenticity_token', csrf());
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = body;
    } else {
      opts.method = 'GET';
      if (variant === 'xhr') {
        headers['X-Requested-With'] = 'XMLHttpRequest';
        headers['Accept'] = 'text/javascript, application/javascript, */*; q=0.01';
      }
    }
    const r = await fetch(a.url, opts);
    const redirected = r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400);
    const okish = r.ok || redirected;
    let snippet = '';
    if (!okish) { try { snippet = (await r.text()).replace(/\s+/g, ' ').slice(0, 120); } catch (e) { /* egal */ } }
    return { okish, status: r.status, redirected, snippet };
  }

  // Prüft auf der Zuweisungsseite, ob die Personen jetzt wirklich auf dem Fahrzeug sitzen
  async function verifyPicks(vehicleId, rows) {
    const page = await readAssignPage(vehicleId);
    if (!page.ok) return null;
    const here = new Set(page.rows.filter(r => r.state === 'here').map(r => String(r.pid || r.name)));
    return rows.filter(r => here.has(String(r.pid || r.name)));
  }

  // ======================================================================
  // UI
  // ======================================================================
  function addMenuEntry() {
    if (document.getElementById('lsspz-menu-entry')) return true;
    const notes = [...document.querySelectorAll('.dropdown-menu a')].find(a => {
      const href = a.getAttribute('href') || '';
      return /^\/notes?(\/|\?|$)/.test(href) || a.textContent.trim().toLowerCase().startsWith('notizen');
    });
    if (!notes) return false;
    const li = document.createElement('li');
    li.id = 'lsspz-menu-entry';
    const srcLi = notes.closest('li');
    if (srcLi && srcLi.getAttribute('role')) li.setAttribute('role', srcLi.getAttribute('role'));
    const a = document.createElement('a');
    a.href = '#';
    a.className = notes.className;
    a.textContent = 'Personal zuweisen';
    a.onclick = e => { e.preventDefault(); openPanel(); };
    li.appendChild(a);
    (srcLi || notes).insertAdjacentElement('afterend', li);
    return true;
  }

  function addFloatingButton() {
    const b = document.createElement('button');
    b.textContent = '👥 Personal zuweisen';
    b.style.cssText = 'position:fixed;left:12px;bottom:52px;z-index:9998;padding:8px 12px;border-radius:6px;border:1px solid #777;background:#2c6fbb;color:#fff;cursor:pointer;font-size:13px';
    b.onclick = openPanel;
    document.body.appendChild(b);
  }

  function addButton() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (addMenuEntry()) { clearInterval(timer); return; }
      if (tries >= 10) { clearInterval(timer); addFloatingButton(); }
    }, 500);
  }

  const $ = sel => document.querySelector('#lsspz-panel ' + sel);
  const $$ = sel => [...document.querySelectorAll('#lsspz-panel ' + sel)];
  const log = msg => {
    const el = $('#lsspz-log');
    if (!el) return;
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
  };

  function openPanel() {
    if (document.getElementById('lsspz-panel')) return;
    const p = document.createElement('div');
    p.id = 'lsspz-panel';
    p.style.cssText = 'position:fixed;top:5%;left:8%;right:8%;bottom:5%;z-index:9999;background:#fff;color:#222;border:1px solid #555;border-radius:8px;padding:16px;overflow:auto;font:13px/1.45 sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.5)';
    p.innerHTML = `
      <style>
        #lsspz-panel, #lsspz-panel div, #lsspz-panel table, #lsspz-panel tbody, #lsspz-panel thead, #lsspz-panel tr,
        #lsspz-panel td, #lsspz-panel th, #lsspz-panel label, #lsspz-panel strong, #lsspz-panel em {
          background: #fff !important; color: #222 !important; border-color: #ccc !important;
        }
        #lsspz-panel #lsspz-log, #lsspz-panel #lsspz-dump { background: #f4f4f4 !important; color: #222 !important; }
        #lsspz-panel select, #lsspz-panel input[type=number], #lsspz-panel input[type=text], #lsspz-panel textarea { background: #fff !important; color: #222 !important; }
        #lsspz-panel button { color: #222 !important; }
        #lsspz-panel #lsspz-go { background: #27ae60 !important; color: #fff !important; }
        #lsspz-panel td, #lsspz-panel th { border: 0 !important; padding: 2px 10px 2px 0; vertical-align: top; text-align: left; }
      </style>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <strong style="font-size:16px">Personal nach Ausbildung zuweisen</strong>
        <button id="lsspz-close" style="cursor:pointer">✕ Schließen</button>
      </div>
      <div id="lsspz-status">Lade Daten …</div>
      <div id="lsspz-main" style="display:none">
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin:8px 0">
          <label><strong>1. Leitstelle</strong><br><select id="lsspz-ls" style="min-width:260px"></select></label>
          <label>Modus<br>
            <select id="lsspz-mode">
              <option value="req">Nur benötigte Ausbildungen besetzen</option>
              <option value="fill">Zusätzlich Besatzung mit Personal ohne Ausbildung auffüllen</option>
            </select></label>
          <label>Ziel-Besatzung<br>
            <input type="number" id="lsspz-target" min="1" placeholder="Maximum" style="width:100px"></label>
          <label>Max. Zuweisungen<br><input type="number" id="lsspz-limit" min="1" value="100" style="width:100px"></label>
          <label style="align-self:flex-end"><input type="checkbox" id="lsspz-strict" checked> nur zuweisen, wenn alle Ausbildungen abgedeckt sind</label>
        </div>
        <button id="lsspz-scan" style="cursor:pointer;padding:6px 12px">2. Fahrzeuge scannen</button>
        <button id="lsspz-calc" style="cursor:pointer;padding:6px 12px;margin-left:6px">3. Personal suchen &amp; Plan berechnen</button>
        <button id="lsspz-diag" style="cursor:pointer;padding:6px 12px;margin-left:6px">Diagnose</button>
        <button id="lsspz-abort" style="cursor:pointer;padding:6px 12px;margin-left:6px" disabled>Abbrechen</button>
        <div id="lsspz-req" style="margin-top:12px"></div>
        <div id="lsspz-match" style="margin-top:12px"></div>
        <div id="lsspz-result" style="margin-top:12px"></div>
        <pre id="lsspz-log" style="margin-top:12px;max-height:200px;overflow:auto;padding:8px;border:1px solid #ddd;white-space:pre-wrap"></pre>
        <textarea id="lsspz-dump" readonly style="display:none;width:100%;height:220px;margin-top:8px;font:11px monospace"></textarea>
      </div>`;
    document.body.appendChild(p);
    p.querySelector('#lsspz-close').onclick = () => { if (!busy) p.remove(); else alert('Es läuft noch ein Vorgang – erst abbrechen.'); };
    init();
  }

  const hasLsField = () => buildings.some(b => b.leitstelle_building_id != null);
  const belongsToLs = (b, lsId) => lsId === -1
    ? b.building_type !== 7
    : (hasLsField() ? b.leitstelle_building_id === lsId : true) && b.id !== lsId;

  async function init() {
    try {
      await loadData(true);
    } catch (e) {
      $('#lsspz-status').innerHTML = 'Fehler beim Laden: ' + esc(e.message) +
        ' <button id="lsspz-retry" style="cursor:pointer">Erneut versuchen</button>';
      $('#lsspz-retry').onclick = () => { $('#lsspz-status').textContent = 'Lade Daten …'; init(); };
      return;
    }
    $('#lsspz-status').textContent = 'Lade Fahrzeugtyp-Daten …';
    loadCaches();
    const n = await loadTypeMeta();
    $('#lsspz-status').style.display = 'none';
    $('#lsspz-main').style.display = '';
    if (!n) log('Hinweis: Fahrzeugnamen/Maximalbesatzung nicht von api.lss-manager.de ladbar (Tampermonkey-Abfrage erlauben?). Es geht trotzdem weiter.');

    const leitstellen = buildings.filter(b => b.building_type === 7).sort((a, b) => a.caption.localeCompare(b.caption, 'de'));
    if (!leitstellen.length) {
      $('#lsspz-ls').innerHTML = '<option value="0">(keine Leitstelle gefunden)</option>';
    } else {
      const typeSummary = lsId => {
        const m = {};
        buildings.filter(x => belongsToLs(x, lsId)).forEach(x => { m[x.building_type] = (m[x.building_type] || 0) + 1; });
        return Object.entries(m).sort((a, c) => c[1] - a[1]).slice(0, 3).map(([t, n]) => btName(+t) + ' ×' + n).join(', ');
      };
      $('#lsspz-ls').innerHTML = leitstellen.map(b =>
        `<option value="${b.id}">${esc(b.caption)} (${esc(typeSummary(b.id) || 'keine Gebäude')})</option>`
      ).join('') + '<option value="-1">(alle Leitstellen)</option>';
    }
    if (!hasLsField()) log('Hinweis: Die API liefert keine Leitstellen-Zuordnung (leitstelle_building_id) – es werden alle Gebäude berücksichtigt.');

    $('#lsspz-ls').onchange = () => { lsBuildings = []; reqInfo = {}; personnel = {}; entries = []; plan = []; $('#lsspz-req').innerHTML = ''; $('#lsspz-match').innerHTML = ''; $('#lsspz-result').innerHTML = ''; };
    $('#lsspz-scan').onclick = scan;
    $('#lsspz-calc').onclick = calculate;
    $('#lsspz-diag').onclick = diagnose;
    $('#lsspz-abort').onclick = () => { abort = true; log('Abbruch angefordert …'); };
  }

  function setBusy(flag) {
    busy = flag;
    $('#lsspz-scan').disabled = flag;
    $('#lsspz-calc').disabled = flag;
    $('#lsspz-diag').disabled = flag;
    $('#lsspz-abort').disabled = !flag;
  }

  const selectedLs = () => +$('#lsspz-ls').value || 0;

  function lsVehicles() {
    const ids = new Set(lsBuildings.map(b => b.id));
    return vehicles.filter(v => ids.has(v.building_id));
  }

  // ---------- Schritt 2: Fahrzeuge der Leitstelle scannen ----------
  async function scan() {
    if (busy) return;
    const ls = selectedLs();
    if (!ls) { log('Bitte eine Leitstelle wählen.'); return; }
    setBusy(true); abort = false;
    $('#lsspz-req').textContent = 'Lese Daten …';
    $('#lsspz-match').innerHTML = ''; $('#lsspz-result').innerHTML = '';
    entries = []; plan = []; personnel = {};
    try { await loadData(); } catch (e) { log('Fehler beim Aktualisieren: ' + e.message); }
    if (dataNote) log('Hinweis: ' + dataNote);

    lsBuildings = buildings.filter(b => belongsToLs(b, ls));
    const vehs = lsVehicles();
    if (!vehs.length) {
      $('#lsspz-req').innerHTML = `<em>In dieser Leitstelle wurden keine Fahrzeuge gefunden.</em>
        <div style="color:#777">API-Stand: ${vehicles.length} Fahrzeuge und ${buildings.length} Gebäude insgesamt, ${lsBuildings.length} Gebäude in dieser Leitstelle.
        ${vehicles.length ? (vehicles.length % 1000 === 0 ? 'Die API lieferte genau ' + vehicles.length + ' Fahrzeuge – vermutlich eine Begrenzung, neue Wachen (hohe IDs) fehlen dann. Bitte „Diagnose“ ausführen und das Ergebnis schicken.' : '') : 'Die API hat keine Fahrzeuge geliefert – bitte kurz warten und das Fenster neu öffnen.'}</div>`;
      setBusy(false);
      return;
    }

    // Wachen nach Typ gruppieren; je Gruppe so lange Kaufseiten lesen, bis alle Fahrzeugtypen gefunden sind
    reqInfo = {};
    const groups = new Map();
    for (const b of lsBuildings) {
      const bv = vehs.filter(v => v.building_id === b.id);
      if (!bv.length) continue;
      if (!groups.has(b.building_type)) groups.set(b.building_type, { buildings: [], types: new Set() });
      const g = groups.get(b.building_type);
      g.buildings.push({ b, n: bv.length });
      bv.forEach(v => g.types.add(String(v.vehicle_type)));
    }

    let gi = 0;
    for (const [btype, g] of groups) {
      if (abort) break;
      gi++;
      g.buildings.sort((a, c) => c.n - a.n);
      const missing = new Set(g.types);
      let tries = 0;
      for (const { b } of g.buildings) {
        if (abort || !missing.size || tries >= MAX_BUY_PAGES_PER_GROUP) break;
        $('#lsspz-req').textContent = `Lese Kaufseite ${btName(btype)} (${gi}/${groups.size}): ${b.caption} …`;
        const page = await readBuyPage(b.id);
        tries++;
        await sleep(PAGE_DELAY);
        if (!page.ok) { log('Kaufseite ' + b.caption + ' nicht lesbar: ' + page.error); continue; }
        for (const [t, info] of Object.entries(page.types)) {
          if (!reqInfo[t] || (!Object.keys(reqInfo[t].req).length && Object.keys(info.req).length)) {
            reqInfo[t] = { req: info.req, raw: info.raw, name: info.name, max: info.max, text: info.text };
          }
          missing.delete(t);
        }
      }
    }

    setBusy(false);
    if (abort) log('Scan abgebrochen.');
    renderReqTable();
  }

  function renderReqTable() {
    const vehs = lsVehicles();
    const counts = {};
    vehs.forEach(v => { counts[v.vehicle_type] = (counts[v.vehicle_type] || 0) + 1; });
    const types = Object.keys(counts).sort((a, b) => nm(a).localeCompare(nm(b), 'de'));

    let withReq = 0, notFound = 0;
    const rows = types.map(t => {
      const r = reqFor(t);
      const info = reqInfo[t];
      if (Object.keys(r.req).length) withReq++;
      if (!info && !hasOverride(t)) notFound++;
      const src = hasOverride(t) ? 'manuell' : (info ? (Object.keys(info.req).length ? 'Kaufseite' : 'Kaufseite: keine Anforderung erkannt') : 'nicht auf Kaufseite gefunden');
      return `<tr>
        <td>${esc(nm(t))} <span style="color:#999">#${t}</span></td>
        <td style="text-align:right">${counts[t]}×</td>
        <td><input type="text" data-type="${t}" value="${esc(reqToString(r.req))}" placeholder="z. B. Notarzt, Atemschutz:2" style="width:320px"></td>
        <td style="color:#777">${esc(src)}${info?.raw ? ' – „' + esc(info.raw.slice(0, 80)) + '“' : ''}</td>
        <td>${hasOverride(t) ? `<button data-reset="${t}" style="cursor:pointer" title="Auf Wert der Kaufseite zurücksetzen">↺</button>` : ''}</td></tr>`;
    }).join('');

    $('#lsspz-req').innerHTML = `
      <strong>Benötigte Ausbildungen je Fahrzeugtyp</strong>
      <span style="color:#777"> – ${vehs.length} Fahrzeuge in ${lsBuildings.length} Gebäuden, ${types.length} Typen, ${withReq} mit Anforderung${notFound ? `, ${notFound} nicht auf einer Kaufseite gefunden` : ''}.
      Anpassbar: „Name:Anzahl“, mit Komma getrennt; leer = keine Anforderung.</span>
      <table style="border-collapse:collapse;margin-top:4px">
        <tr><th>Fahrzeugtyp</th><th>Anzahl</th><th>Benötigte Ausbildung</th><th>Quelle</th><th></th></tr>${rows}</table>`;
    $$('#lsspz-req input[data-type]').forEach(inp => {
      inp.onchange = () => { overrides[inp.dataset.type] = inp.value; saveOverrides(); renderReqTable(); };
    });
    $$('#lsspz-req button[data-reset]').forEach(btn => {
      btn.onclick = () => { delete overrides[btn.dataset.reset]; saveOverrides(); renderReqTable(); };
    });
  }

  // ---------- Schritt 3: Personal suchen, abgleichen, Plan berechnen ----------
  function renderMatch() {
    const lines = [];
    for (const b of lsBuildings) {
      const need = {};
      vehicles.filter(v => v.building_id === b.id).forEach(v => {
        Object.entries(reqFor(v.vehicle_type).req).forEach(([t, c]) => { need[t] = (need[t] || 0) + c; });
      });
      const names = Object.keys(need);
      if (!names.length) continue;
      const pers = personnel[b.id];
      const untrained = pers ? pers.rows.filter(r => !String(r.trainLabel || '').trim()).length : 0;
      const trained = pers ? pers.rows.length - untrained : 0;
      const apiCnt = num(b.personal_count);
      const cells = names.sort((a, c) => a.localeCompare(c, 'de')).map(t => {
        const haveRows = pers ? pers.rows.filter(r => hasTraining(trainOf(r), t)) : [];
        const have = haveRows.length;
        const haveFree = haveRows.filter(r => r.free).length;
        const short = need[t] > have;
        return `<span style="margin-right:14px;${short ? 'color:#b00 !important;font-weight:bold' : ''}">${esc(t)} Bedarf ${need[t]} / vorhanden ${have} (davon noch auf keinem Fahrzeug ${haveFree})</span>`;
      }).join('');
      lines.push(`<tr><td><strong>${esc(b.caption)}</strong></td>
        <td style="color:#777">${pers && pers.source ? `${pers.rows.length} Pers.${apiCnt != null ? ` (API: ${apiCnt}${apiCnt !== pers.rows.length ? ' ⚠' : ''})` : ''}: ${untrained} ohne Ausbildung (frei), ${trained} mit Ausbildung (reserviert)` : '<span style="color:#b00">Personal nicht lesbar</span>'}</td>
        <td>${cells}</td></tr>`);
    }
    // Welche Ausbildungsnamen stehen tatsächlich in den Personallisten?
    const known = {};
    Object.values(personnel).forEach(pers => (pers.rows || []).forEach(r => {
      String(r.trainLabel || '').split(/[,;]/).map(x => x.trim()).filter(Boolean).forEach(x => { known[x] = (known[x] || 0) + 1; });
    }));
    const knownTxt = Object.entries(known).sort((a, c) => c[1] - a[1]).slice(0, 40).map(([k, n]) => `${esc(k)} ×${n}`).join(', ');
    $('#lsspz-match').innerHTML = lines.length
      ? `<strong>Abgleich je Wache: Ausbildung Bedarf / vorhanden</strong>
         <table style="border-collapse:collapse;margin-top:4px">${lines.join('')}</table>
         <div style="color:#777;margin-top:6px"><strong>Ausbildungen laut Personalliste:</strong> ${knownTxt || '–'}<br>
         Steht eine benötigte Ausbildung dort unter anderem Namen, den Namen oben bei „Benötigte Ausbildung“ entsprechend anpassen.</div>`
      : '<em>Für die Fahrzeuge dieser Leitstelle sind keine Ausbildungs-Anforderungen bekannt.</em>';
  }

  async function calculate() {
    if (busy) return;
    if (!lsBuildings.length) { log('Bitte zuerst „2. Fahrzeuge scannen“ ausführen.'); return; }
    const override = parseInt($('#lsspz-target').value, 10) || null;
    const strict = $('#lsspz-strict').checked;
    const fill = $('#lsspz-mode').value === 'fill';
    setBusy(true); abort = false;
    $('#lsspz-dump').style.display = 'none';
    $('#lsspz-result').textContent = 'Berechne …';

    try { await loadData(); } catch (e) { log('Fehler beim Aktualisieren: ' + e.message); }
    lsBuildings = buildings.filter(b => belongsToLs(b, selectedLs()));

    entries = [];
    personnel = {};
    const vocab = buildVocab();
    const reqOf = v => reqFor(v.vehicle_type).req;
    const nameKey = n => norm(n);

    // Wachen mit relevanten Fahrzeugen (im Modus "nur Ausbildungen": nur Fahrzeuge mit Anforderung)
    const work = [];
    for (const b of lsBuildings) {
      const list = vehicles.filter(v => v.building_id === b.id && (fill || Object.keys(reqOf(v)).length))
        .sort((a, c) => Object.keys(reqOf(c)).length - Object.keys(reqOf(a)).length);
      if (list.length) work.push({ b, list });
    }
    const total = work.reduce((s, w) => s + w.list.length, 0);
    lastCheck = { vehicles: total, buildings: work.length, inLs: lsBuildings.length };
    let i = 0;

    for (const { b, list } of work) {
      if (abort) break;
      $('#lsspz-result').textContent = 'Lese Personal von ' + b.caption + ' …';
      const pers = await readPersonnel(b.id, list[0]?.id);
      personnel[b.id] = pers;
      await sleep(PAGE_DELAY);

      const byPid = new Map(), byName = new Map();
      if (pers.source === 'Personalseite') {
        pers.rows.forEach(r => { const v = { train: r.train || '', label: r.trainLabel || '' }; if (r.pid) byPid.set(String(r.pid), v); byName.set(nameKey(r.name), v); });
      }
      const used = new Set(); // in der Vorschau schon vergebene Personen dieser Wache

      for (const v of list) {
        if (abort) break;
        i++;
        $('#lsspz-result').textContent = `Prüfe Fahrzeug ${i}/${total} (${b.caption}) …`;
        const label = nm(v.vehicle_type, v.vehicle_type_caption) + ' ' + (v.caption || '');
        const req = reqOf(v);
        const apiAssigned = num(v.assigned_personnel_count);
        const target = override ?? num(v.max_personnel_override) ?? num(typeMax[v.vehicle_type]) ?? reqInfo[v.vehicle_type]?.max ?? null;

        const page = await readAssignPage(v.id);
        await sleep(PAGE_DELAY);
        const e = { b, v, label, req, apiAssigned, assigned: apiAssigned ?? page.here, target: target ?? page.maxHint, picks: [], note: '' };

        if (!page.ok) { e.note = 'Seite nicht lesbar (' + page.error + ')'; entries.push(e); continue; }
        if (e.target == null && fill) { e.note = 'Sollstärke unbekannt – Feld „Ziel-Besatzung“ ausfüllen'; entries.push(e); continue; }
        const capacity = e.target != null ? Math.max(0, e.target - e.assigned) : Infinity;

        // Ausbildungstext ergänzen und bereits vergebene Personen sperren
        const rows = page.rows.map(r => {
          const ex = byPid.get(String(r.pid)) || byName.get(nameKey(r.name)) || null;
          const train = r.train && r.train.trim() ? r.train : (ex?.train || '');
          const trainLabel = r.trainLabel || ex?.label || '';
          const state = r.state === 'free' && used.has(r.pid || r.name) ? 'taken' : r.state;
          return { ...r, train, trainLabel, state };
        });
        const res = pickPeople(req, strict, vocab, { ...page, rows }, capacity, fill);
        e.picks = res.picks; e.note = res.note;
        res.picks.forEach(r => used.add(r.pid || r.name));
        if (e.picks.length || e.note) entries.push(e);
      }
    }

    setBusy(false);
    if (abort) log('Berechnung abgebrochen.');
    renderMatch();
    renderResult();
  }

  function renderResult() {
    const limit = Math.max(1, parseInt($('#lsspz-limit').value, 10) || 1);
    plan = [];
    entries.forEach(e => e.picks.forEach(row => plan.push({ e, row })));
    const possible = plan.length;
    if (plan.length > limit) plan = plan.slice(0, limit);

    if (!entries.length) {
      $('#lsspz-result').innerHTML = `<em>Nichts zuzuweisen.</em>
        <div style="color:#777">Geprüft: ${lastCheck.vehicles} Fahrzeuge in ${lastCheck.buildings} von ${lastCheck.inLs} Gebäuden.
        ${lastCheck.vehicles ? 'Alle diese Fahrzeuge sind passend besetzt.' : 'Es gibt keine Fahrzeuge mit Ausbildungs-Anforderung (Tabelle oben prüfen) – im Modus „auffüllen“ werden alle Fahrzeuge geprüft.'}</div>`;
      return;
    }
    const lines = entries.map(e => `<tr>
      <td><strong>${esc(e.b.caption)}</strong></td>
      <td>${esc(e.label)}</td>
      <td>${esc(reqToString(e.req) || '–')}</td>
      <td>${e.assigned}/${e.target ?? '?'}</td>
      <td>${e.picks.length ? '+' + e.picks.length : '–'}</td>
      <td style="color:#b00">${esc(e.note)}</td></tr>`).join('');

    $('#lsspz-result').innerHTML = `
      <strong>Plan</strong>
      <table style="border-collapse:collapse;margin-top:4px">
        <tr><th>Wache</th><th>Fahrzeug</th><th>Benötigt</th><th>Besatzung</th><th>Zuweisen</th><th>Hinweis</th></tr>
        ${lines}
      </table>
      <div style="margin-top:8px"><strong>${plan.length}</strong> Zuweisungen in dieser Liste${possible > plan.length ? ` (von ${possible} möglichen)` : ''}.</div>
      <div style="margin-top:10px">${plan.length ? '<button id="lsspz-go" style="cursor:pointer;padding:6px 12px;border:0;border-radius:4px">Jetzt zuweisen</button>' : ''}</div>`;
    if (plan.length) $('#lsspz-go').onclick = startAssigning;
  }

  // Untersucht die Fahrzeug-API (Endpunkte, Begrenzung, Seiten) für die Diagnose
  async function probeVehicleApi() {
    const out = { kandidaten: [], paging: [] };
    const probeOne = async (url, withHeaders) => {
      const res = { url };
      try {
        const r = await fetch(url, { credentials: 'same-origin' });
        res.status = r.status;
        if (withHeaders) {
          const hdr = {};
          r.headers.forEach((v, k) => { if (/total|page|link|limit|count|next|rate|retry/i.test(k)) hdr[k] = v; });
          res.headers = hdr; res.contentType = r.headers.get('content-type');
        }
        if (r.ok) {
          const j = await r.json();
          res.isArray = Array.isArray(j);
          if (!res.isArray && j && typeof j === 'object') res.keys = Object.keys(j).slice(0, 15);
          const l = unwrapList(j);
          if (l) {
            res.length = l.length;
            res.firstId = l[0]?.id;
            res.lastId = l[l.length - 1]?.id;
            res.maxId = l.reduce((m, x) => Math.max(m, x.id || 0), 0);
          }
        }
      } catch (e) { res.error = e.message; }
      return res;
    };
    for (const url of [...new Set([...API_CANDIDATES.vehicles, '/api/v2/vehicles', '/api2/vehicles'])]) {
      out.kandidaten.push(await probeOne(url, true));
      await sleep(400);
    }
    const base = API_CANDIDATES.vehicles[0];
    const n = vehicles.length;
    for (const u of [base + '?page=2', base + '?offset=' + n, base + '?start=' + n]) {
      out.paging.push(await probeOne(u, false));
      await sleep(400);
    }
    out.imSpeicher = { fahrzeuge: vehicles.length, gebaeude: buildings.length, hoechsteFahrzeugId: vehicles.reduce((m, x) => Math.max(m, x.id || 0), 0) };
    return out;
  }

  // Untersucht mögliche Kaufseiten einer Wache (für die Diagnose)
  async function probeBuyPages(buildingId) {
    const urls = [...new Set([
      ...BUY_PAGES.map(mk => mk(buildingId)),
      '/buildings/' + buildingId + '/vehicles',
      '/buildings/' + buildingId + '/vehicle/new'
    ])];
    const results = [];
    for (const u of urls) {
      const res = { url: u };
      try {
        const r = await fetch(u, { credentials: 'same-origin' });
        res.status = r.status;
        const html = await r.text();
        res.length = html.length;
        if (r.ok) {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          res.buyLinks = [...doc.querySelectorAll('a[href]')].filter(a => BUY_RE.test(a.getAttribute('href') || '')).length;
          const idx = html.search(/credits/i);
          res.creditsSnippet = idx >= 0 ? html.slice(Math.max(0, idx - 500), idx + 500) : null;
          const hints = new Set();
          doc.querySelectorAll('a[href],[data-url],[data-href],form[action]').forEach(n => {
            const v = n.getAttribute('href') || n.getAttribute('data-url') || n.getAttribute('data-href') || n.getAttribute('action') || '';
            if (/vehicle|credits|coins|buy|kauf|new/i.test(v)) hints.add(v);
          });
          res.hrefHints = [...hints].slice(0, 25);
          res.tabs = [...doc.querySelectorAll('[data-toggle="tab"],.nav-tabs a')].map(a => ({
            text: a.textContent.replace(/\s+/g, ' ').trim().slice(0, 40),
            href: a.getAttribute('href') || a.getAttribute('data-url') || ''
          })).slice(0, 15);
          const urlsInScripts = html.match(/['"]\/buildings\/[^'"\s]*['"]/g) || [];
          res.scriptUrls = [...new Set(urlsInScripts)].slice(0, 30);
        }
      } catch (e) { res.error = e.message; }
      results.push(res);
      await sleep(PAGE_DELAY);
    }
    return results;
  }

  // ---------- Diagnose ----------
  // Kompakte Diagnose für eine Wache (für alle weiteren Wachentypen)
  async function diagCompact(b) {
    const v = vehicles.find(x => x.building_id === b.id);
    const out = { wacheTyp: btName(b.building_type), wache: b.caption, building_type: b.building_type };
    delete buyCache[b.id];
    const buy = await readBuyPage(b.id);
    out.kaufseite = {
      gefunden: buy.ok, verwendeteUrl: buy.url || null, tried: buy.tried,
      typesFound: Object.keys(buy.types).length,
      withRequirement: Object.values(buy.types).filter(i => Object.keys(i.req).length).length,
      sample: Object.entries(buy.types).slice(0, 3).map(([t, i]) => ({ type: t, name: i.name, req: i.req, raw: i.raw, text: i.text.slice(0, 300) }))
    };
    if (!buy.ok) out.kaufseite.probe = await probeBuyPages(b.id);
    await sleep(PAGE_DELAY);
    if (v) {
      const page = await readAssignPage(v.id);
      const firstAssign = page.rows.find(r => r.state === 'free');
      out.zuweisungsseite = {
        ok: page.ok, error: page.error || null, rowsFound: page.rows.length,
        states: page.rows.reduce((m, r) => { m[r.state] = (m[r.state] || 0) + 1; return m; }, {}),
        sampleFreeRow: firstAssign ? { text: firstAssign.text.slice(0, 150), acts: firstAssign.acts.map(x => ({ kind: x.kind, method: x.method, url: x.url })) } : null,
        fallbackHtml: page.rows.length ? null : (page.doc?.body?.innerHTML || '').slice(0, 1500)
      };
      await sleep(PAGE_DELAY);
    }
    try {
      const r = await fetch(PERSONALS_PAGE(b.id), { credentials: 'same-origin' });
      out.personalseite = { status: r.status };
      if (r.ok) {
        const rows = parsePlainRows(new DOMParser().parseFromString(await r.text(), 'text/html'));
        out.personalseite.rowsFound = rows.length;
        out.personalseite.sample = rows.slice(0, 2).map(x => x.text.slice(0, 150));
        out.personalseite.mitAusbildungstext = rows.filter(x => x.text.length > x.name.length + 15).length;
      }
    } catch (e) { out.personalseite = { error: e.message }; }
    return out;
  }

  async function diagnose() {
    if (busy) return;
    setBusy(true); abort = false;
    try { await loadData(); } catch (e) { /* weiter mit altem Stand */ }
    // unabhängig von der Auswahl: alle Leitstellen, je Wachentyp eine Wache
    const bs = buildings.filter(b => b.building_type !== 7);
    const withVeh = bs.filter(x => vehicles.some(v => v.building_id === x.id));
    if (!withVeh.length) { log('Keine Wache mit Fahrzeugen gefunden.'); setBusy(false); return; }

    // je Wachentyp eine Wache (die mit den meisten Fahrzeugen)
    const perType = new Map();
    withVeh.forEach(x => {
      const n = vehicles.filter(v => v.building_id === x.id).length;
      const cur = perType.get(x.building_type);
      if (!cur || n > cur.n) perType.set(x.building_type, { b: x, n });
    });
    const typeList = [...perType.entries()].sort((a, c) => a[0] - c[0]);
    log(`Diagnose über alle Leitstellen: ${typeList.length} Wachentypen (${typeList.map(([t]) => btName(t)).join(', ')}) …`);

    // Hauptwache (erster Typ) mit voller Detailtiefe
    const b = typeList[0][1].b;
    const v = vehicles.find(x => x.building_id === b.id);
    log('Diagnose: ' + btName(b.building_type) + ' „' + b.caption + '“ (Detail) …');
    delete buyCache[b.id];
    const buy = await readBuyPage(b.id);
    const probe = await probeBuyPages(b.id);
    const buyDump = {
      gefunden: buy.ok, verwendeteUrl: buy.url || null, tried: buy.tried,
      typesFound: Object.keys(buy.types).length,
      withRequirement: Object.values(buy.types).filter(i => Object.keys(i.req).length).length,
      sample: Object.entries(buy.types).slice(0, 4).map(([t, i]) => ({ type: t, name: i.name, req: i.req, raw: i.raw, text: i.text, html: i.html })),
      probe
    };

    let assignDump = null;
    if (v) {
      const page = await readAssignPage(v.id);
      assignDump = {
        url: page.url, ok: page.ok, error: page.error || null, rowsFound: page.rows.length,
        states: page.rows.reduce((m, r) => { m[r.state] = (m[r.state] || 0) + 1; return m; }, {}),
        maxHint: page.maxHint,
        sampleRows: page.rows.filter(r => r.state !== 'none').slice(0, 2).map(r => ({
          pid: r.pid, state: r.state, text: r.text.slice(0, 200),
          acts: r.acts.map(a => ({ kind: a.kind, method: a.method, url: a.url, label: a.label.slice(0, 80) })),
          html: r.html
        })),
        fallbackHtml: page.rows.length ? null : (page.doc?.body?.innerHTML || '').slice(0, 3000)
      };
      await sleep(PAGE_DELAY);
    }

    const personals = { url: PERSONALS_PAGE(b.id) };
    try {
      const r = await fetch(personals.url, { credentials: 'same-origin' });
      personals.status = r.status;
      if (r.ok) {
        const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
        const rows = parsePlainRows(doc);
        personals.rowsFound = rows.length;
        personals.sampleRows = rows.slice(0, 2).map(x => ({ pid: x.pid, vehicleId: x.vehicleId, text: x.text.slice(0, 250), html: x.html }));
        if (!rows.length) personals.fallbackHtml = (doc.body?.innerHTML || '').slice(0, 2500);
      }
    } catch (e) { personals.error = e.message; }

    // alle weiteren Wachentypen kompakt
    const others = [];
    for (const [, { b: ob }] of typeList.slice(1)) {
      if (abort) break;
      log('Diagnose: ' + btName(ob.building_type) + ' „' + ob.caption + '“ …');
      others.push(await diagCompact(ob));
      await sleep(PAGE_DELAY);
    }

    const apiDump = await probeVehicleApi();
    // Gebäude der gewählten Leitstelle ohne Fahrzeuge in der API: Fahrzeugliste auf der Gebäudeseite ansehen
    let gebaeudeOhneApiFahrzeuge = null;
    const selLs = selectedLs();
    const lbld = selLs ? buildings.find(x => belongsToLs(x, selLs) && !vehicles.some(v => v.building_id === x.id)) : null;
    if (lbld) {
      gebaeudeOhneApiFahrzeuge = { id: lbld.id, caption: lbld.caption, building_type: lbld.building_type };
      try {
        const r = await fetch(BUILDING_PAGE(lbld.id), { credentials: 'same-origin' });
        gebaeudeOhneApiFahrzeuge.status = r.status;
        if (r.ok) {
          const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
          const links = [...doc.querySelectorAll('a[href]')].filter(a => /^\/vehicles\/\d+$/.test(a.getAttribute('href') || ''));
          gebaeudeOhneApiFahrzeuge.fahrzeugLinks = links.length;
          gebaeudeOhneApiFahrzeuge.sample = links.slice(0, 2).map(a => ({ href: a.getAttribute('href'), row: (a.closest('tr') || a.parentElement).outerHTML.slice(0, 800) }));
        }
      } catch (e) { gebaeudeOhneApiFahrzeuge.error = e.message; }
    }

    const dump = {
      api: apiDump,
      gebaeudeOhneApiFahrzeuge,
      leitstellen: buildings.filter(x => x.building_type === 7).map(l => {
        const m = {};
        buildings.filter(x => belongsToLs(x, l.id)).forEach(x => { m[btName(x.building_type)] = (m[btName(x.building_type)] || 0) + 1; });
        return { id: l.id, caption: l.caption, wachen: m };
      }),
      apiFeldHatLsZuordnung: hasLsField(),
      wachentypen: typeList.map(([t, x]) => ({ typ: btName(t), id: t, beispiel: x.b.caption, beispielLeitstelle: x.b.leitstelle_building_id })),
      hauptwache: {
        wache: { id: b.id, caption: b.caption, building_type: b.building_type },
        fahrzeug: v ? { vehicle_type: v.vehicle_type, assigned_personnel_count: v.assigned_personnel_count, max_personnel_override: v.max_personnel_override } : null,
        kaufseite: buyDump,
        zuweisungsseite: assignDump,
        personalseite: personals
      },
      weitereWachentypen: others
    };
    const ta = $('#lsspz-dump');
    ta.style.display = '';
    ta.value = JSON.stringify(dump, null, 1);
    const summary = [buyDump, ...others.map(o => o.kaufseite)].map(k => `${k.typesFound} Typen/${k.withRequirement} mit Anforderung`).join(' | ');
    log(`Diagnose fertig (${typeList.length} Wachentypen). Kaufseiten: ${summary}. Der Text unten kann kopiert werden.`);
    setBusy(false);
  }

  // ---------- Zuweisen ----------
  async function startAssigning() {
    if (busy || !plan.length) return;
    const vehCount = new Set(plan.map(p => p.e.v.id)).size;
    const bldCount = new Set(plan.map(p => p.e.b.id)).size;
    if (!confirm(`${plan.length} Personen zuweisen?\n(${vehCount} Fahrzeuge in ${bldCount} Wachen)`)) return;

    setBusy(true); abort = false;
    $('#lsspz-go').disabled = true;

    // nach Fahrzeug gruppieren (Reihenfolge bleibt)
    const groups = new Map();
    plan.forEach(p => {
      if (!groups.has(p.e.v.id)) groups.set(p.e.v.id, { e: p.e, rows: [] });
      groups.get(p.e.v.id).rows.push(p.row);
    });

    let vi = 0, verifiedTotal = 0, sentTotal = 0, failsInRow = 0;
    const unknownTotal = { n: 0 };
    log(`Starte Zuweisung von ${plan.length} Personen auf ${groups.size} Fahrzeuge (jede Zuweisung wird anschließend geprüft) …`);

    for (const [vid, g] of groups) {
      if (abort) { log('Abgebrochen.'); break; }
      vi++;
      const tag = `[${vi}/${groups.size}] ${g.e.label} (${g.e.b.caption})`;
      let remaining = g.rows.slice();
      const variants = workingVariant ? [workingVariant] : VARIANTS.slice();
      const attempts = [];

      for (const variant of variants) {
        if (abort || !remaining.length) break;
        const infos = [];
        for (const row of remaining) {
          if (abort) break;
          const act = row.acts.find(x => x.kind === 'assign');
          try {
            const res = await sendAction(act, variant);
            sentTotal++;
            infos.push(res.status + (res.redirected ? ' (Weiterleitung)' : '') + (res.snippet ? ' „' + res.snippet + '“' : ''));
          } catch (err) { infos.push('Fehler ' + err.message); }
          await sleep(rndDelay());
        }
        const ok = await verifyPicks(vid, remaining);
        attempts.push(`${variant}: ${[...new Set(infos)].join(', ')}`);
        if (ok === null) { unknownTotal.n += remaining.length; log(tag + ': gesendet (' + variant + '), Prüfung nicht möglich'); remaining = []; break; }
        if (ok.length) {
          workingVariant = variant;
          verifiedTotal += ok.length;
          remaining = remaining.filter(r => !ok.includes(r));
          log(`${tag}: ${ok.length} zugewiesen und bestätigt (Variante „${variant}“)` + (remaining.length ? `, ${remaining.length} nicht angekommen` : ''));
          break;
        }
      }

      if (remaining.length && !abort) {
        failsInRow++;
        log(`${tag}: NICHT angekommen (${remaining.map(r => r.name).join(', ')}). Versuche: ${attempts.join(' | ')}`);
        if (!workingVariant && vi === 1) {
          log('Keine Variante funktioniert – Abbruch. Bitte die Zeilen oben schicken (Statuscodes), dann passe ich die Zuweisung an.');
          break;
        }
        if (failsInRow >= MAX_FAILS_IN_ROW) { log(`Abbruch: ${MAX_FAILS_IN_ROW} Fahrzeuge hintereinander ohne Erfolg.`); break; }
      } else if (!remaining.length) {
        failsInRow = 0;
      }
    }

    log(`Fertig. Bestätigt zugewiesen: ${verifiedTotal}` + (unknownTotal.n ? `, ungeprüft: ${unknownTotal.n}` : '') + `, gesendete Anfragen: ${sentTotal}.`);

    // frischen Stand übernehmen
    try {
      const after = await getList('vehicles');
      if (after.length) { vehicles = after; lastLoad = Date.now(); }
    } catch (err) { /* egal */ }

    setBusy(false);
    plan = []; entries = [];
    $('#lsspz-result').innerHTML = '<em>Neu berechnen für aktuellen Stand.</em>';
  }

  addButton();
})();
