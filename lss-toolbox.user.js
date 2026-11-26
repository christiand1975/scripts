// ==UserScript==
// @name         LSS Toolbox
// @namespace    lss-toolbox
// @version      2.3.1
// @description  Bündelt mehrere Leitstellenspiel-Helfer als einzeln schaltbare Module (Fahrzeug-Abgleich, Ausbildungscheck, Personal-Übersicht, MissionShare, Maasenausbau, Lehrgangszuweiser)
// @match        https://www.leitstellenspiel.de/*
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/christiand1975/scripts/main/lss-toolbox.user.js
// @downloadURL  https://raw.githubusercontent.com/christiand1975/scripts/main/lss-toolbox.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ======================================================================
    // KONFIGURATION – hier deine Werte eintragen
    // ======================================================================
    const VERSION = '2.3.1';      // muss zur @version im Header passen
    const CONFIG = {
        // Adresse der veröffentlichten .user.js, z. B.
        // 'https://raw.githubusercontent.com/DEINNAME/lss-toolbox/main/lss-toolbox.user.js'
        // Gesetzt: Toolbox meldet im Panel, wenn dort eine neuere @version liegt. '' = aus.
        updateUrl: 'https://raw.githubusercontent.com/christiand1975/scripts/main/lss-toolbox.user.js',
    };

    // ======================================================================
    // KERN: Registry, Einstellungen, Kontext pro Modul, Steuer-UI
    // ======================================================================
    const PREFIX = 'lsstb';
    const IS_TOP = window.top === window;      // Steuer-UI nur im Hauptfenster, Module laufen auch in iFrames
    const modules = [];
    const running = new Map();                 // id -> { ctx, cleanups, instance }

    // Einstellungen im localStorage (gilt für alle Frames derselben Domain)
    const store = {
        get(key, def) {
            try {
                const raw = localStorage.getItem(`${PREFIX}.${key}`);
                return raw === null ? def : JSON.parse(raw);
            } catch (e) { return def; }
        },
        set(key, val) {
            try { localStorage.setItem(`${PREFIX}.${key}`, JSON.stringify(val)); } catch (e) { /* ignorieren */ }
        },
    };

    const isEnabled = mod => store.get('enabled.' + mod.id, mod.defaultEnabled !== false);

    // Jedes Modul bekommt einen eigenen Kontext. Alles, was darüber registriert wird
    // (Listener, Timer, Styles), wird beim Ausschalten automatisch wieder entfernt..
    function createContext(mod) {
        const cleanups = [];
        const tag = `[LSS-Toolbox:${mod.id}]`;
        const ctx = {
            id: mod.id,
            log:   (...a) => console.log(tag, ...a),
            warn:  (...a) => console.warn(tag, ...a),
            error: (...a) => console.error(tag, ...a),

            // modul-eigene Einstellungen
            get: (key, def) => store.get(`${mod.id}.${key}`, def),
            set: (key, val) => store.set(`${mod.id}.${key}`, val),

            // Aufräum-Helfer
            onCleanup(fn) { cleanups.push(fn); },
            on(target, type, handler, opts) {
                target.addEventListener(type, handler, opts);
                cleanups.push(() => target.removeEventListener(type, handler, opts));
            },
            interval(fn, ms) {
                const t = setInterval(fn, ms);
                cleanups.push(() => clearInterval(t));
                return t;
            },
            addStyle(css) {
                const s = document.createElement('style');
                s.textContent = css;
                (document.head || document.documentElement).appendChild(s);
                cleanups.push(() => s.remove());
                return s;
            },
        };
        return { ctx, cleanups };
    }

    function startModule(mod) {
        if (running.has(mod.id)) return;
        try { if (mod.match && !mod.match(location)) return; }
        catch (e) { console.error('[LSS-Toolbox] match-Fehler in', mod.id, e); return; }

        const { ctx, cleanups } = createContext(mod);
        const entry = { ctx, cleanups, instance: null };
        running.set(mod.id, entry);
        try {
            entry.instance = mod.init(ctx);
            ctx.log('gestartet');
        } catch (e) {
            ctx.error('Fehler beim Start:', e);
            stopModule(mod);   // schon Registriertes wieder aufräumen
        }
    }

    function stopModule(mod) {
        const entry = running.get(mod.id);
        if (!entry) return;
        running.delete(mod.id);
        try { if (typeof mod.destroy === 'function') mod.destroy(entry.instance, entry.ctx); }
        catch (e) { entry.ctx.error('Fehler in destroy():', e); }
        while (entry.cleanups.length) {
            try { entry.cleanups.pop()(); } catch (e) { entry.ctx.error('Fehler beim Aufräumen:', e); }
        }
        entry.ctx.log('gestoppt');
    }

    function register(mod) {
        if (!mod || !mod.id || typeof mod.init !== 'function') {
            console.error('[LSS-Toolbox] Ungültiges Modul', mod);
            return;
        }
        modules.push(mod);
    }

    // Schalter, die in einem anderen Frame/Tab umgelegt wurden, auch hier übernehmen
    window.addEventListener('storage', e => {
        const key = `${PREFIX}.enabled.`;
        if (!e.key || !e.key.startsWith(key)) return;
        const mod = modules.find(m => m.id === e.key.slice(key.length));
        if (!mod) return;
        isEnabled(mod) ? startModule(mod) : stopModule(mod);
    });

    // ----------------------------------------------------------------------
    // Steuer-UI: nur als Eintrag im Spielmenü (direkt unter "Notizen").
    // Nichts schwebt auf der Seite; das Panel öffnet sich erst per Klick auf den Menüeintrag.
    // ----------------------------------------------------------------------
    const panelApi = {};
    let updateRemote = null;
    const menuLabel = () => (updateRemote ? '🛠 Toolbox ⬆' : '🛠 Toolbox');

    function findNotesLink() {
        const byHref = document.querySelector('a[href="/note"], a[href="/notes"], a[href^="/note?"]');
        if (byHref && !byHref.closest('#lsstb-overlay')) return byHref;
        return [...document.querySelectorAll('nav a, .navbar a, .dropdown-menu a')]
            .find(a => /\bNotizen\b/.test(a.textContent) && a.id !== 'lsstb-menu-link' && !a.closest('#lsstb-overlay')) || null;
    }

    function ensureMenuItem() {
        if (document.getElementById('lsstb-menu-link')) return true;
        const notes = findNotesLink();
        if (!notes) return false;

        const link = document.createElement('a');
        link.id = 'lsstb-menu-link';
        link.href = '#';
        // Klassen des Notizen-Eintrags übernehmen (gleiches Aussehen), aber nicht die Lightbox-Klassen des Spiels
        link.className = [...notes.classList].filter(c => !/lightbox/i.test(c)).join(' ');
        link.textContent = menuLabel();
        link.addEventListener('click', e => {
            e.preventDefault();
            if (panelApi.open) panelApi.open();
        });

        const noteLi = notes.closest('li');
        if (noteLi) {
            const li = noteLi.cloneNode(false);
            li.id = 'lsstb-menu-item';
            li.append(link);
            noteLi.after(li);
        } else {
            notes.after(link);
        }
        return true;
    }

    function buildUI() {
        const style = document.createElement('style');
        style.textContent = `
            #lsstb-overlay { position:fixed; top:0; right:0; bottom:0; left:0; z-index:99999;
                background:rgba(0,0,0,.5); display:none; align-items:center; justify-content:center; }
            #lsstb-overlay.open { display:flex; }
            #lsstb-panel { background:#222; color:#eee; border:1px solid #555; border-radius:6px;
                padding:12px 16px; width:360px; max-width:92vw; max-height:80vh; overflow:auto;
                font:13px sans-serif; }
            #lsstb-panel .lsstb-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
            #lsstb-panel h4 { margin:0; font-size:14px; color:#eee; }
            #lsstb-panel .lsstb-x { background:none; border:none; color:#aaa; font-size:20px; line-height:1; cursor:pointer; padding:0 4px; }
            #lsstb-panel .lsstb-x:hover { color:#fff; }
            #lsstb-panel label { display:block; padding:5px 0; cursor:pointer; font-weight:normal; margin:0; }
            #lsstb-panel small { color:#999; display:block; margin-left:22px; line-height:1.3; }
            #lsstb-panel .lsstb-foot { margin-top:8px; padding-top:6px; border-top:1px solid #444; color:#888; font-size:11px; }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'lsstb-overlay';
        const panel = document.createElement('div');
        panel.id = 'lsstb-panel';

        const head = document.createElement('div');
        head.className = 'lsstb-head';
        const title = document.createElement('h4');
        title.textContent = 'LSS Toolbox – Module';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'lsstb-x';
        closeBtn.textContent = '×';
        closeBtn.title = 'Schließen';
        head.append(title, closeBtn);
        panel.append(head);

        modules.forEach(mod => {
            const label = document.createElement('label');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = isEnabled(mod);
            cb.addEventListener('change', () => {
                store.set('enabled.' + mod.id, cb.checked);
                cb.checked ? startModule(mod) : stopModule(mod);
            });
            label.append(cb, ' ', mod.name || mod.id);
            const info = [mod.description, mod.where ? 'Aktiv auf: ' + mod.where : ''].filter(Boolean).join(' · ');
            if (info) {
                const s = document.createElement('small');
                s.textContent = info;
                label.append(s);
            }
            panel.append(label);
        });

        const foot = document.createElement('div');
        foot.className = 'lsstb-foot';
        foot.textContent = 'Änderungen wirken sofort, auch in offenen Einsatzfenstern.';
        const ver = document.createElement('div');
        ver.id = 'lsstb-ver';
        ver.className = 'lsstb-foot';
        ver.style.cssText = 'border-top:none;margin-top:0;padding-top:0;';
        ver.textContent = 'v' + VERSION;
        panel.append(foot, ver);

        overlay.append(panel);
        document.body.append(overlay);

        const open = () => overlay.classList.add('open');
        const close = () => overlay.classList.remove('open');
        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
        panelApi.open = open;
        panelApi.close = close;

        // Menüeintrag einsetzen; das Menü kann später geladen oder neu aufgebaut werden -> regelmäßig nachsehen
        let misses = 0;
        ensureMenuItem();
        setInterval(() => {
            if (ensureMenuItem()) { misses = 0; return; }
            if (++misses === 15) {
                console.warn('[LSS-Toolbox] Menüeintrag "Notizen" nicht gefunden – Toolbox-Menüpunkt kann nicht eingefügt werden. Notfalls im Konsolenfenster: LSSToolbox.open()');
            }
        }, 2000);
    }

    // ======================================================================
    // MODUL 1: Fahrzeug-Abgleich (benötigt vs. unterwegs)
    // ======================================================================
    register({
        id: 'fahrzeug-abgleich',
        name: 'Fahrzeug-Abgleich',
        description: 'Zeigt pro Anforderung: fehlt / Anfahrt / vor Ort / gewählt.',
        where: 'Einsatzfenster',
        match: loc => loc.pathname.startsWith('/missions/'),

        init(ctx) {
    let alive = true;

    // ---------- Einstellungen ----------
    const SOURCE_ID = 'missing_text';
    const BOX_ID = 'lss-abgleich';
    const LANG = 'de_DE';          // Sprache der Typnamen (LSSM-API)
    const HIDE_ORIGINAL = false;

    // Zuordnung Anforderung -> Fahrzeugtyp (nur nötig, wenn Namen nicht gleich lauten).
    // Die erste passende Regel entscheidet.
    const RULES = [
        { req: /(funkstreifenwagen|fustw).*(dienstgruppen|dgl)/i, veh: /(fustw|funkstreifenwagen|streifenwagen).*(dgl|dienstgruppen)/i },
        { req: /drehleiter/i,            veh: /^(DLK|DL |Drehleiter)/i },
        { req: /rüstwagen|ruestwagen/i,  veh: /^(RW|Rüstwagen)/i },
        { req: /rettungswagen|^rtw$/i,   veh: /^(RTW|Rettungswagen)/i },
        { req: /notarzt|^nef$/i,         veh: /^(NEF|NAW|Notarzt)/i },
        { req: /krankentransport|ktw/i,  veh: /^(KTW|Krankentransport)/i },
        { req: /elw ?1|einsatzleit/i,    veh: /^ELW ?1/i },
        { req: /elw ?2/i,                veh: /^ELW ?2/i },
        { req: /gw-?öl|gw-?oel/i,        veh: /^GW-?(Öl|Oel)/i },
        { req: /gw-?atemschutz/i,        veh: /^GW-?Atemschutz/i },
        { req: /gw-?messtechnik/i,       veh: /^GW-?Messtechnik/i },
        { req: /gw-?gefahrgut/i,         veh: /^GW-?Gefahrgut/i },
        { req: /schlauch/i,              veh: /^(GW-?Schlauch|SW)/i },
        { req: /streifenwagen|fustw/i,   veh: /^(Streifenwagen|FuStW)(?!.*(DGL|Dienstgruppen))/i },
        { req: /wasserwerfer/i,      veh: /^(WaWe|Wasserwerfer)/i },
        { req: /löschfahrzeug|loeschfahrzeug|\blf\b|hlf/i, veh: /^(LF|HLF|TLF|TSF|KLF|MLF|StLF)/i },
    ];

    // <pure>
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    const splitItems = t => t.split(/,(?![^(]*\))/).map(s => s.trim()).filter(Boolean);
    const fold = s => s.toLowerCase().replace(/ä/g,'a').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ß/g,'ss')
        .replace(/[^a-z0-9]+/g, ' ').trim();

    function parseRequired(text) {
        text = text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        text = text.split(/Fehlendes Personal/i)[0];               // Personal-Teil abschneiden
        const colon = text.indexOf(':');
        const list = (colon > -1 ? text.slice(colon + 1) : text).replace(/\.\s*$/, '');
        return splitItems(list).map(item => {
            const m = item.match(/^(\d+)\s*x?\s+(.+)$/i);
            return m ? { missing: +m[1], name: m[2].trim() } : { missing: 1, name: item };
        });
    }

    // Wie gut passt ein Fahrzeugtyp zu einer Anforderung? 3 = exakt, 2 = Regel, 1 = Namensähnlichkeit, 0 = nein
    function scoreAlt(req, veh) {
        const a = fold(req), b = fold(veh);
        if (!a || !b) return 0;
        if (a === b) return 3;
        for (const r of RULES) if (r.req.test(req)) return r.veh.test(veh) ? 2 : 0;
        if (b.startsWith(a + ' ')) return 1;                                              // "wasserwerfer" ~ "wasserwerfer 10000"
        if (a.startsWith(b) && /^(e|er|en|n|s)$/.test(a.slice(b.length))) return 1;       // Plural: Polizeipferde ~ Polizeipferd
        return 0;
    }
    const score = (req, veh) => {
        let best = Math.max(...req.split(/\s+oder\s+/i).map(x => scoreAlt(x.trim(), veh)));
        const inner = req.match(/\(([^()]+)\)/);                 // "Radlader (BRmG R)" -> Typ "BRmG R"
        if (inner && fold(inner[1]) === fold(veh)) best = Math.max(best, 3);
        return best;
    };

    // Fahrzeugtypen, die zusätzlich eine andere Anforderung erfüllen dürfen (nur mit Überschuss, nur in diese Richtung)
    const SUBSTITUTES = [
        { veh: /^ELW ?2/i, covers: /^ELW ?1\b/i },   // ELW 2 ersetzt ELW 1, ein ELW 1 aber keinen ELW 2
    ];

    // Fahrzeugtypen, die gleichzeitig für mehrere Anforderungen zählen (kein Entweder-oder):
    // jedes HLF (10, 20, Schiene …) zählt sofort als LF und als RW
    const MULTI = [
        { veh: /^HLF/i, covers: [/^(löschfahrzeug|loeschfahrzeug|lf\b)/i, /^(rüstwagen|ruestwagen|rw\b)/i] },
    ];

    // Jedes Fahrzeug genau einer Anforderung zuordnen (beste Übereinstimmung), danach Ersatz-Regeln anwenden
    function assign(rows, vehicles) {
        const extra = [];
        rows.forEach(r => { r.list = []; });
        vehicles.forEach(v => {
            const multi = MULTI.find(m => m.veh.test(v.name));
            if (multi) {                                   // zählt in allen passenden Zeilen
                let any = false;
                rows.forEach(r => {
                    if (multi.covers.some(rx => rx.test(r.name)) || score(r.name, v.name) > 0) { r.list.push(v); any = true; }
                });
                if (!any) extra.push(v);
                return;
            }
            let best = -1, bs = 0;
            rows.forEach((r, i) => { const sc = score(r.name, v.name); if (sc > bs) { bs = sc; best = i; } });
            if (best > -1) rows[best].list.push(v); else extra.push(v);
        });

        // Bereits eingetroffene Fahrzeuge zieht das Spiel selbst ab, nur Anfahrt/Auswahl zählt hier
        const counted = r => r.list.filter(v => v.state !== 'atSite').length;
        SUBSTITUTES.forEach(sub => {
            rows.forEach(target => {
                if (!sub.covers.test(target.name)) return;
                let need = Math.max(0, target.missing - counted(target));
                const move = (from, v) => { from.splice(from.indexOf(v), 1); target.list.push(v); need--; };

                // 1) Fahrzeuge ohne eigene Anforderung
                extra.filter(v => v.state !== 'atSite' && sub.veh.test(v.name)).forEach(v => { if (need > 0) move(extra, v); });

                // 2) Überschuss aus anderen Zeilen (über deren eigenen Bedarf hinaus)
                rows.forEach(o => {
                    if (o === target || need <= 0) return;
                    let spare = counted(o) - o.missing;
                    o.list.filter(v => v.state !== 'atSite' && sub.veh.test(v.name)).forEach(v => {
                        if (spare > 0 && need > 0) { move(o.list, v); spare--; }
                    });
                });
            });
        });

        // Zähler aus den zugeordneten Fahrzeugen bilden
        rows.forEach(r => {
            r.driving = r.list.filter(v => v.state === 'driving').length;
            r.atSite  = r.list.filter(v => v.state === 'atSite').length;
            r.sel     = r.list.filter(v => v.state === 'sel').length;
        });
        return extra;
    }
    // </pure>

    // ---------- Daten (alles aus dem HTML, keine API nötig) ----------
    const missionId = (location.pathname.match(/\/missions\/(\d+)/) || [])[1];

    const looksLikeType = t => !!t && !/^[\d.,:\s]+\s*(km|m|min|h)?$/i.test(t);

    // Das Spiel zeigt den Typ in Klammern hinter dem Namen: "LAPD 107 - FuStW/8 (FuStW)"
    function typeFromRow(tr) {
        if (!tr) return null;
        const smalls = [...tr.querySelectorAll('small')]
            .filter(s => !s.querySelector('a, button') && /^\(.+\)$/.test(s.textContent.trim()));
        if (smalls.length) return smalls[0].textContent.trim().replace(/^\(|\)$/g, '').trim();
        const td = tr.querySelector('td');
        if (!td) return null;
        const c = td.cloneNode(true);
        c.querySelectorAll('.btn-group, .visible-xs, .hidden-xs, a.btn, button').forEach(e => e.remove());
        const m = c.textContent.replace(/\s+/g, ' ').trim().match(/\(([^()]+)\)\s*$/);
        return m ? m[1].trim() : null;
    }

    // Ist ein Element Teil der Anfahrt- oder Vor-Ort-Liste?
    function classify(el) {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            const k = ((n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : '')).toLowerCase();
            if (/at_mission|atmission|on_site|onsite|vor_ort/.test(k)) return 'atSite';
            if (/driving|on_way|onway|anfahr/.test(k)) return 'driving';
        }
        return null;
    }

    function domSent() {
        const state = new Map();   // id -> {state, name}
        document.querySelectorAll('a[href^="/vehicles/"]').forEach(a => {
            if (a.closest('#' + BOX_ID)) return;
            const m = a.getAttribute('href').match(/^\/vehicles\/(\d+)$/);
            if (!m || state.has(m[1])) return;
            const st = classify(a);
            if (st) state.set(m[1], { state: st, name: typeFromRow(a.closest('tr')) || '?' });
        });
        return state;
    }

    // Typ-Nummer -> Name (LSSM-API, 24 h im localStorage gecacht)
    const typeNames = new Map();
    let typeNamesTry = 0;
    async function loadTypeNames() {
        if (typeNames.size || Date.now() - typeNamesTry < 60000) return;
        typeNamesTry = Date.now();
        const KEY = 'lssAbgleichTypes';
        try {
            const c = JSON.parse(localStorage.getItem(KEY) || 'null');
            if (c && c.data && Date.now() - c.t < 864e5) {
                Object.entries(c.data).forEach(([id, n]) => typeNames.set(id, n));
                if (typeNames.size) return;
            }
        } catch (e) { /* ignorieren */ }
        try {
            const res = await Promise.race([
                fetch('https://api.lss-manager.de/' + LANG + '/vehicles'),
                new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 6000)),
            ]);
            const data = await res.json();
            const flat = {};
            Object.entries(data).forEach(([id, v]) => { if (v && v.caption) flat[id] = v.caption; });
            Object.entries(flat).forEach(([id, n]) => typeNames.set(id, n));
            try { localStorage.setItem(KEY, JSON.stringify({ t: Date.now(), data: flat })); } catch (e) { /* ignorieren */ }
        } catch (e) {
            console.warn('[LSS-Abgleich] Typnamen nicht ladbar:', e);
        }
    }

    // Angehakte, noch nicht alarmierte Fahrzeuge
    function selectedVehicles() {
        return [...document.querySelectorAll('input.vehicle_checkbox:checked, input[type="checkbox"][name="vehicle_ids[]"]:checked')]
            .map(cb => {
                const tid = cb.getAttribute('vehicle_type_id');
                const t = (tid && typeNames.get(tid)) || cb.getAttribute('vehicle_type') ||
                    cb.getAttribute('vehicle_type_caption') || typeFromRow(cb.closest('tr'));
                return { id: String(cb.value || ''), state: 'sel', name: looksLikeType(t) ? t : '?' };
            });
    }

    function readRequired(source) {
        const block = source.querySelector('[data-requirement-type="vehicles"]');
        return parseRequired((block || source).textContent);
    }

    function collectVehicles() {
        const out = [];
        domSent().forEach((v, id) => out.push({ id, state: v.state, name: v.name }));
        return out.concat(selectedVehicles());
    }

    // ---------- Rendering ----------
    let running = false, again = false;
    let timer = null;

    async function render() {
        if (!alive) return;
        if (running) { again = true; return; }
        running = true;
        try {
            const source = document.getElementById(SOURCE_ID);
            if (!source) return;
            let box = document.getElementById(BOX_ID);
            if (!box) {
                box = document.createElement('div');
                box.id = BOX_ID;
                source.insertAdjacentElement('afterend', box);
            }

            const required = readRequired(source);
            const hadNames = typeNames.size;
            loadTypeNames().then(() => { if (!hadNames && typeNames.size) schedule(); });   // nicht darauf warten
            const vehicles = collectVehicles();

            // Anforderungen merken: erfüllte verschwinden aus dem Spieltext, sollen hier aber stehen bleiben (Fehlt 0)
            const KEY = 'lssAbgleichReq_' + missionId;
            let seen = [];
            try { seen = JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch (e) { /* ignorieren */ }
            required.forEach(r => { if (!seen.includes(r.name)) seen.push(r.name); });
            try { sessionStorage.setItem(KEY, JSON.stringify(seen)); } catch (e) { /* ignorieren */ }
            const rows = seen.map(n => {
                const r = required.find(x => x.name === n);
                return { name: n, missing: r ? r.missing : 0, driving: 0, atSite: 0, sel: 0 };
            });
            assign(rows, vehicles);
            const count = st => vehicles.filter(v => v.state === st).length;
            const totalMissing = rows.reduce((s, r) => s + r.missing, 0);

            // Zwei Spalten nebeneinander (bei wenigen Zeilen oder schmalem Fenster eine)
            const split = rows.length >= 4 ? Math.ceil(rows.length / 2) : rows.length;
            const unnamed = vehicles.filter(v => v.state === 'sel' && v.name === '?').length;
            const ticked = document.querySelectorAll('input[type="checkbox"]:checked').length;
            const warn = unnamed
                ? `⚠ ${unnamed} angehakte Fahrzeuge ohne Typnamen (Namensliste von api.lss-manager.de nicht geladen)`
                : (ticked && !count('sel') ? `⚠ ${ticked} Haken gesetzt, aber keine Fahrzeug-Checkbox erkannt` : '');
            // Wie im LSSM: "Fehlt" = Spieltext (Eingetroffene sind dort schon abgezogen, Anfahrende nicht).
            // Rest = Fehlt - Anfahrt - Gewählt
            const restOf = r => Math.max(0, r.missing - r.driving - r.sel);
            const uniq = new Set();
            rows.forEach(r => r.list.forEach(v => uniq.add(v)));          // ein HLF in LF- und RW-Zeile zählt in der Summe einmal
            const sum = st => [...uniq].filter(v => v.state === st).length;
            const restTotal = rows.reduce((t, r) => t + restOf(r), 0);
            const tableHtml = list => `
                <table>
                    <thead><tr><th>Fahrzeug</th><th class="n">Fehlt</th><th class="n">Anfahrt</th><th class="n">Vor Ort</th><th class="n">Gewählt</th><th class="n">Rest</th></tr></thead>
                    <tbody>
                        ${list.map(r => `<tr>
                            <td>${esc(r.name)}</td>
                            <td class="n miss">${r.missing}</td>
                            <td class="n">${r.driving}</td>
                            <td class="n">${r.atSite}</td>
                            <td class="n ${r.sel ? 'selmark' : ''}">${r.sel}</td>
                            <td class="n ${restOf(r) ? 'miss' : 'ok'}">${restOf(r)}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>`;

            box.innerHTML = `
                <style>
                    #${BOX_ID} .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; align-items: start; }
                    @media (max-width: 900px) { #${BOX_ID} .cols { grid-template-columns: 1fr; } }
                    #${BOX_ID} table { width: 100%; margin: 8px 0 0; }
                    #${BOX_ID} th, #${BOX_ID} td { padding: 3px 8px; }
                    #${BOX_ID} th { border-bottom: 2px solid #888; text-align: left; }
                    #${BOX_ID} td.n, #${BOX_ID} th.n { text-align: center; width: 58px; white-space: nowrap; }
                    #${BOX_ID} tbody tr:nth-child(odd) { background: rgba(128,128,128,.15); }
                    #${BOX_ID} .miss { color: #d9534f; font-weight: bold; }
                    #${BOX_ID} .ok { color: #5cb85c; font-weight: bold; }
                    #${BOX_ID} .selmark { color: #f0ad4e; font-weight: bold; }
                    #${BOX_ID} .warn { color: #f0ad4e; font-size: 12px; margin: 2px 0 6px; }
                    #${BOX_ID} .ver { color: #888; font-size: 10px; text-align: right; }
                    #${BOX_ID} .sum { margin: 6px 0 8px; padding: 4px 8px; border-top: 2px solid #888; font-weight: bold; }
                </style>
                ${rows.length && !required.length ? '<div class="ok">Nichts fehlt mehr.</div>' : ''}
                ${rows.length ? `
                <div class="cols">
                    <div>${tableHtml(rows.slice(0, split))}</div>
                    ${split < rows.length ? `<div>${tableHtml(rows.slice(split))}</div>` : ''}
                </div>
                <div class="sum">Summe: <span class="miss">${totalMissing} fehlen</span> · ${sum('driving')} Anfahrt · ${sum('atSite')} vor Ort · ${sum('sel')} gewählt · <span class="${restTotal ? 'miss' : 'ok'}">Rest ${restTotal}</span></div>`
                : `<div class="ok">Nichts fehlt mehr.</div>`}
                ${warn ? `<div class="warn">${esc(warn)}</div>` : ''}
            `;
            if (HIDE_ORIGINAL) source.style.display = 'none';
        } catch (e) {
            console.error('[LSS-Abgleich] Fehler beim Aufbau', e);
        } finally {
            running = false;
            if (again) { again = false; schedule(); }
        }
    }

    // ---------- Auslöser ----------
    // Kein MutationObserver: Spiel und LSSM ändern das DOM ständig, ein verzögerter Neuaufbau käme nie dran.
    // Stattdessen alle 500 ms eine Kennung (Haken + Anforderungstext + Fahrzeuglinks) vergleichen.
    function signature() {
        const src = document.getElementById(SOURCE_ID);
        return [
            document.querySelectorAll('input[type="checkbox"]:checked').length,
            src ? src.textContent : '',
            document.querySelectorAll('a[href^="/vehicles/"]').length,
        ].join('|');
    }

    // Feste Verzögerung (kein Zurücksetzen bei weiteren Änderungen)
    function schedule() {
        if (!alive) return;
        if (!timer) timer = setTimeout(() => { timer = null; render(); }, 250);
    }

    ctx.on(document, 'change', e => {
        if (e.target && e.target.matches && e.target.matches('input[type="checkbox"]')) schedule();
    }, true);
    ctx.on(document, 'click', e => {
        if (e.target && e.target.closest && e.target.closest('#' + BOX_ID)) return;
        schedule();
    }, true);

    let lastSig = signature();
    ctx.interval(() => {
        const sig = signature();
        if (sig !== lastSig) { lastSig = sig; render(); }
    }, 500);

    // Aufräumen beim Ausschalten
    ctx.onCleanup(() => {
        alive = false;
        clearTimeout(timer);
        timer = null;
        const box = document.getElementById(BOX_ID);
        if (box) box.remove();
        const src = document.getElementById(SOURCE_ID);
        if (src && HIDE_ORIGINAL) src.style.display = '';
    });

    render();
        },
    });

    // ======================================================================
    // MODUL 2: Ausbildungscheck – Fahrzeugkauf
    // ======================================================================
    register({
        id: 'ausbildungscheck',
        name: 'Ausbildungscheck (Fahrzeugkauf)',
        description: 'Ausbildungsstand der Wache auf der Kaufseite, FZG rot bei zu wenig Personal.',
        where: '/buildings/…/vehicles/new',
        match: loc => /^\/buildings\/\d+\/vehicles\/new/.test(loc.pathname),

        init(ctx) {
    let alive = true;
    let observer = null;

    ctx.addStyle(`
        #lss-ausbildungscheck {
            background: #1a1a2e;
            border: 1px solid #2d2d5e;
            border-radius: 10px;
            padding: 14px 18px;
            margin-bottom: 16px;
            font-family: 'Segoe UI', sans-serif;
            color: #e8eaf6;
            font-size: 13px;
        }
        #lss-ausbildungscheck h4 {
            margin: 0 0 10px;
            color: #90caf9;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        #lss-ac-sub {
            font-size: 11px;
            color: #546e7a;
            font-weight: normal;
        }
        #lss-ac-toggle {
            background: none;
            border: none;
            color: #546e7a;
            cursor: pointer;
            font-size: 12px;
            margin-left: auto;
            padding: 0;
        }
        #lss-ac-toggle:hover { color: #90caf9; }
        #lss-edu-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        #lss-edu-grid.collapsed { display: none; }
        .lss-edu-badge {
            background: #12122a;
            border: 1px solid #2d2d5e;
            border-radius: 6px;
            padding: 5px 12px;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            color: #e8eaf6;
        }
        .lss-edu-count {
            background: #1565c0;
            color: #fff;
            border-radius: 4px;
            padding: 1px 7px;
            font-weight: bold;
            font-size: 12px;
            min-width: 22px;
            text-align: center;
        }
        .lss-loading { color: #78909c; font-style: italic; }
        .lss-error   { color: #ef9a9a; }

        /* Fahrzeug-Badges auf der Kaufseite */
        .lss-fzg-badge {
            display: inline-block;
            background: #12122a;
            border: 1px solid #2d2d5e;
            border-radius: 4px;
            padding: 1px 7px;
            font-size: 11px;
            font-weight: bold;
            margin-left: 6px;
            vertical-align: middle;
            color: #e8eaf6;
        }
        .lss-fzg-warn { border-color: #7f1d1d; color: #fca5a5; }
    `);

    const pathMatch = location.pathname.match(/\/buildings\/(\d+)\/vehicles\/new/);
    if (!pathMatch) return;
    const buildingId = pathMatch[1];

    // ── Box oben einfügen ──────────────────────────────────────────────
    const box = document.createElement('div');
    box.id = 'lss-ausbildungscheck';
    box.innerHTML = `
        <h4>
            🎓 Ausbildungscheck
            <span id="lss-ac-sub">Lade...</span>
            <button id="lss-ac-refresh" type="button" style="background:#12122a;border:1px solid #3d3d7a;color:#90caf9;border-radius:5px;padding:2px 10px;cursor:pointer;font-size:12px;margin-left:8px;">↺ Aktualisieren</button>
            <button id="lss-ac-toggle" type="button">▲ einklappen</button>
        </h4>
        <div id="lss-edu-grid"><span class="lss-loading">⏳ Lade Personal...</span></div>
    `;
    const insertTarget =
        document.querySelector('h1')?.parentElement ||
        document.querySelector('.container') ||
        document.body;
    insertTarget.prepend(box);

    // Aufräumen beim Ausschalten
    ctx.onCleanup(() => {
        alive = false;
        if (observer) observer.disconnect();
        document.querySelectorAll('.lss-fzg-badge').forEach(b => b.remove());
        document.querySelectorAll('a[data-lss-checked]').forEach(a => delete a.dataset.lssChecked);
        box.remove();
    });

    let collapsed = false;
    document.getElementById('lss-ac-toggle').addEventListener('click', () => {
        collapsed = !collapsed;
        document.getElementById('lss-edu-grid').classList.toggle('collapsed', collapsed);
        document.getElementById('lss-ac-toggle').textContent = collapsed ? '▼ ausklappen' : '▲ einklappen';
    });

    document.getElementById('lss-ac-refresh').addEventListener('click', () => {
        document.getElementById('lss-edu-grid').innerHTML = '<span class="lss-loading">⏳ Aktualisiere...</span>';
        // FZG-Badges zurücksetzen damit sie neu gezeichnet werden
        document.querySelectorAll('.lss-fzg-badge').forEach(b => b.remove());
        document.querySelectorAll('a[data-lss-checked]').forEach(a => delete a.dataset.lssChecked);
        ladeDaten();
    });

    // ── Fehlende LSSM-Schooling-Einträge ──────────────────────────────
    // Manche FZG haben in LSSM schooling:null obwohl sie Ausbildung brauchen
    // Format: vehicle_type → { eduName (LSS-Personalname), min }
    const MISSING_SCHOOLING = {
        41:  { eduName: 'FGr E',                          min: 1 }, // MzGW (FGr N) = Fachgruppe Notversorgung/Elektroversorgung
        122: { eduName: 'FGr E',                          min: 1 }, // LKW 7 Lbw (FGr E)
        123: { eduName: 'Fachgruppe Wasserschaden/Pumpen',min: 1 }, // LKW 7 Lbw (FGr WP)
        65:  { eduName: 'Fachgruppe Wassergefahren',      min: 1 }, // LKW 7 Lkr 19 tm
        93:  { eduName: 'Rettungshundeführer (THW)',       min: 1 }, // MTW-O (Fachgruppe Ortung)
        124: { eduName: 'GW-Wasserrettung',                 min: 1 }, // MTW-OV (individuelle Belegung Grisu)
    };

    // ── Ausbildungsname-Mapping ────────────────────────────────────────
    // LSSM-Name → LSS-Personalname (aus schooling_personal_select)
    const EDU_MAP = {
        // Feuerwehr
        'GW-Messtechnik Lehrgang':          'GW-Messtechnik',
        'Höhenrettung Lehrgang':            'GW-Höhenrettung',
        'Wechsellader Lehrgang':            'Wechsellader',
        'GW-Taucher Lehrgang':              'GW-Taucher',
        'GW-Wasserrettung Lehrgang':        'GW-Wasserrettung',
        'Flugfeldlöschfahrzeug-Ausbildung': 'Flugfeldlöschfahrzeug',
        'Rettungstreppen-Ausbildung':       'Rettungstreppen',
        'Werkfeuerwehr-Ausbildung':         'Werkfeuerwehr',
        'Feuerwehr-Verpflegungseinheit':    'Feuerwehr-Verpflegungseinheit',
        'NEA200 Fortbildung':               'NEA200',
        'Bahnrettung':                      'Bahnrettung',
        // Rettungsdienst
        'Notarzt-Ausbildung':               'Notarzt',
        'LNA-Ausbildung':                   'LNA (Leitender Notarzt)',
        'OrgL-Ausbildung':                  'OrgL',
        'SEG - Einsatzleitung':             'Einsatzleitung (SEG)',
        'SEG - GW-San':                     'GW-San',
        'Betreuungsdienst':                 'Betreuungshelfer',
        // (doppelter Key im Original – der spätere Eintrag gewinnt, daher nur dieser)
        'Rettungshundeführer':              'Rettungshundeführer (SEG)',
        'Höhenretter':                      'Höhenretter',
        'Einsatzleiter Bergrettung':        'Einsatzleiter Bergrettung',
        'Drohnenoperator':                  'Drohnenoperator',
        'Verpflegungshelfer':               'Verpflegungshelfer',
        'Windenoperator':                   'Windenoperator (RD)',
        'Intensivpflege':                   'Intensivpflege',
        // Polizei
        'Zugführer (leBefKw)':              'Zugführer (Pol)',
        'Hundertschaftsführer (FüKw)':      'Hundertschaftsführer',
        'Polizeihubschrauber':              'Polizeihubschrauber',
        'Hundeführer (Schutzhund)':         'Hundeführer',
        'Motorradstaffel':                  'Motorradstaffel',
        'Brandbekämpfung':                  'Brandbekämpfung (Pol)',
        'Kriminalpolizei':                  'Kriminalpolizei',
        'Dienstgruppenleitung':             'Dienstgruppenleitung',
        'Reiterstaffel':                    'Reiterstaffel',
        'SEK':                              'SEK',
        'MEK':                              'MEK',
        'Wasserwerfer':                     'Wasserwerfer',
        'Lautsprecheroperator':             'Lautsprecheroperator',
        // THW (LSS nutzt Abkürzungen!)
        'Zugtrupp':                                 'Zugtrupp',
        'Fachgruppe Räumen':                        'Fachgruppe Räumen',
        'Fachgruppe Wassergefahren':                'Fachgruppe Wassergefahren',
        'Fachgruppe Bergungstaucher':               'Fachgruppe Bergungstaucher',
        'Fachgruppe Rettungshundeführer':           'Rettungshundeführer (THW)',
        'Fachgruppe Wasserschaden/Pumpen':          'Fachgruppe Wasserschaden/Pumpen',
        'Fachgruppe Schwere Bergung':               'FGr SB',
        'Fachgruppe Elektroversorgung':             'FGr E',
        'Trupp Unbemannte Luftfahrtsysteme':        'Tr UL',
        'Fachzug Führung und Kommunikation':        'Fachzug Führung und Kommunikation',
        // Seenotrettung
        'Seenotretter':                             'Seenotretter',
        'Hubschrauberpilot (Seenotrettung)':        'Hubschrauberpilot (Seenotrettung)',
        'Wasserrettungsausbildung für Notfallsanitäter': 'Wasserrettungsausbildung Notfallsanitäter',
        // Neu/Sonstige
        'Technik und Sicherheit':                   'Technik und Sicherheit',
        'Logistik-Verpflegung':                     'Logistik-Verpflegung',
    };

    function bereinige(name) {
        return name.toLowerCase()
            .replace(/lehrgang/g, '').replace(/ausbildung/g, '')
            .replace(/fortbildung/g, '').replace(/^gw-/, '')
            .replace(/[-_]/g, ' ').replace(/  +/g, ' ').trim();
    }

    function matchEduName(lssmName, personalName) {
        // 1. Statisches Mapping
        const mapped = EDU_MAP[lssmName];
        if (mapped && mapped.toLowerCase() === personalName.toLowerCase()) return true;
        // 2. Exakter Match
        const a = lssmName.toLowerCase().trim();
        const b = personalName.toLowerCase().trim();
        if (a === b) return true;
        // 3. Einer enthält den anderen
        if (a.includes(b) || b.includes(a)) return true;
        // 4. Bereinigter Match
        const ac = bereinige(lssmName);
        const bc = bereinige(personalName);
        if (ac === bc || ac.includes(bc) || bc.includes(ac)) return true;
        return false;
    }

    function findePersonalName(lssmEduName, ausgebildetGesamt) {
        // Zuerst statisches Mapping prüfen
        const mapped = EDU_MAP[lssmEduName];
        if (mapped && ausgebildetGesamt[mapped] !== undefined) return mapped;
        // Dann fuzzy
        return Object.keys(ausgebildetGesamt).find(k => matchEduName(lssmEduName, k));
    }

    // ── Daten laden ────────────────────────────────────────────────────
    function ladeDaten() {
    Promise.all([
        // 1. Wachenname
        fetch(`/api/buildings/${buildingId}`)
            .then(r => r.ok ? r.json() : {})
            .catch(() => ({})),

        // 2. Personal + Ausbildungen (via schooling_personal_select HTML)
        fetch(`/buildings/${buildingId}/schooling_personal_select`)
            .then(r => r.ok ? r.text() : '')
            .catch(() => ''),

        // 3. Vorhandene Fahrzeuge der Wache
        fetch(`/api/buildings/${buildingId}/vehicles`)
            .then(r => r.ok ? r.json() : [])
            .catch(() => []),

        // 4. LSSM Fahrzeugtypen (Ausbildungs-Mapping)
        fetch('https://api.lss-manager.de/de_DE/vehicles')
            .then(r => r.ok ? r.json() : {})
            .catch(() => ({})),
    ])
    .then(([building, personalHtml, vorhandeneFzg, lssmVehicles]) => {
        if (!alive) return;

        // Wachennamen setzen
        document.getElementById('lss-ac-sub').textContent =
            `– ${building.caption || 'Wache #' + buildingId}`;

        // ── Ausbildungen aus HTML zählen ───────────────────────────────
        const doc = new DOMParser().parseFromString(personalHtml, 'text/html');
        const ausgebildetGesamt = {}; // eduName → Anzahl Personen
        let personalCount = 0;

        doc.querySelectorAll('[id^="school_personal_education_"]').forEach(span => {
            personalCount++;
            span.textContent.split(',').forEach(edu => {
                edu = edu.trim();
                if (edu) ausgebildetGesamt[edu] = (ausgebildetGesamt[edu] || 0) + 1;
            });
        });

        // ── Gebundenes Personal durch vorhandene FZG berechnen ─────────
        // Pro vorhandenem FZG: schooling-Ausbildung * staff.min abziehen
        const gebunden = {}; // eduName → Anzahl gebunden
        const nurEigene = vorhandeneFzg.filter(v => v.building_id === parseInt(buildingId));

        nurEigene.forEach(fzg => {
            const typ = lssmVehicles[fzg.vehicle_type];
            const zugewiesen = (fzg.assigned_personnel_count != null && fzg.assigned_personnel_count > 0)
                ? fzg.assigned_personnel_count
                : 0;
            if (zugewiesen === 0) return;

            // LSSM hat schooling-Daten
            if (typ && typ.schooling) {
                Object.values(typ.schooling).forEach(lehrgaenge => {
                    Object.keys(lehrgaenge).forEach(lssmEduName => {
                        const personalName = findePersonalName(lssmEduName, ausgebildetGesamt);
                        const key = personalName || lssmEduName;
                        const verfuegbareFuerKey = ausgebildetGesamt[key] || 0;
                        const abzug = Math.min(zugewiesen, verfuegbareFuerKey);
                        gebunden[key] = (gebunden[key] || 0) + abzug;
                    });
                });
            }

            // Fehlende LSSM-Einträge aus eigener Map ergänzen
            const missing = MISSING_SCHOOLING[fzg.vehicle_type];
            if (missing) {
                const key = missing.eduName;
                const verfuegbareFuerKey = ausgebildetGesamt[key] || 0;
                const abzug = Math.min(zugewiesen, verfuegbareFuerKey);
                gebunden[key] = (gebunden[key] || 0) + abzug;
            }
        });

        // ── Verfügbar = Gesamt - Gebunden (min. 0) ───────────────────────
        const verfuegbar = {};
        Object.entries(ausgebildetGesamt).forEach(([edu, count]) => {
            verfuegbar[edu] = Math.max(0, count - (gebunden[edu] || 0));
        });

        // ── Ausbildungs-Box rendern ────────────────────────────────────
        const grid = document.getElementById('lss-edu-grid');
        const eintraege = Object.entries(ausgebildetGesamt)
            .filter(([, n]) => n > 0)
            .sort(([, a], [, b]) => b - a);

        if (eintraege.length === 0) {
            grid.innerHTML = '<span class="lss-loading">Keine Ausbildungen vorhanden.</span>';
        } else {
            grid.innerHTML = eintraege.map(([name, gesamt]) => {
                const frei = verfuegbar[name] ?? gesamt;
                const geb  = gebunden[name] || 0;
                const tooltip = geb > 0
                    ? `${gesamt} gesamt, ${geb} gebunden, ${frei} frei`
                    : `${gesamt} gesamt`;
                return `<div class="lss-edu-badge" title="${tooltip}">
                    <span class="lss-edu-count">${frei}</span>
                    <span>${name}</span>
                    ${geb > 0 ? `<span style="color:#546e7a;font-size:11px;">(${gesamt}−${geb})</span>` : ''}
                </div>`;
            }).join('');
        }

        document.getElementById('lss-ac-sub').textContent +=
            ` · ${personalCount} Personal · ${eintraege.length} Ausbildungsarten`;

        // ── Fahrzeug-Kaufliste markieren ───────────────────────────────
        // FZG-Links auf der Seite haben href="/vehicles/new?type=X" oder ähnlich
        // Wir warten kurz bis Tabs geladen sind und markieren dann
        markiereFahrzeuge(lssmVehicles, verfuegbar);

        // Tab-Wechsel beobachten (alten Observer ersetzen, damit sich keine ansammeln)
        if (observer) observer.disconnect();
        observer = new MutationObserver(() => markiereFahrzeuge(lssmVehicles, verfuegbar));
        const tabContent = document.querySelector('.tab-content') || document.querySelector('#vehicle-buy-tabs');
        if (tabContent) observer.observe(tabContent, { childList: true, subtree: true });
    })
    .catch(err => {
        if (!alive) return;
        document.getElementById('lss-edu-grid').innerHTML =
            `<span class="lss-error">❌ Fehler: ${err.message || err}</span>`;
        console.error('[LSS Ausbildungscheck]', err);
    });
    } // end ladeDaten

    ladeDaten();

    // ── Fahrzeuge auf der Kaufseite markieren ──────────────────────────
    function markiereFahrzeuge(lssmVehicles, verfuegbar) {
        // FZG-Kauflinks: <a href="...?type=XX"> oder data-vehicle-type
        document.querySelectorAll('a[href*="vehicle_type="], a[href*="type="]').forEach(link => {
            if (link.dataset.lssChecked) return; // nicht doppelt markieren
            link.dataset.lssChecked = '1';

            const urlMatch = link.href.match(/[?&](?:vehicle_)?type=(\d+)/);
            if (!urlMatch) return;
            const typeId = urlMatch[1];
            const typ = lssmVehicles[typeId];
            if (!typ) return;

            const badge = document.createElement('span');
            badge.className = 'lss-fzg-badge';

            if (!typ.schooling) {
                // Kein Lehrgang nötig – gar kein Badge
                return;
            } else {
                const minPersonal = typ.staff?.min || 1;
                const teile = [];
                let zuWenig = false;

                Object.values(typ.schooling).forEach(lehrgaenge => {
                    Object.keys(lehrgaenge).forEach(lssmEduName => {
                        // Fuzzy-Match für Anzeige
                        const personalName = Object.keys(verfuegbar).find(k => matchEduName(lssmEduName, k));
                        const anzeigeNamen = personalName || lssmEduName;
                        const frei = verfuegbar[anzeigeNamen] ?? 0;
                        teile.push(`${anzeigeNamen}: ${frei}/${minPersonal}`);
                        if (frei < minPersonal) zuWenig = true;
                    });
                });

                badge.textContent = teile.join(' · ');
                badge.title = teile.join('\n') + '\n(verfügbar/benötigt)';
                if (zuWenig) badge.classList.add('lss-fzg-warn');
            }

            link.appendChild(badge);
        });
    }
        },
    });

    // ======================================================================
    // MODUL 3: Personal-Übersicht (Tab in der Leitstelle)
    // ======================================================================
    register({
        id: 'personal-uebersicht',
        name: 'Personal-Übersicht',
        description: 'Tab mit Personal, Ausbildungen und Fahrzeugbindung aller zugehörigen Wachen.',
        where: 'Leitstellen-Seite (/buildings/…)',
        match: loc => /^\/buildings\/\d+$/.test(loc.pathname),

        init(ctx) {
  let observer = null;
  let tabLi = null;
  let tabPanel = null;

  const TAB_ID   = 'grisu-personal-uebersicht';
  const STYLE_ID = 'grisu-personal-style';

  // ─── Hilfsfunktionen ───────────────────────────────────────────────────────
  // Gleiche Domain -> normales fetch reicht (kein GM_xmlhttpRequest nötig)

  function fetchJSON(url) {
    return fetch(url, { credentials: 'same-origin' }).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchDoc(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(t => new DOMParser().parseFromString(t, 'text/html'));
  }

  function getCurrentBuildingId() {
    const m = location.pathname.match(/\/buildings\/(\d+)/);
    return m ? m[1] : null;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── CSS ───────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = ctx.addStyle(`
#${TAB_ID}-panel {
  padding: 12px 4px;
  font-size: 13px;
}
#${TAB_ID}-panel .grisu-search {
  width: 100%;
  max-width: 360px;
  margin-bottom: 12px;
  padding: 5px 10px;
  border: 1px solid #999 !important;
  border-radius: 4px;
  font-size: 13px;
  box-sizing: border-box;
  color: #222 !important;
  background: #fff !important;
}
#${TAB_ID}-panel .grisu-filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 14px;
  align-items: center;
}
#${TAB_ID}-panel .grisu-btn-filter {
  padding: 4px 12px;
  border-radius: 12px;
  border: 2px solid #222 !important;
  background: #333 !important;
  color: #fff !important;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600 !important;
  white-space: nowrap;
}
#${TAB_ID}-panel .grisu-btn-filter:hover { background: #111 !important; border-color: #000 !important; }
#${TAB_ID}-panel .grisu-btn-filter.active { background: #0066cc !important; color: #fff !important; border-color: #004499 !important; }
#${TAB_ID}-panel .grisu-table-wrap { overflow-x: auto; }
#${TAB_ID}-panel table.grisu-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  min-width: 700px;
}
#${TAB_ID}-panel table.grisu-tbl th {
  background: #e8e8e8 !important;
  color: #222 !important;
  border-bottom: 2px solid #bbb !important;
  padding: 6px 8px;
  text-align: left;
  white-space: nowrap;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}
#${TAB_ID}-panel table.grisu-tbl th:hover { background: #d0d0d0 !important; color: #000 !important; }
#${TAB_ID}-panel table.grisu-tbl td {
  padding: 5px 8px;
  border-bottom: 1px solid #444 !important;
  vertical-align: top;
  color: #fff !important;
  background: #111 !important;
}
#${TAB_ID}-panel table.grisu-tbl tr.grisu-main-row:hover td { background: #1e1e2e !important; cursor: pointer; }
#${TAB_ID}-panel table.grisu-tbl tr.grisu-detail-row td { background: #0a0a14 !important; }
#${TAB_ID}-panel .grisu-badge {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  margin: 1px 2px 1px 0;
}
#${TAB_ID}-panel .badge-ok      { background:#1e7e1e !important; color:#fff !important; border:1px solid #155715; }
#${TAB_ID}-panel .badge-partial { background:#cc8800 !important; color:#fff !important; border:1px solid #996600; }
#${TAB_ID}-panel .badge-missing { background:#cc2200 !important; color:#fff !important; border:1px solid #991a00; }
#${TAB_ID}-panel .badge-none    { background:#555    !important; color:#fff !important; border:1px solid #333; }
#${TAB_ID}-panel .badge-edu     { background:#2255aa !important; color:#fff !important; border:1px solid #163d78; }
#${TAB_ID}-panel .grisu-badge-list { display:flex; flex-wrap:wrap; gap:2px; max-width:320px; }
#${TAB_ID}-panel .grisu-loading  { padding:20px; color:#333 !important; text-align:center; }
#${TAB_ID}-panel .grisu-error    { padding:20px; color:#cc2200 !important; font-weight:600; }
#${TAB_ID}-panel .grisu-summary  { margin-bottom:10px; color:#333 !important; font-size:12px; }
#${TAB_ID}-panel .grisu-link     { color:#66aaff !important; text-decoration:none; }
#${TAB_ID}-panel .grisu-link:hover { text-decoration:underline; }
#${TAB_ID}-panel .grisu-col-name { min-width:160px; }
#${TAB_ID}-panel .sort-asc::after  { content:' ▲'; font-size:10px; }
#${TAB_ID}-panel .sort-desc::after { content:' ▼'; font-size:10px; }
#${TAB_ID}-panel .grisu-detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
#${TAB_ID}-panel .grisu-detail-box {
  background: #1a1a26 !important;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 8px 10px;
}
#${TAB_ID}-panel .grisu-detail-box h4 {
  margin: 0 0 6px 0;
  font-size: 12px;
  color: #ccc !important;
  border-bottom: 1px solid #333;
  padding-bottom: 4px;
}
#${TAB_ID}-panel .grisu-detail-line {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  color: #ddd !important;
  padding: 1px 0;
}
#${TAB_ID}-panel .grisu-edufilter-toggle {
  padding: 4px 12px;
  border-radius: 12px;
  border: 2px dashed #555 !important;
  background: transparent !important;
  color: #222 !important;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600 !important;
  white-space: nowrap;
}
#${TAB_ID}-panel .grisu-edufilter-toggle:hover { background: #ddd !important; }
#${TAB_ID}-panel .grisu-edufilter-toggle.active { background: #0066cc !important; color: #fff !important; border-color: #004499 !important; border-style: solid; }
#${TAB_ID}-panel .grisu-edufilter-box {
  background: #eee !important;
  border: 1px solid #bbb;
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}
#${TAB_ID}-panel .grisu-edufilter-row {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #222 !important;
}
#${TAB_ID}-panel .grisu-edufilter-row input[type="checkbox"] { cursor: pointer; }
#${TAB_ID}-panel .grisu-edufilter-row label { cursor: pointer; user-select: none; }
#${TAB_ID}-panel .grisu-edufilter-min {
  width: 44px;
  padding: 2px 5px;
  border: 1px solid #999 !important;
  border-radius: 4px;
  font-size: 12px;
  color: #222 !important;
  background: #fff !important;
}
`);
    s.id = STYLE_ID;
  }

  // ─── Tab einfügen ──────────────────────────────────────────────────────────

  function findTabContainer() {
    return document.querySelector('ul.nav-tabs');
  }

  function injectTab() {
    const ul = findTabContainer();
    if (!ul || document.getElementById(TAB_ID + '-tab')) return false;

    const li = document.createElement('li');
    li.innerHTML = `<a id="${TAB_ID}-tab" href="#${TAB_ID}-panel" data-toggle="tab">👥 Personal-Übersicht</a>`;
    ul.appendChild(li);
    tabLi = li;

    const tabContent = document.querySelector('.tab-content');
    if (!tabContent) return false;

    const panel = document.createElement('div');
    panel.id = TAB_ID + '-panel';
    panel.className = 'tab-pane';
    panel.innerHTML = `<p class="grisu-loading">Tab anklicken zum Laden…</p>`;
    tabContent.appendChild(panel);
    tabPanel = panel;

    let loaded = false;
    document.getElementById(TAB_ID + '-tab').addEventListener('click', () => {
      if (!loaded) { loaded = true; loadData(panel); }
    });
    return true;
  }

  // ─── Personal-Seite parsen ──────────────────────────────────────────────────

  function parsePersonalsDoc(doc) {
    const rows = [...doc.querySelectorAll('#personal_table tbody tr')];
    return rows.map(tr => {
      const tds = tr.querySelectorAll('td');
      const name      = tds[1] ? tds[1].textContent.trim() : '';
      const education  = tds[2] ? tds[2].textContent.trim() : '';
      const boundTo   = tds[3] ? tds[3].textContent.trim() : '';
      const statusEl  = tds[4] ? tds[4].querySelector('span') : null;
      const status    = statusEl ? statusEl.textContent.trim() : (tds[4] ? tds[4].textContent.trim() : '');
      return { name, education, boundTo, status };
    });
  }

  function buildStats(personals) {
    const stats = {
      total: personals.length,
      byStatus: {},
      byEducation: {},
      byVehicle: {},
      unbound: 0,
      noEducation: 0,
      noEducationByStatus: {},
    };
    for (const p of personals) {
      const st = p.status || 'Unbekannt';
      stats.byStatus[st] = (stats.byStatus[st] || 0) + 1;

      const edu = p.education || '';
      if (edu) {
        stats.byEducation[edu] = (stats.byEducation[edu] || 0) + 1;
      } else {
        stats.noEducation++;
        stats.noEducationByStatus[st] = (stats.noEducationByStatus[st] || 0) + 1;
      }

      if (p.boundTo) {
        stats.byVehicle[p.boundTo] = (stats.byVehicle[p.boundTo] || 0) + 1;
      } else {
        stats.unbound++;
      }
    }
    return stats;
  }

  // ─── Daten laden ───────────────────────────────────────────────────────────

  async function loadData(panel) {
    panel.innerHTML = `<p class="grisu-loading">⏳ Lade Gebäudedaten…</p>`;
    const buildingId = getCurrentBuildingId();
    try {
      const allBuildings = await fetchJSON('/api/buildings');
      const leitstelleId = parseInt(buildingId, 10);

      const LEIT_FIELDS = [
        'leitstelle_building_id', 'leitstelle_id', 'assigned_leitstelle_id',
        'dispatch_center_id', 'leitstellen_id', 'assigned_dispatch_center_building_id',
      ];

      const assigned = allBuildings.filter(b => {
        if (b.id === leitstelleId) return false;
        for (const f of LEIT_FIELDS) {
          if (b[f] != null && parseInt(b[f], 10) === leitstelleId) return true;
        }
        return false;
      });

      if (assigned.length === 0) {
        panel.innerHTML = `<p class="grisu-error">Keine zugeordneten Gebäude gefunden.<br>
          Leitstellen-ID: <code>${leitstelleId}</code></p>`;
        return;
      }

      panel.innerHTML = `<p class="grisu-loading">⏳ Lade Personal… (0/${assigned.length})</p>`;
      const BATCH = 6;
      const results = [];
      let done = 0;
      for (let i = 0; i < assigned.length; i += BATCH) {
        const batch = assigned.slice(i, i + BATCH);
        const batchResults = await Promise.all(batch.map(async b => {
          try {
            const doc = await fetchDoc(`/buildings/${b.id}/personals`);
            const personals = parsePersonalsDoc(doc);
            done++;
            const pEl = panel.querySelector('p');
            if (pEl) pEl.textContent = `⏳ Lade Personal… (${done}/${assigned.length})`;
            return { id: b.id, caption: b.caption || `Gebäude #${b.id}`, personals, stats: buildStats(personals) };
          } catch (e) {
            done++;
            return { id: b.id, caption: b.caption || `Gebäude #${b.id}`, personals: [], stats: buildStats([]), error: true };
          }
        }));
        results.push(...batchResults);
      }

      renderTable(panel, results);
    } catch (e) {
      panel.innerHTML = `<p class="grisu-error">Fehler: ${e.message || e}</p>`;
    }
  }

  // ─── Tabelle rendern ───────────────────────────────────────────────────────

  function renderTable(panel, buildings) {
    let searchVal  = '';
    let filterMode = 'all';
    let sortCol    = 'name';
    let sortDir    = 1;
    const expanded = new Set();

    // Alle im Datensatz vorkommenden Ausbildungen einsammeln (einmalig)
    const allEducations = [...new Set(
      buildings.flatMap(b => Object.keys(b.stats.byEducation))
    )].sort((a, b) => a.localeCompare(b, 'de'));

    // Pro Ausbildung: aktiv? + Mindestanzahl, ab der eine Wache als "genug besetzt" gilt
    const eduFilters = {};
    for (const edu of allEducations) {
      eduFilters[edu] = { active: false, min: 1 };
    }
    let eduFilterBoxOpen = false;

    function statusRatio(b) {
      const total = b.stats.noEducation;
      if (total === 0) return 1;
      const verf = b.stats.noEducationByStatus['Verfügbar'] || 0;
      return verf / total;
    }

    function filterBuilding(b) {
      const name = (b.caption || '').toLowerCase();
      if (searchVal && !name.includes(searchVal.toLowerCase())) return false;
      if (filterMode === 'problems' && !(statusRatio(b) < 1 && b.stats.total > 0)) return false;
      if (filterMode === 'noeducation' && !(b.stats.noEducation > 0)) return false;
      if (filterMode === 'unbound' && !(b.stats.unbound > 0)) return false;
      if (filterMode === 'empty' && !(b.stats.total === 0)) return false;

      // Ausbildungs-Schwellwert-Filter: zeige Wache nur, wenn sie bei mind. einer
      // aktivierten Ausbildung NICHT die eingestellte Mindestanzahl erreicht
      const activeEdu = allEducations.filter(edu => eduFilters[edu].active);
      if (activeEdu.length > 0) {
        const anyInsufficient = activeEdu.some(edu => {
          const count = b.stats.byEducation[edu] || 0;
          return count < eduFilters[edu].min;
        });
        if (!anyInsufficient) return false;
      }

      return true;
    }

    function sortBuildings(list) {
      return [...list].sort((a, b) => {
        let va, vb;
        if (sortCol === 'name')      { va = (a.caption || '').toLowerCase(); vb = (b.caption || '').toLowerCase(); }
        else if (sortCol === 'total')     { va = a.stats.total;            vb = b.stats.total; }
        else if (sortCol === 'verfuegbar') { va = statusRatio(a);           vb = statusRatio(b); }
        else if (sortCol === 'noeducation') { va = a.stats.noEducation;    vb = b.stats.noEducation; }
        if (va < vb) return -sortDir;
        if (va > vb) return  sortDir;
        return 0;
      });
    }

    function thCls(col) {
      return sortCol === col ? (sortDir === 1 ? 'sort-asc' : 'sort-desc') : '';
    }

    function educationBadges(stats) {
      const entries = Object.entries(stats.byEducation).sort((a, b) => a[0].localeCompare(b[0], 'de'));
      let html = entries.map(([edu, count]) =>
        `<span class="grisu-badge badge-edu">${escHtml(edu)}: ${count}</span>`
      ).join('');
      if (stats.noEducation > 0) {
        html += `<span class="grisu-badge badge-missing">Ohne Ausbildung: ${stats.noEducation}</span>`;
      }
      return html || `<span class="grisu-badge badge-none">–</span>`;
    }

    function statusBadge(b) {
      const total = b.stats.noEducation;
      if (total === 0) {
        return b.stats.total === 0
          ? `<span class="grisu-badge badge-none">Kein Personal</span>`
          : `<span class="grisu-badge badge-ok">Alle ausgebildet</span>`;
      }
      const verf = b.stats.noEducationByStatus['Verfügbar'] || 0;
      const ratio = verf / total;
      const otherStatuses = Object.entries(b.stats.noEducationByStatus).filter(([s]) => s !== 'Verfügbar');
      let cls = 'badge-ok';
      if (ratio < 0.75) cls = 'badge-missing';
      else if (ratio < 1) cls = 'badge-partial';
      let html = `<span class="grisu-badge ${cls}">${verf}/${total} unausgeb. verfügbar</span>`;
      for (const [st, count] of otherStatuses) {
        html += `<span class="grisu-badge badge-partial">${escHtml(st)}: ${count}</span>`;
      }
      return html;
    }

    function renderDetail(b) {
      const vehicleEntries = Object.entries(b.stats.byVehicle).sort((a, b2) => a[0].localeCompare(b2[0], 'de'));
      const eduEntries = Object.entries(b.stats.byEducation).sort((a, b2) => a[0].localeCompare(b2[0], 'de'));
      return `
        <div class="grisu-detail-grid">
          <div class="grisu-detail-box">
            <h4>Zuordnung zu Fahrzeugen (${vehicleEntries.length})</h4>
            ${vehicleEntries.length ? vehicleEntries.map(([veh, count]) =>
              `<div class="grisu-detail-line"><span>${escHtml(veh)}</span><span>${count}</span></div>`
            ).join('') : '<div class="grisu-detail-line"><span>Keine Zuordnungen</span></div>'}
            ${b.stats.unbound > 0 ? `<div class="grisu-detail-line"><span>Ohne Fahrzeugbindung</span><span>${b.stats.unbound}</span></div>` : ''}
          </div>
          <div class="grisu-detail-box">
            <h4>Ausbildungen (${eduEntries.length})</h4>
            ${eduEntries.length ? eduEntries.map(([edu, count]) =>
              `<div class="grisu-detail-line"><span>${escHtml(edu)}</span><span>${count}</span></div>`
            ).join('') : '<div class="grisu-detail-line"><span>Keine</span></div>'}
            ${b.stats.noEducation > 0 ? `<div class="grisu-detail-line" style="color:#ff6666 !important;"><span>Ohne Ausbildung</span><span>${b.stats.noEducation}</span></div>` : ''}
          </div>
          <div class="grisu-detail-box">
            <h4>Status (unausgebildetes Personal)</h4>
            ${Object.keys(b.stats.noEducationByStatus).length ? Object.entries(b.stats.noEducationByStatus).map(([st, count]) =>
              `<div class="grisu-detail-line"><span>${escHtml(st)}</span><span>${count}</span></div>`
            ).join('') : '<div class="grisu-detail-line"><span>Alle ausgebildet</span></div>'}
          </div>
        </div>`;
    }

    function render() {
      const filtered = buildings.filter(filterBuilding);
      const sorted   = sortBuildings(filtered);

      const totalProblems    = buildings.filter(b => statusRatio(b) < 1 && b.stats.total > 0).length;
      const totalNoEducation = buildings.filter(b => b.stats.noEducation > 0).length;
      const totalUnbound     = buildings.filter(b => b.stats.unbound > 0).length;
      const totalEmpty       = buildings.filter(b => b.stats.total === 0).length;

      const activeEduCount = allEducations.filter(edu => eduFilters[edu].active).length;

      let html = `
        <input class="grisu-search" type="text" placeholder="🔍 Wache suchen…" value="${escHtml(searchVal)}" id="${TAB_ID}-search">
        <div class="grisu-filter-row">
          <span style="font-size:12px;color:#222;font-weight:700;margin-right:4px;">Filter:</span>
          <button class="grisu-btn-filter ${filterMode==='all'?'active':''}"          data-filter="all">Alle (${buildings.length})</button>
          <button class="grisu-btn-filter ${filterMode==='problems'?'active':''}"     data-filter="problems">⚠ Unterbesetzt/Krank (${totalProblems})</button>
          <button class="grisu-btn-filter ${filterMode==='noeducation'?'active':''}"  data-filter="noeducation">Ohne Ausbildung vorhanden (${totalNoEducation})</button>
          <button class="grisu-btn-filter ${filterMode==='unbound'?'active':''}"      data-filter="unbound">Nicht gebundenes Personal (${totalUnbound})</button>
          <button class="grisu-btn-filter ${filterMode==='empty'?'active':''}"        data-filter="empty">Kein Personal (${totalEmpty})</button>
          ${allEducations.length ? `<button class="grisu-edufilter-toggle ${eduFilterBoxOpen || activeEduCount ? 'active':''}" id="${TAB_ID}-edufilter-toggle">🎓 Ausbildungsfilter ${activeEduCount ? `(${activeEduCount})` : ''}</button>` : ''}
        </div>
        ${eduFilterBoxOpen ? `
        <div class="grisu-edufilter-box">
          ${allEducations.map((edu, i) => `
            <div class="grisu-edufilter-row">
              <input type="checkbox" id="${TAB_ID}-edu-active-${i}" data-edu="${escHtml(edu)}" ${eduFilters[edu].active ? 'checked' : ''}>
              <label for="${TAB_ID}-edu-active-${i}">${escHtml(edu)} — mind.</label>
              <input type="number" min="0" class="grisu-edufilter-min" id="${TAB_ID}-edu-min-${i}" data-edu-min="${escHtml(edu)}" value="${eduFilters[edu].min}">
            </div>
          `).join('')}
        </div>` : ''}
        <div class="grisu-summary">${filtered.length} von ${buildings.length} Gebäuden — Zeile anklicken für Details</div>
        <div class="grisu-table-wrap">
          <table class="grisu-tbl">
            <thead><tr>
              <th class="grisu-col-name ${thCls('name')}" data-col="name">Wache</th>
              <th class="${thCls('total')}"                data-col="total">Gesamt</th>
              <th class="${thCls('verfuegbar')}"            data-col="verfuegbar">Status</th>
              <th class="${thCls('noeducation')}"           data-col="noeducation">Ausbildungen</th>
            </tr></thead>
            <tbody>`;

      for (const b of sorted) {
        const isOpen = expanded.has(b.id);
        html += `
          <tr class="grisu-main-row" data-bid="${b.id}">
            <td class="grisu-col-name"><a class="grisu-link" href="/buildings/${b.id}" target="_blank">${escHtml(b.caption)}</a> ${b.error ? '⚠' : ''}</td>
            <td>${b.stats.total}</td>
            <td>${statusBadge(b)}</td>
            <td><div class="grisu-badge-list">${educationBadges(b.stats)}</div></td>
          </tr>`;
        if (isOpen) {
          html += `<tr class="grisu-detail-row" data-bid-detail="${b.id}"><td colspan="4">${renderDetail(b)}</td></tr>`;
        }
      }

      html += `</tbody></table></div>`;

      const activeEl = document.activeElement;
      const activeId = activeEl && activeEl.id;
      const selStart = activeEl && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;
      const selEnd   = activeEl && typeof activeEl.selectionEnd   === 'number' ? activeEl.selectionEnd   : null;

      panel.innerHTML = html;

      document.getElementById(`${TAB_ID}-search`).addEventListener('input', e => {
        searchVal = e.target.value; render();
      });
      panel.querySelectorAll('.grisu-btn-filter').forEach(btn => {
        btn.addEventListener('click', () => { filterMode = btn.dataset.filter; render(); });
      });
      panel.querySelectorAll('th[data-col]').forEach(th => {
        th.addEventListener('click', () => {
          const col = th.dataset.col;
          if (sortCol === col) sortDir *= -1;
          else { sortCol = col; sortDir = 1; }
          render();
        });
      });
      panel.querySelectorAll('.grisu-main-row').forEach(tr => {
        tr.addEventListener('click', () => {
          const bid = parseInt(tr.dataset.bid, 10);
          if (expanded.has(bid)) expanded.delete(bid);
          else expanded.add(bid);
          render();
        });
      });

      const eduToggleBtn = document.getElementById(`${TAB_ID}-edufilter-toggle`);
      if (eduToggleBtn) {
        eduToggleBtn.addEventListener('click', () => {
          eduFilterBoxOpen = !eduFilterBoxOpen;
          render();
        });
      }
      panel.querySelectorAll('[data-edu]').forEach(cb => {
        cb.addEventListener('change', e => {
          eduFilters[cb.dataset.edu].active = e.target.checked;
          render();
        });
      });
      panel.querySelectorAll('[data-edu-min]').forEach(inp => {
        inp.addEventListener('input', e => {
          const v = parseInt(e.target.value, 10);
          eduFilters[inp.dataset.eduMin].min = Number.isFinite(v) ? v : 0;
          render();
        });
      });

      if (activeId) {
        const el = document.getElementById(activeId);
        if (el) {
          el.focus();
          if (selStart !== null && el.setSelectionRange) {
            try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* type=number erlaubt keine Selection */ }
          }
        }
      }
    }

    render();
  }

  // ─── Start ─────────────────────────────────────────────────────────────────

  function setup() {
    observer = new MutationObserver(() => {
      if (findTabContainer()) {
        observer.disconnect();
        injectStyles();
        injectTab();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    if (findTabContainer()) {
      observer.disconnect();
      injectStyles();
      injectTab();
    }
  }

  // Aufräumen beim Ausschalten
  ctx.onCleanup(() => {
    if (observer) observer.disconnect();
    if (tabLi) tabLi.remove();
    if (tabPanel) tabPanel.remove();
  });

  setup();
        },
    });

    // ======================================================================
    // MODUL 4: MissionShare NEU
    // ======================================================================
    register({
        id: 'missionshare',
        name: 'MissionShare',
        description: 'Einsätze mit Credit-/Zeit-Filter und Nachricht in der Allianz teilen.',
        where: 'Hauptseite (Einsatzliste)',
        match: loc => loc.pathname === '/' && window.top === window,

        init(ctx) {
    const $ = window.jQuery;
    if (!$) { ctx.error('jQuery nicht gefunden – Modul nicht gestartet.'); return; }

    const NS = '.lsstbMissionShare';   // Namensraum, damit alle Handler beim Ausschalten sauber entfernt werden

    // Einsatznamen filtern – nur Einsätze mit diesen Namen teilen
    const filterByMission = false; //true - Filter wird benutzt -- false - Filter wird ignoriert
    const allowedMissions = [
        "Brückeneinsturz (Groß)",
        "Brückeneinsturz (klein)",
        "Einsturz Terminal",
        "Damm droht zu brechen",
        "Gasexplosion",
        "Feuer auf Bauernhof - Groß",
        "Großbrand in Museum",
        "Brand bei Holzverarbeiter",
        "Großer Supermarkt eingestürzt",
        "Schwimmbaddach eingestürzt",
        "Brand auf Kompostieranlage",
        "Havarie in Kläranlage",
        "Brand in Getreidesilo",
        "Havariertes Flussfahrtschiff",
        "Zusammenstoß zweier Busse",
        "Wassereinbruch Großbaustelle",
        "Eingestürztes Wohnhaus",
        "Gewässer gekippt (Groß)",
        "Verschüttete Personen",
    ];
    const normName = s => String(s).toLowerCase().trim();
    const allowedNorm = allowedMissions.map(normName);

    // Freigabezeit filtern - nur Einsätze vor/nach Uhrzeit (UI gesteuert)
    const filterByTime = false;

    $("body")
        .prepend(`
        <div id="shMiModal" style="display: none;" class="modal fade">
        <div role="document" class="modal-dialog" style="width: fit-content">
            <div class="modal-content">

                <!-- Header -->
                <div class="modal-header">
                    <h3>
                        <center>Eins&auml;tze teilen</center>
                    </h3>
                </div>

                <!-- Content -->
                <br>
                <table style="width: 90%; margin-left: 10px; margin-right: 10px" id="shMiSettingsV2">
                    <style>
                        body.dark tr {
                            background-color: #505050;
                        }

                        .progress {
                            margin-bottom: 0px;
                        }

                        td {
                            padding: 2px;
                        }

                        .shMiMessage {
                            width: 21ch;
                            font: 11pt monospace;
                        }

                        .btn-shMiMessageRemove {
                            font: 11pt monospace;
                        }

                        .btn-shMiMessageAdd {
                            font: 11pt monospace;
                        }
                    </style>
                    <tr>
                        <td>
                            <h4>Einstellungen</h4>
                        </td>
                    </tr>
                    <tr title="Einsätze bis einschließlich dieser Credit-Grenze freigeben (untere Einsätze)">
                        <td>
                            <strong>
                                Credits bis:
                            </strong>
                        </td>
                        <td style="text-align: center;">
                            <input type="checkbox" id="shMiLowEnabled" title="Bereich aktiv">
                        </td>
                        <td>
                            <input type="number" id="shMiLow" class="form-control" min="0" placeholder="z. B. 1500">
                        </td>
                        <td></td>
                    </tr>
                    <tr title="Einsätze ab einschließlich dieser Credit-Grenze freigeben (obere Einsätze)">
                        <td>
                            <strong>
                                Credits ab:
                            </strong>
                        </td>
                        <td style="text-align: center;">
                            <input type="checkbox" id="shMiHighEnabled" title="Bereich aktiv">
                        </td>
                        <td>
                            <input type="number" id="shMiHigh" class="form-control" min="0" placeholder="z. B. 5000">
                        </td>
                        <td></td>
                    </tr>
                    <tr title="Eins&auml;tze nach Uhrzeit filtern">
                        <td>
                            <strong>
                                Uhrzeit:
                            </strong>
                        </td>
                        <td>
                            <select id="shMiTimeDirection" class="form-control" style="width:100px; height:30px; text-align:center;">
                                <option value="before">Vor</option>
                                <option value="after">Nach</option>
                            </select>
                        </td>
                        <td>
                            <input type="time" id="shMiTime" class="form-control" value="04:00">
                        </td>
                        <td></td>
                    </tr>
                    <tr class="shMiAddRowRow">
                        <td colspan="3"></td>
                        <td>
                            <div class="btn btn-success btn-xs btn-shMiMessageAdd">+</div>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <h4>Status</h4>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2">
                            <strong>
                                Initialisieren:
                            </strong>
                        </td>
                        <td>
                            <div class="progress">
                                <div class="progress-bar bg-success" role="progressbar" style="width: 0%" aria-valuenow="0"
                                    aria-valuemin="0" aria-valuemax="100" id="shMiPrgsInitialize"></div>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2">
                            <strong>
                                Teilen:
                            </strong>
                        </td>
                        <td>
                            <div class="progress">
                                <div class="progress-bar bg-success" role="progressbar" style="width: 0%" aria-valuenow="0"
                                    aria-valuemin="0" aria-valuemax="100" id="shMiPrgsShare"></div>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2">
                            <strong>
                                R&uuml;ckmeldung:
                            </strong>
                        </td>
                        <td>
                            <div class="progress">
                                <div class="progress-bar bg-success" role="progressbar" style="width: 0%" aria-valuenow="0"
                                    aria-valuemin="0" aria-valuemax="100" id="shMiPrgsMessage"></div>
                            </div>
                        </td>
                    </tr>
                </table>
                <br>

                <!-- Footer -->
                <div class="modal-footer">
                    <button type="button" id="shMiShare" class="btn btn-success">Freigeben</button>
                    <button type="button" class="btn btn-danger" data-dismiss="modal">Schlie&szlig;en</button>
                </div>

            </div>
        </div>
    </div>
    `);

    ctx.addStyle(`
        .modal {
              display: none;
              position: fixed;
              padding-top: 100px;
              left: 0;
              right:0;
              top: 0;
              bottom: 0;
              overflow: auto;
              background-color: rgb(0,0,0);
              background-color: rgba(0,0,0,0.4);
              z-index: 9999;
        }
        .modal-body{
              height: 650px;
              overflow-y: auto;
        }
    `);

    $(".mission-participation-filters").prepend(`<a href="#"
        class="btn btn-xs btn-default"
        id="shMiOpenModal"
        data-toggle="modal"
        data-target="#shMiModal"
        class="glyphicon glyphicon-forward">
        <span class="glyphicon glyphicon-forward"></span>&nbsp;
    </a>`);

    // Aufräumen beim Ausschalten
    ctx.onCleanup(() => {
        $("body").off(NS);
        if ($('#shMiModal').is(':visible')) {
            $('.modal-backdrop').remove();
            $('body').removeClass('modal-open');
        }
        $('#shMiModal').remove();
        $('#shMiOpenModal').remove();
    });

    var missions = new Array;
    const form = new FormData;

    (async function () {
        // migrate old settings
        if (localStorage.shMiSettings && !localStorage.shMiSettingsV2) {
            localStorage.setItem("shMiSettingsV2", JSON.stringify({ credits: JSON.parse(localStorage.shMiSettings).credits, messages: [{ c: true, m: JSON.parse(localStorage.shMiSettings).message}]}));
            localStorage.removeItem('shMiSettings');
        }
        // initialize local storage
        if (!localStorage.shMiSettingsV2) localStorage.setItem("shMiSettingsV2", JSON.stringify({ credits: 0, messages: [{ c: true, m: '' }], time: "04:00", timeDirection: "before" }));

        const data = JSON.parse(localStorage.shMiSettingsV2);
        // Migration: früher gab es nur eine Untergrenze ("credits", effektiv mind. 2500) -> wird zum Bereich "ab"
        if (data.high === undefined) {
            data.high = Math.max(Number(data.credits) || 0, 2500);
            data.highEnabled = true;
            data.low = 0;
            data.lowEnabled = false;
        }
        $("#shMiLowEnabled").prop('checked', !!data.lowEnabled);
        $("#shMiLow").val(data.low);
        $("#shMiHighEnabled").prop('checked', !!data.highEnabled);
        $("#shMiHigh").val(data.high);
        $("#shMiTime").val(data.time || "04:00");
        $("#shMiTimeDirection").val(data.timeDirection || "before");
        data.messages.forEach(message => {
            addMessageRow(message.c, message.m);
        });
    })();

    // Modal initial
    $("body").on("shown.bs.modal" + NS, "#shMiModal", async function () {
        missions = await updateShareableMissions();
    });

    // credits input event handler
    $("body").on("change" + NS, "#shMiLow, #shMiHigh, #shMiLowEnabled, #shMiHighEnabled", function () {
        saveSettings();
    });

    $("body").on("change" + NS, "#shMiTime, #shMiTimeDirection", function () {
        saveSettings();
    });

    // message input event handler
    $("body").on("change" + NS, "#shMiMessage", function () {
        saveSettings();
    });

    $("body").on("click" + NS, ".shMiMessageSelect", function () {
        saveSettings();
    });

    // message input resizing
    $("body").on("input" + NS, ".shMiMessage", function () {
        setInputWidth();
    });

    function setInputWidth() {
        const maxWidth = 128;
        const minWidth = 25;

        var maxCurrentWidth = 0;
        const inputs = document.querySelectorAll('.shMiMessage');

        inputs.forEach(input => {
            const width = input.value.length + 4;
            maxCurrentWidth = Math.max(maxCurrentWidth, width);
        });

        const clampedWidth = Math.min(Math.max(maxCurrentWidth, minWidth), maxWidth);

        inputs.forEach(input => {
            input.style.width = clampedWidth + 'ch';
        });
    }

    $("body").on("click" + NS, ".btn-shMiMessageAdd", function () {
        addMessageRow();
    });

    function addMessageRow(selected = false, text = "") {
        $('.shMiAddRowRow').before(`
        <tr class="shMiMessageRow">
            <td></td>
            <td>
                <input class="shMiMessageSelect" type="radio" name="shMiReplySelect" ${(selected) ? 'checked="checked"' : ''}>
            </td>
            <td>
                <input id="shMiMessage" class="shMiMessage form-control" value="${text}" title="Freilassen um keine Nachricht zu senden">
            </td>
            <td>
                <div class="btn btn-danger btn-xs btn-shMiMessageRemove">-</div>
            </td>
        </tr>
        `);

        $('.shMiMessageRow:first td:first')[0].innerHTML = `<strong>Nachricht:</strong>`;

        setInputWidth();
        saveSettings();

        if ($('.shMiMessageRow').length >= 10) {
            $('.btn-shMiMessageAdd').addClass('hidden');
        }
    }

    $("body").on("click" + NS, ".btn-shMiMessageRemove", function () {
        removeMessageRow(this);
    });

    function removeMessageRow(btnElement) {
        if ($('.shMiMessageRow').length > 1) {
            $(btnElement).closest('tr').remove();
        } else {
            btnElement.value = '';
        }

        $('.shMiMessageRow:first td:first')[0].innerHTML = `<strong>Nachricht:</strong>`;

        if (!$('.shMiMessageSelect:checked').length) {
            $('.shMiMessageSelect:first').prop('checked', 'checked');
        }

        $('.btn-shMiMessageAdd').removeClass('hidden');

        setInputWidth();
        saveSettings();
    }

    // Share Button event handler
    $("body").on("click" + NS, "#shMiShare", async function () {
        this.setAttribute('disabled', 'disabled');
        missions = await updateShareableMissions();
        $("#shMiPrgsInitialize").attr("aria-valuemax", missions.length).css({ "width": 0 + "%" }).text(0 + " / " + missions.length.toLocaleString());
        $("#shMiPrgsShare").attr("aria-valuemax", missions.length).css({ "width": 0 + "%" }).text(0 + " / " + missions.length.toLocaleString());
        $("#shMiPrgsMessage").attr("aria-valuemax", missions.length).css({ "width": 0 + "%" }).text(0 + " / " + missions.length.toLocaleString());
        await shareMissions(missions);
    });

    // Settings
    function saveSettings() {
        const dataArray = [];
        document.querySelectorAll('.shMiMessageRow').forEach(row => {
            const isSelected = row.querySelector('.shMiMessageSelect').checked;
            const message = row.querySelector('.shMiMessage').value;

            dataArray.push({
                c: isSelected,
                m: message
            });
        });

        localStorage.setItem("shMiSettingsV2", JSON.stringify({
            lowEnabled: $("#shMiLowEnabled").prop('checked'),
            low: $("#shMiLow").val(),
            highEnabled: $("#shMiHighEnabled").prop('checked'),
            high: $("#shMiHigh").val(),
            messages: dataArray,
            time: $("#shMiTime").val(),
            timeDirection: $("#shMiTimeDirection").val()
        }));
    }

    // Mission selection
    async function updateShareableMissions() {
        return Array.from($('#mission_list div.panel-default:not(.panel-success,.mission_panel_green)').parent()).filter(el => {
            const raw = $(el).attr("data-sortable-by");
            if (!raw) return false;
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                try {
                    parsed = JSON.parse(raw.replace(/&quot;/g, '"'));
                } catch {
                    return false;
                }
            }

            // Filter Credits
            // Zwei Bereiche, beide einschließlich, einzeln aktivierbar; ein Einsatz wird geteilt,
            // wenn er in mindestens einem aktiven Bereich liegt. Ohne aktiven Bereich wird nichts geteilt.
            const credits = parsed.average_credits == null ? NaN : Number(parsed.average_credits);
            const lowOn  = $('#shMiLowEnabled').prop('checked')  && $('#shMiLow').val()  !== '';
            const highOn = $('#shMiHighEnabled').prop('checked') && $('#shMiHigh').val() !== '';
            const creditsOk = Number.isFinite(credits) && (
                (lowOn  && credits <= Number($('#shMiLow').val())) ||
                (highOn && credits >= Number($('#shMiHigh').val()))
            );

            // Filter Einsatznamen
            let missionOk = true;
            if (filterByMission) {
                missionOk = !allowedNorm.length || allowedNorm.includes(normName(parsed.caption));
            }

            // Zeit-Filter
            let timeOk = true;
            if (filterByTime) {
                const dataSortable = el.getAttribute("data-sortable-by");
                if (dataSortable) {
                    const parsed = JSON.parse(dataSortable.replace(/&quot;/g, '"'));
                    const createdAt = new Date(parsed.created_at * 1000);

                    const [h, m] = ($("#shMiTime").val() || "04:00").split(":");
                    const todayLimit = new Date();
                    todayLimit.setHours(Number(h), Number(m), 0, 0);

                    const direction = $("#shMiTimeDirection").val() || "before";
                    if (direction === "before") {
                        timeOk = createdAt <= todayLimit;
                    } else {
                        timeOk = createdAt >= todayLimit;
                    }
                }
            }

            return creditsOk && missionOk && timeOk;
        });
    }

    // Mission Share
    // Pause zwischen den einzelnen Freigaben (in Millisekunden)
    const SHARE_DELAY_MS = 150;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Mission Share – nacheinander, mit Pause
    async function shareMissions(missions) {
       const total = missions.length;
        const msgText = $('.shMiMessageRow:has(.shMiMessageSelect:checked) .shMiMessage')[0].value;

        form.set('utf8', '\u2713');
        form.set('authenticity_token', $('meta[name="csrf-token"]').attr('content'));
        form.set('mission_reply[alliance_chat]', '0');
        form.set('mission_reply[content]', msgText);
        form.set('button', '');

       const setPrg = (sel, n) => $(sel)
        .attr('aria-valuenow', n)
        .css({ width: Math.round(n / total * 100) + '%' })
        .text(n + ' / ' + total.toLocaleString());

        let nInit = 0, nShare = 0, nMsg = 0;

       try {
        for (let i = 0; i < total; i++) {
            // Modul wurde zwischendurch ausgeschaltet oder Dialog entfernt -> abbrechen
            if (!document.getElementById('shMiModal')) break;

            const m = missions[i];
            setPrg('#shMiPrgsInitialize', ++nInit);

            try {
                await $.get('https://www.leitstellenspiel.de/' + m.id.replace('_', 's/') + '/alliance');
                setPrg('#shMiPrgsShare', ++nShare);

                if (msgText !== '') {
                    form.set('mission_reply[mission_id]', m.id.replace('mission_', ''));
                    await fetch('https://www.leitstellenspiel.de/mission_replies', {
                        method: 'POST',
                        body: new URLSearchParams(form),
                    });
                }
                setPrg('#shMiPrgsMessage', ++nMsg);
            } catch (e) {
                ctx.warn('Freigabe fehlgeschlagen für', m.id, e);
            }

            // Pause vor dem nächsten Einsatz (nach dem letzten nicht nötig)
            if (i < total - 1) await sleep(SHARE_DELAY_MS);
            }
        } finally {
            $('#shMiShare').removeAttr('disabled');
           }
         }
       },
    });

        // ======================================================================
    // MODUL 5: Massenausbau (Erweiterungen bauen / einsatzbereit setzen)
    // ======================================================================
    register({
        id: 'massenausbau',
        name: 'Massenausbau',
        description: 'Erweiterungen leitstellenübergreifend bauen (Credits) und einsatzbereit setzen, mit Leitstellenfilter.',
        where: 'Spielmenü (unter „Notizen“)',
        match: loc => window.top === window,

        init(ctx) {
    let alive = true;
    let menuObserver = null;
    let menuTimer = null;
    let fallbackTimer = null;
    let modal = null;
    let opener = null;
    let scanning = false;
    let scanAbort = false;

    // Auslöser (nur als Fallback sichtbar, wenn kein Menüeintrag gefunden wird)
    const btn = document.createElement('button');
    btn.id = 'mx-open-btn';

    function cleanClass(c) {
        return (c || '').split(/\s+/).filter(function (x) {
            return x && x.indexOf('lightbox') === -1;
        }).join(' ');
    }

    function findNotesLinks() {
        const res = [];
        const links = document.querySelectorAll('a');
        for (let i = 0; i < links.length; i++) {
            const x = links[i];
            if (x.closest('.mx-menu-entry') || x.closest('#lsstb-overlay')) continue;
            const h = x.getAttribute('href') || '';
            const t = (x.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^\/notes?(\/|\?|$)/.test(h) || /^Notizen?$/i.test(t)) res.push(x);
        }
        return res;
    }

    function openMx(e) {
        e.preventDefault();
        e.stopPropagation();
        btn.click();
    }

    function addMenuEntry() {
        if (!alive) return false;
        findNotesLinks().forEach(function (notes) {
            const li = notes.closest('li');
            const anchor = li || notes;
            const parent = anchor.parentNode;
            // Schon ein Eintrag in diesem Menü? (der Toolbox-Eintrag kann direkt hinter "Notizen" stehen)
            if (parent.querySelector(':scope > .mx-menu-entry')) return;

            let entry;
            if (li) {
                entry = document.createElement('li');
                entry.className = cleanClass(li.className) + ' mx-menu-entry';
                entry.setAttribute('role', 'presentation');
                const a = document.createElement('a');
                a.href = '#';
                a.className = cleanClass(notes.className);
                a.textContent = '🏗 Massenausbau';
                a.onclick = openMx;
                entry.appendChild(a);
            } else {
                entry = document.createElement('a');
                entry.href = '#';
                entry.className = cleanClass(notes.className) + ' mx-menu-entry';
                entry.textContent = '🏗 Massenausbau';
                entry.onclick = openMx;
            }
            parent.insertBefore(entry, anchor.nextSibling);
        });
        return document.querySelector('.mx-menu-entry') !== null;
    }

    // Reste einer eventuell noch laufenden Einzel-Version entfernen
    document.querySelectorAll('#mx-open-btn, #mx-modal, .mx-menu-entry').forEach(n => n.remove());

    addMenuEntry();
    let pending = false;
    menuObserver = new MutationObserver(function () {
        if (pending) return;
        pending = true;
        menuTimer = setTimeout(function () { pending = false; addMenuEntry(); }, 300);
    });
    menuObserver.observe(document.body, { childList: true, subtree: true });

    // Fallback: nur auf der Hauptseite, nur wenn kein Menüeintrag gefunden wurde
    fallbackTimer = setTimeout(function () {
        if (!alive) return;
        if (document.querySelector('.mx-menu-entry')) return;
        if (location.pathname !== '/') return;
        btn.textContent = '🏗 Massenausbau';
        btn.style.cssText = 'position:fixed;right:10px;bottom:80px;z-index:2147483647;padding:10px 14px;' +
            'background:#337ab7;color:#fff;border:0;border-radius:6px;font-size:16px;' +
            'box-shadow:0 2px 8px rgba(0,0,0,.5);';
        document.body.appendChild(btn);
        ctx.log('Notizen-Link nicht gefunden, Fallback-Button aktiv');
    }, 12000);

    // Aufräumen beim Ausschalten
    ctx.onCleanup(() => {
        alive = false;
        scanAbort = true;
        if (menuObserver) menuObserver.disconnect();
        clearTimeout(menuTimer);
        clearTimeout(fallbackTimer);
        document.querySelectorAll('.mx-menu-entry').forEach(n => n.remove());
        btn.remove();
        if (modal) modal.remove();
    });

    let initError = null;
    try {
        setup();
    } catch (e) {
        initError = e;
        ctx.error('Initialisierungsfehler', e);
    }

    btn.onclick = function () {
        if (initError) { alert('Massenausbau-Fehler: ' + initError); return; }
        if (opener) opener();
    };

    function setup() {
        const TYPE_NAMES = {
            0: 'Feuerwache', 1: 'Feuerwehrschule', 2: 'Rettungswache', 3: 'Rettungsschule',
            4: 'Krankenhaus', 5: 'Rettungshubschrauber-Station', 6: 'Polizeiwache',
            7: 'Leitstelle', 8: 'Polizeischule', 9: 'THW', 10: 'THW Bundesschule',
            11: 'Bereitschaftspolizei', 12: 'SEG', 13: 'Polizeihubschrauber-Station',
            14: 'Bereitstellungsraum', 15: 'Wasserrettung', 17: 'Polizei-Sondereinheit',
            18: 'Feuerwache (Kleinwache)', 19: 'Polizeiwache (Kleinwache)',
            20: 'Rettungswache (Kleinwache)'
        };
        const typeName = t => TYPE_NAMES[t] || ('Typ ' + t);
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const csrf = () => { const m = document.querySelector('meta[name="csrf-token"]'); return m ? m.content : ''; };
        const fmt = n => Number(n).toLocaleString('de-DE');
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const firstNum = function () {
            for (let i = 0; i < arguments.length; i++) {
                const v = arguments[i];
                if (typeof v === 'number' && !isNaN(v)) return v;
            }
            return null;
        };

        // ---------- Einstellungen für den Scan ----------
        const CONCURRENCY = 4;                 // gleichzeitige Requests (bei HTTP 429 im Log auf 2-3 senken)
        const CACHE_TTL = 15 * 60 * 1000;      // Scan-Ergebnisse 15 Minuten wiederverwenden
        const CACHE_KEY = 'mx-scan-cache-v2';

        let buildings = [];
        let scanned = [];                      // [{b, links, acts}]
        let scannedLs = {};
        let lsList = [];
        let credits = null;
        let mode = 'build';                    // 'build' | 'activate'

        // ---------- Cache ----------
        let cache = {};
        try {
            cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
            const now = Date.now();
            Object.keys(cache).forEach(function (k) {
                if (!cache[k] || !cache[k].links || !cache[k].acts || now - cache[k].t > CACHE_TTL) delete cache[k];
            });
        } catch (e) { cache = {}; }
        function saveCache() {
            try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* voll/gesperrt: egal */ }
        }
        // JSON macht aus NaN ein null -> wieder zu NaN, sonst würde ein unbekannter Preis als 0 gelten
        function normLink(l) {
            return {
                extId: l.extId,
                name: l.name,
                cost: (l.cost === null || l.cost === undefined) ? NaN : l.cost,
                href: l.href
            };
        }

        // ---------- Request mit Wiederholung bei Überlastung ----------
        async function fetchRetry(url, opts, retry5xx) {
            let lastStatus = 0;
            for (let i = 0; i < 4; i++) {
                const res = await fetch(url, opts);
                lastStatus = res.status;
                if (res.status === 429 || (retry5xx && res.status >= 500)) {
                    const ra = parseInt(res.headers.get('Retry-After') || '', 10);
                    await sleep((isNaN(ra) ? 1000 * (i + 1) : ra * 1000) + Math.random() * 300);
                    continue;
                }
                return res;
            }
            throw new Error('HTTP ' + lastStatus + ' (zu viele Versuche)');
        }

        // ---------- Parallel-Ausführung mit Limit ----------
        async function runPool(items, limit, worker) {
            let idx = 0;
            const runners = [];
            for (let k = 0; k < limit; k++) {
                runners.push((async function () {
                    while (idx < items.length && !scanAbort) {
                        const my = idx++;
                        await worker(items[my], my);
                    }
                })());
            }
            await Promise.all(runners);
        }

        function lsKey(b) {
            if (b.leitstelle_building_id !== null && b.leitstelle_building_id !== undefined) return String(b.leitstelle_building_id);
            if (b.building_type === 7) return String(b.id);
            return 'none';
        }

        // ---------- Fenster ----------
        modal = document.createElement('div');
        modal.id = 'mx-modal';
        modal.style.cssText = 'display:none;position:fixed;top:5%;left:50%;transform:translateX(-50%);' +
            'width:700px;max-width:95vw;max-height:88vh;overflow:auto;background:#fff;color:#000;' +
            'border:2px solid #444;border-radius:6px;padding:15px;z-index:2147483647;box-shadow:0 0 25px #000;';
        modal.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<h4 style="margin:0">Erweiterungen leitstellenübergreifend</h4>' +
            '<button id="mx-close" class="btn btn-default btn-xs">✕</button></div><hr>' +
            '<div style="margin-bottom:8px">' +
            '<label style="font-weight:normal;margin-right:14px"><input type="radio" name="mx-mode" value="build" checked> Bauen (Credits)</label>' +
            '<label style="font-weight:normal"><input type="radio" name="mx-mode" value="activate"> Einsatzbereit setzen</label></div>' +
            '<div id="mx-status">Lade Gebäude…</div>' +
            '<div style="margin:10px 0;padding:8px;border:1px solid #ccc;border-radius:4px">' +
            '<b>Leitstellen</b> ' +
            '<button id="mx-ls-all" class="btn btn-default btn-xs">Alle</button> ' +
            '<button id="mx-ls-none" class="btn btn-default btn-xs">Keine</button>' +
            '<div id="mx-ls" style="max-height:160px;overflow:auto;margin-top:6px"></div></div>' +
            '<div style="margin:10px 0">' +
            '<select id="mx-type" class="form-control" style="display:inline-block;width:auto" disabled></select> ' +
            '<button id="mx-scan" class="btn btn-info btn-sm" disabled>Erweiterungen suchen</button> ' +
            '<label style="font-weight:normal;margin-left:8px"><input type="checkbox" id="mx-fresh"> Cache ignorieren</label></div>' +
            '<div id="mx-hint" style="color:#b94a00;margin-bottom:6px"></div>' +
            '<div id="mx-list"></div>' +
            '<div id="mx-actions" style="display:none;margin-top:10px">' +
            '<div id="mx-summary" style="padding:8px;border:1px solid #ccc;border-radius:4px;margin-bottom:8px"></div>' +
            '<button id="mx-refresh" class="btn btn-default btn-sm">Credits aktualisieren</button> ' +
            '<button id="mx-build" class="btn btn-success" disabled>Ausgewählte bauen</button>' +
            '<button id="mx-act" class="btn btn-success" disabled style="display:none">Ausgewählte einsatzbereit setzen</button></div>' +
            '<pre id="mx-log" style="max-height:200px;overflow:auto;margin-top:10px;display:none"></pre>';
        document.body.appendChild(modal);

        const $ = id => modal.querySelector('#' + id);
        const log = msg => {
            const l = $('mx-log');
            l.style.display = 'block';
            l.textContent += msg + '\n';
            l.scrollTop = l.scrollHeight;
        };

        opener = async function () {
            modal.style.display = 'block';
            if (!buildings.length) {
                try { await loadBuildings(); }
                catch (e) { $('mx-status').textContent = 'Fehler beim Laden: ' + e; }
            }
        };
        $('mx-close').onclick = () => { modal.style.display = 'none'; };

        // ---------- Modus ----------
        modal.querySelectorAll('input[name="mx-mode"]').forEach(function (r) {
            r.onchange = async function () {
                mode = r.value;
                if (scanned.length) renderList();
                if (mode === 'build' && scanned.length && credits === null) await refreshCredits();
            };
        });

        // ---------- Leitstellenfilter ----------
        function selectedLsKeys() {
            return Array.prototype.map.call(modal.querySelectorAll('.mx-ls:checked'), c => c.value);
        }

        function renderLs() {
            $('mx-ls').innerHTML = lsList.map(ls =>
                '<div><label style="font-weight:normal"><input type="checkbox" class="mx-ls" value="' + ls.key + '" checked> ' +
                esc(ls.name) + ' <small>(' + ls.count + ' Gebäude)</small></label></div>'
            ).join('');
            modal.querySelectorAll('.mx-ls').forEach(c => { c.onchange = onLsChange; });
        }

        function onLsChange() {
            rebuildTypeOptions();
            if (scanned.length) renderList();
            updateHint();
        }

        function updateHint() {
            if (!scanned.length) { $('mx-hint').textContent = ''; return; }
            const missing = selectedLsKeys().filter(k => !scannedLs[k]);
            $('mx-hint').textContent = missing.length
                ? '⚠ ' + missing.length + ' gewählte Leitstelle(n) wurden noch nicht gescannt – bitte „Erweiterungen suchen“ erneut klicken.'
                : '';
        }

        $('mx-ls-all').onclick = () => {
            modal.querySelectorAll('.mx-ls').forEach(c => { c.checked = true; });
            onLsChange();
        };
        $('mx-ls-none').onclick = () => {
            modal.querySelectorAll('.mx-ls').forEach(c => { c.checked = false; });
            onLsChange();
        };

        function rebuildTypeOptions() {
            const keys = selectedLsKeys();
            const counts = {};
            buildings.forEach(b => {
                if (keys.indexOf(lsKey(b)) === -1) return;
                counts[b.building_type] = (counts[b.building_type] || 0) + 1;
            });
            const sel = $('mx-type');
            const prev = sel.value;
            sel.innerHTML = Object.keys(counts).map(Number).sort((a, b) => a - b)
                .map(t => '<option value="' + t + '">' + typeName(t) + ' (' + counts[t] + ')</option>').join('');
            if (prev && counts[prev]) sel.value = prev;
            sel.disabled = !Object.keys(counts).length;
            $('mx-scan').disabled = sel.disabled;
        }

        // ---------- Credits ----------
        async function fetchCredits() {
            const urls = ['/api/credits', '/api/userinfo'];
            for (const url of urls) {
                try {
                    const j = await (await fetch(url, { credentials: 'same-origin' })).json();
                    const v = firstNum(j.credits_user_current, j.user_credits, j.credits_user, j.credits);
                    if (v !== null) return v;
                } catch (e) { /* nächste Quelle */ }
            }
            return null;
        }

        async function refreshCredits() {
            credits = await fetchCredits();
            if (credits === null) {
                const input = prompt('Credits konnten nicht automatisch gelesen werden.\nBitte aktuellen Credit-Stand eingeben:');
                const n = parseInt((input || '').replace(/[^\d]/g, ''), 10);
                credits = isNaN(n) ? null : n;
            }
            updateSummary();
        }

        function parseCost(rowText, linkText) {
            const m = (rowText || '').match(/([\d.,]+)\s*Credits/i) || (linkText || '').match(/([\d.,]+)/);
            if (!m) return NaN;
            const n = parseInt(m[1].replace(/[^\d]/g, ''), 10);
            return isNaN(n) ? NaN : n;
        }

        // ---------- Gebäude laden ----------
        async function loadBuildings() {
            $('mx-status').textContent = 'Lade alle Gebäude…';
            buildings = await (await fetch('/api/buildings', { credentials: 'same-origin' })).json();

            const names = {};
            buildings.forEach(b => { if (b.building_type === 7) names[String(b.id)] = b.caption; });
            const cnt = {};
            buildings.forEach(b => { const k = lsKey(b); cnt[k] = (cnt[k] || 0) + 1; });
            lsList = Object.keys(cnt).map(k => ({
                key: k,
                name: k === 'none' ? 'Ohne Zuordnung' : (names[k] || ('Leitstelle ' + k)),
                count: cnt[k]
            })).sort((a, b) => a.name.localeCompare(b.name));

            renderLs();
            rebuildTypeOptions();
            $('mx-status').textContent = buildings.length + ' Gebäude aus ' + lsList.length + ' Leitstellen-Gruppen geladen.';
        }

        // ---------- Gebäudeseite auswerten ----------
        function rowOf(a) {
            return a.closest('tr') || a.closest('.row') || (a.parentNode ? a.parentNode.parentNode : null);
        }
        function rowTitle(row, fallback) {
            if (!row) return fallback;
            const bold = row.querySelector('b, strong');
            const src = bold || row.querySelector('td') || row;
            const t = (src.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
            return t || fallback;
        }

        function parsePage(html, b) {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const links = [];
            const acts = [];
            const seen = {};

            // Baubare Erweiterungen (Credits)
            doc.querySelectorAll('a[href*="/credits"]').forEach(function (a) {
                const href = a.getAttribute('href') || '';
                if (href.indexOf('/buildings/' + b.id + '/') === -1) return;
                const m = href.match(/\/buildings\/\d+\/(?:extension|expand_do|specialization)[^?]*\/credits\/?([^?\s]*)/);
                if (!m) { log('Unbekanntes Credit-Link-Format: ' + href); return; }
                const extId = m[1] || href;
                if (seen[extId]) return;
                seen[extId] = true;
                const row = a.closest('tr');
                const firstTd = row ? row.querySelector('td') : null;
                const name = firstTd ? firstTd.textContent.trim().replace(/\s+/g, ' ') : ('Erweiterung ' + extId);
                const linkText = a.textContent.trim().replace(/\s+/g, ' ');
                const rowText = row ? row.textContent.replace(/\s+/g, ' ') : '';
                links.push({ extId: extId, name: name, cost: parseCost(rowText, linkText), href: href });
            });

            // Fertige, aber nicht einsatzbereite Erweiterungen:
            // Knopf mit exakt dem Text "Einsatzbereit" in einer Zeile mit "Nicht einsatzbereit"
            const seenAct = {};
            doc.querySelectorAll('a').forEach(function (a) {
                const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
                if (!/^einsatzbereit$/i.test(t)) return;
                const href = a.getAttribute('href') || '';
                if (!href || href === '#' || href.indexOf('javascript:') === 0) return;
                const row = rowOf(a);
                if (!row || !/nicht einsatzbereit/i.test(row.textContent || '')) return;
                if (seenAct[href]) return;
                seenAct[href] = true;
                acts.push({
                    name: rowTitle(row, 'Erweiterung'),
                    href: href,
                    method: (a.getAttribute('data-method') || 'get').toLowerCase()
                });
            });
            if (!acts.length && /nicht einsatzbereit/i.test(doc.body ? doc.body.textContent : '')) {
                log('Hinweis ' + b.caption + ': „Nicht einsatzbereit“ gefunden, aber kein Einsatzbereit-Link (evtl. ein Formular-Knopf).');
            }
            return { links: links, acts: acts };
        }

        // ---------- Scan (parallel, mit Cache und Abbruch) ----------
        $('mx-scan').onclick = async function () {
            if (scanning) {
                scanAbort = true;
                $('mx-scan').textContent = 'Breche ab…';
                return;
            }
            const type = Number($('mx-type').value);
            const keys = selectedLsKeys();
            const targets = buildings.filter(b => b.building_type === type && keys.indexOf(lsKey(b)) !== -1);
            if (!targets.length) { alert('Keine Gebäude für diese Auswahl.'); return; }
            const fresh = $('mx-fresh').checked;

            scanning = true;
            scanAbort = false;
            scanned = [];
            scannedLs = {};
            $('mx-list').innerHTML = '';
            $('mx-hint').textContent = '';
            $('mx-actions').style.display = 'none';
            $('mx-scan').textContent = 'Abbrechen';
            $('mx-type').disabled = true;

            const results = {};
            let done = 0, cached = 0, errors = 0;
            const t0 = Date.now();

            await runPool(targets, CONCURRENCY, async function (b) {
                const entry = cache[b.id];
                if (!fresh && entry && Date.now() - entry.t < CACHE_TTL) {
                    results[b.id] = { links: entry.links.map(normLink), acts: entry.acts };
                    cached++;
                } else {
                    try {
                        const res = await fetchRetry('/buildings/' + b.id, { credentials: 'same-origin' }, true);
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        const parsed = parsePage(await res.text(), b);
                        results[b.id] = parsed;
                        cache[b.id] = { t: Date.now(), links: parsed.links, acts: parsed.acts };
                    } catch (e) {
                        errors++;
                        log('Fehler beim Scan von ' + b.caption + ': ' + e);
                    }
                    await sleep(60);
                }
                done++;
                $('mx-status').textContent = 'Scanne ' + done + '/' + targets.length +
                    (cached ? ' (' + cached + ' aus Cache)' : '') + '…';
            });

            saveCache();
            targets.forEach(function (b) {
                if (results[b.id]) scanned.push({ b: b, links: results[b.id].links, acts: results[b.id].acts });
            });
            const aborted = scanAbort;
            if (!aborted) keys.forEach(function (k) { scannedLs[k] = true; });

            scanning = false;
            scanAbort = false;
            $('mx-scan').textContent = 'Erweiterungen suchen';
            rebuildTypeOptions();

            const secs = Math.round((Date.now() - t0) / 1000);
            if (aborted && !scanned.length) {
                $('mx-status').textContent = 'Scan abgebrochen.';
                return;
            }
            $('mx-status').textContent = (aborted ? 'Scan abgebrochen: ' : 'Scan fertig: ') + scanned.length +
                ' Gebäude in ' + secs + ' s (' + cached + ' aus Cache' + (errors ? ', ' + errors + ' Fehler' : '') + ').';
            renderList();
            updateHint();
            if (mode === 'build') await refreshCredits();
        };

        function activeScanned() {
            const keys = selectedLsKeys();
            return scanned.filter(s => keys.indexOf(lsKey(s.b)) !== -1);
        }

        function computeExtMap() {
            const map = {};
            activeScanned().forEach(s => s.links.forEach(l => {
                if (!map[l.extId]) map[l.extId] = Object.assign({}, l, { count: 0 });
                map[l.extId].count++;
            }));
            return map;
        }

        // Inaktive Erweiterungen werden über den Namen gruppiert (die IDs sind pro Gebäude verschieden)
        function computeActMap() {
            const map = {};
            activeScanned().forEach(s => s.acts.forEach(a => {
                if (!map[a.name]) map[a.name] = { name: a.name, count: 0 };
                map[a.name].count++;
            }));
            return map;
        }

        function renderList() {
            const checkedBefore = Array.prototype.map.call(modal.querySelectorAll('.mx-ext:checked'), c => c.value);
            let html = '';

            if (mode === 'build') {
                const items = Object.entries(computeExtMap()).sort((a, b) => a[1].name.localeCompare(b[1].name));
                if (!items.length) {
                    $('mx-list').innerHTML = '<i>Keine mit Credits baubaren Erweiterungen für diese Auswahl gefunden (evtl. alles gebaut).</i>';
                    $('mx-actions').style.display = 'none';
                    return;
                }
                html = items.map(([k, v]) => {
                    const price = isNaN(v.cost) ? '<span style="color:red">Preis unbekannt</span>' : fmt(v.cost) + ' Credits';
                    const extra = isNaN(v.cost) ? '' : ', gesamt ' + fmt(v.cost * v.count) + ' Credits';
                    const chk = checkedBefore.indexOf(k) !== -1 ? ' checked' : '';
                    return '<div><label><input type="checkbox" class="mx-ext" value="' + esc(k) + '"' + chk + '> ' +
                        '<b>' + esc(v.name) + '</b> – ' + price +
                        ' <small>(fehlt in ' + v.count + ' Gebäuden' + extra + ')</small></label></div>';
                }).join('');
            } else {
                const items = Object.values(computeActMap()).sort((a, b) => a.name.localeCompare(b.name));
                if (!items.length) {
                    $('mx-list').innerHTML = '<i>Keine Erweiterungen mit „Nicht einsatzbereit“ für diese Auswahl gefunden.</i>';
                    $('mx-actions').style.display = 'none';
                    return;
                }
                html = items.map(v => {
                    const key = encodeURIComponent(v.name);
                    const chk = checkedBefore.indexOf(key) !== -1 ? ' checked' : '';
                    return '<div><label><input type="checkbox" class="mx-ext" value="' + key + '"' + chk + '> ' +
                        '<b>' + esc(v.name) + '</b> <small>(nicht einsatzbereit in ' + v.count + ' Gebäuden)</small></label></div>';
                }).join('');
            }

            $('mx-list').innerHTML = html;
            modal.querySelectorAll('.mx-ext').forEach(c => { c.onchange = updateSummary; });
            $('mx-actions').style.display = 'block';
            updateSummary();
        }

        // ---------- Jobs & Summe ----------
        function selectedValues() {
            return Array.prototype.map.call(modal.querySelectorAll('.mx-ext:checked'), c => c.value);
        }

        function selectedJobs() {
            const ids = selectedValues();
            const jobs = [];
            activeScanned().forEach(s => s.links.forEach(l => {
                if (ids.indexOf(l.extId) !== -1) jobs.push({ b: s.b, l: l });
            }));
            return jobs;
        }

        function selectedActJobs() {
            const names = selectedValues().map(decodeURIComponent);
            const jobs = [];
            activeScanned().forEach(s => s.acts.forEach(a => {
                if (names.indexOf(a.name) !== -1) jobs.push({ b: s.b, a: a });
            }));
            return jobs;
        }

        function updateSummary() {
            const isBuild = mode === 'build';
            $('mx-refresh').style.display = isBuild ? '' : 'none';
            $('mx-build').style.display = isBuild ? '' : 'none';
            $('mx-act').style.display = isBuild ? 'none' : '';

            if (!isBuild) {
                const jobs = selectedActJobs();
                $('mx-summary').innerHTML = jobs.length
                    ? 'Einsatzbereit setzen: <b>' + jobs.length + '</b> Erweiterungen in <b>' + new Set(jobs.map(j => j.b.id)).size +
                      '</b> Gebäuden (<b>' + new Set(jobs.map(j => lsKey(j.b))).size + '</b> Leitstellen)'
                    : 'Nichts ausgewählt.';
                $('mx-act').disabled = !jobs.length;
                return;
            }

            const jobs = selectedJobs();
            const unknown = jobs.some(j => isNaN(j.l.cost));
            const total = jobs.reduce((s, j) => s + (isNaN(j.l.cost) ? 0 : j.l.cost), 0);
            const buildingsCount = new Set(jobs.map(j => j.b.id)).size;
            const lsCount = new Set(jobs.map(j => lsKey(j.b))).size;
            const creditsTxt = credits === null ? '<span style="color:red">unbekannt</span>' : fmt(credits) + ' Credits';

            let state = '';
            let canBuild = false;
            if (!jobs.length) {
                state = 'Nichts ausgewählt.';
            } else if (unknown) {
                state = '<b style="color:red">⚠ Für mindestens eine Erweiterung ist der Preis unbekannt – Bauen gesperrt.</b>';
            } else if (credits === null) {
                state = '<b style="color:red">⚠ Credit-Stand unbekannt – Bauen gesperrt. „Credits aktualisieren“ klicken.</b>';
            } else if (total > credits) {
                state = '<b style="color:red">✖ Zu wenig Credits – es fehlen ' + fmt(total - credits) + ' Credits.</b>';
            } else {
                state = '<b style="color:green">✔ Ausreichend Credits – danach bleiben ' + fmt(credits - total) + ' übrig.</b>';
                canBuild = true;
            }

            $('mx-summary').innerHTML =
                'Ausbauten: <b>' + jobs.length + '</b> in <b>' + buildingsCount + '</b> Gebäuden (<b>' + lsCount + '</b> Leitstellen)<br>' +
                'Gesamtkosten: <b>' + fmt(total) + ' Credits</b><br>' +
                'Dein Guthaben: <b>' + creditsTxt + '</b><br>' + state;
            $('mx-build').disabled = !canBuild;
        }

        $('mx-refresh').onclick = refreshCredits;

        // ---------- Bauen ----------
        $('mx-build').onclick = async () => {
            await refreshCredits();
            const jobs = selectedJobs();
            if (!jobs.length) { alert('Nichts ausgewählt.'); return; }
            if (jobs.some(j => isNaN(j.l.cost)) || credits === null) { alert('Preis oder Credit-Stand unbekannt.'); return; }

            const total = jobs.reduce((s, j) => s + j.l.cost, 0);
            if (total > credits) { alert('Zu wenig Credits! Benötigt: ' + fmt(total) + ', vorhanden: ' + fmt(credits) + '.'); return; }
            if (!confirm(jobs.length + ' Ausbauten in ' + new Set(jobs.map(j => j.b.id)).size +
                ' Gebäuden (' + new Set(jobs.map(j => lsKey(j.b))).size + ' Leitstellen) für ' + fmt(total) + ' Credits starten?')) return;

            $('mx-build').disabled = true;
            let ok = 0, fail = 0, remaining = credits;
            const okJobs = [];
            for (let i = 0; i < jobs.length; i++) {
                if (!alive) break;   // Modul wurde ausgeschaltet
                const b = jobs[i].b;
                const l = jobs[i].l;
                if (l.cost > remaining) {
                    log('⏹ Abbruch: nicht genug Credits für ' + b.caption + ': ' + l.name);
                    fail += jobs.length - i;
                    break;
                }
                $('mx-status').textContent = 'Baue ' + (i + 1) + '/' + jobs.length + '…';
                try {
                    // POST wird nur bei HTTP 429 wiederholt (nicht bei 5xx), damit nichts doppelt gebaut wird
                    const res = await fetchRetry(l.href, {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'X-CSRF-Token': csrf(), 'X-Requested-With': 'XMLHttpRequest' }
                    }, false);
                    if (res.ok) {
                        ok++;
                        remaining -= l.cost;
                        okJobs.push(jobs[i]);
                        log('✔ ' + b.caption + ': ' + l.name + ' (' + fmt(l.cost) + ' Credits)');
                    } else {
                        fail++;
                        log('✖ ' + b.caption + ': ' + l.name + ' (HTTP ' + res.status + ')');
                    }
                } catch (e) {
                    fail++;
                    log('✖ ' + b.caption + ': ' + l.name + ' (' + e + ')');
                }
                await sleep(400);
            }

            // Gebaute Erweiterungen aus Liste und Cache entfernen
            okJobs.forEach(function (j) {
                delete cache[j.b.id];
                scanned.forEach(function (s) {
                    if (s.b.id === j.b.id) s.links = s.links.filter(function (x) { return x.extId !== j.l.extId; });
                });
            });
            saveCache();

            $('mx-status').textContent = 'Fertig: ' + ok + ' gestartet, ' + fail + ' fehlgeschlagen/übersprungen.';
            renderList();
            await refreshCredits();
        };

        // ---------- Einsatzbereit setzen ----------
        $('mx-act').onclick = async () => {
            const jobs = selectedActJobs();
            if (!jobs.length) { alert('Nichts ausgewählt.'); return; }
            if (!confirm(jobs.length + ' Erweiterungen in ' + new Set(jobs.map(j => j.b.id)).size +
                ' Gebäuden (' + new Set(jobs.map(j => lsKey(j.b))).size + ' Leitstellen) auf „Einsatzbereit“ setzen?')) return;

            $('mx-act').disabled = true;
            let ok = 0, fail = 0;
            const okJobs = [];
            log('Methode/Link des ersten Auftrags: ' + jobs[0].a.method.toUpperCase() + ' ' + jobs[0].a.href);

            for (let i = 0; i < jobs.length; i++) {
                if (!alive) break;   // Modul wurde ausgeschaltet
                const b = jobs[i].b;
                const a = jobs[i].a;
                $('mx-status').textContent = 'Setze einsatzbereit ' + (i + 1) + '/' + jobs.length + '…';
                try {
                    const opts = {
                        credentials: 'same-origin',
                        headers: { 'X-CSRF-Token': csrf(), 'X-Requested-With': 'XMLHttpRequest' }
                    };
                    if (a.method !== 'get') opts.method = a.method.toUpperCase();
                    const res = await fetchRetry(a.href, opts, false);
                    if (res.ok) {
                        ok++;
                        okJobs.push(jobs[i]);
                        log('✔ ' + b.caption + ': ' + a.name);
                    } else {
                        fail++;
                        log('✖ ' + b.caption + ': ' + a.name + ' (HTTP ' + res.status + ')');
                    }
                } catch (e) {
                    fail++;
                    log('✖ ' + b.caption + ': ' + a.name + ' (' + e + ')');
                }
                await sleep(300);
            }

            okJobs.forEach(function (j) {
                delete cache[j.b.id];
                scanned.forEach(function (s) {
                    if (s.b.id === j.b.id) s.acts = s.acts.filter(function (x) { return x.href !== j.a.href; });
                });
            });
            saveCache();

            $('mx-status').textContent = 'Fertig: ' + ok + ' einsatzbereit gesetzt, ' + fail + ' fehlgeschlagen.';
            renderList();
        };
    }
        },
    });
  /*
 * LSS-Toolbox-Modul: Lehrgangszuweiser (Zusatzausbildung)
 * Basis: "Lehrgangszuweiser" von BOS-Ernie, angepasst (v0.6.0)
 *
 * Funktionen:
 *  - Zahlenfeld + Button "Auswählen" pro Wache (beliebig viele Personen, höchstens so viele wie verfügbar)
 *  - Abfrage "Zusatzausbildung": nein = nur Personal ohne Ausbildung, ja = nur Personal mit gewähltem Basislehrgang
 *  - setzt nur Häkchen in der Lehrgangs-Auswahl; der Lehrgang wird weiterhin von dir mit dem normalen Button gestartet
 *
 * Läuft nur auf /buildings/* und /schoolings/* (Schulungsseiten). Seiten-Funktionen (jQuery, update_costs, ...)
 * werden über unsafeWindow angesprochen, falls die Toolbox eine Sandbox (@grant) nutzt.
 *
 * Aufruf aus der Toolbox:  LehrgangszuweiserModule.init();
 */
const LehrgangszuweiserModule = (function () {
  "use strict";

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  function matches() {
    return /^\/(buildings|schoolings)\//.test(location.pathname);
  }

  function run() {
    const $ = W.$;

    // ---------------------------------------------------------------------
    // Hilfsfunktionen für die Ausbildungs-Prüfung
    // ---------------------------------------------------------------------
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

    // Name aus dem Label eines Lehrgangs-Radiobuttons (Dauer/Kosten abschneiden)
    const cleanName = (s) =>
      String(s || "")
        .replace(/\s+/g, " ")
        .trim()
        .split(/\s*[\(\[]|\s+\d/)[0]
        .trim();

    // Passt ein Eintrag der Ausbildungs-Spalte zu einem Lehrgangsnamen?
    function matches(part, name) {
      const p = norm(part);
      const n = norm(name);
      if (!p || !n) return false;
      if (p === n) return true;
      if (n.length >= 4 && p.includes(n)) return true;
      if (p.length >= 4 && n.includes(p)) return true;
      return false;
    }

    // Ausbildungen einer Person (aus der Spalte "Ausbildung"), null = Zelle nicht gefunden
    function educationsOf(checkbox) {
      const cell = document.getElementById(
        "school_personal_education_" + $(checkbox).val()
      );
      if (!cell) return null;
      return cell.textContent
        .split(/[,;\n]+/)
        .map((x) => x.replace(/\s+/g, " ").trim())
        .filter(Boolean);
    }

    // Lehrgänge der aktuellen Schule (Radiobuttons der Lehrgangsauswahl)
    function schoolEducations() {
      const seen = new Set();
      const out = [];
      document.querySelectorAll("input[name=education]").forEach((r) => {
        const el = r.closest("label") || r.parentElement;
        const t = cleanName(el ? el.textContent : "");
        if (t && !seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      });
      return out;
    }

    // Der aktuell gewählte (Ziel-)Lehrgang
    function selectedTarget() {
      const r = document.querySelector("input[name=education]:checked");
      if (!r) return "";
      const el = r.closest("label") || r.parentElement;
      return cleanName(el ? el.textContent : "");
    }

    // ---------------------------------------------------------------------
    // Einstellungsbox: Zusatzausbildung ja/nein + Basislehrgang
    // ---------------------------------------------------------------------
    function createOptionsBox() {
      const box = document.createElement("div");
      box.id = "schooling-assigner-options";
      box.className = "well well-sm";
      box.innerHTML =
        '<label style="font-weight:bold;margin:0">' +
        '<input type="checkbox" id="sa-extra"> Zusatzausbildung ' +
        "(nur Personal mit Basislehrgang auswählen)</label>" +
        '<div id="sa-basis-wrap" style="display:none;margin-top:6px">' +
        'Basislehrgang: <input type="text" id="sa-basis" list="sa-basis-list" ' +
        'class="form-control input-sm" style="display:inline-block;width:320px" ' +
        'placeholder="aus der Schule wählen oder eintippen">' +
        '<datalist id="sa-basis-list"></datalist></div>' +
        '<div class="text-muted" id="sa-hint" style="margin-top:4px"></div>';

      const extra = box.querySelector("#sa-extra");
      const wrap = box.querySelector("#sa-basis-wrap");
      const basis = box.querySelector("#sa-basis");

      const refresh = () => {
        wrap.style.display = extra.checked ? "" : "none";
        box.querySelector("#sa-hint").textContent = extra.checked
          ? "Es wird nur Personal ausgewählt, das den Basislehrgang hat und den gewählten Lehrgang noch nicht besitzt."
          : "Es wird nur Personal ohne jede Ausbildung ausgewählt.";
        fillList();
      };
      const fillList = () => {
        const dl = box.querySelector("#sa-basis-list");
        dl.innerHTML = "";
        schoolEducations().forEach((name) => {
          const o = document.createElement("option");
          o.value = name;
          dl.appendChild(o);
        });
      };

      extra.addEventListener("change", refresh);
      basis.addEventListener("focus", fillList);
      refresh();
      return box;
    }

    function getMode() {
      const extra = document.getElementById("sa-extra");
      const basis = document.getElementById("sa-basis");
      return {
        extra: !!(extra && extra.checked),
        basis: basis ? basis.value.trim() : "",
      };
    }

    // ---------------------------------------------------------------------
    // Aufbau der Oberfläche
    // ---------------------------------------------------------------------
    let elements = document.getElementsByClassName(
      "panel-heading personal-select-heading"
    );
    for (let i = 0; i < elements.length; i++) {
      let buildingId = elements[i].getAttribute("building_id");
      elements[i].children[0].appendChild(createPersonnelSelector(buildingId));
    }

    if (elements.length) {
      const panel = elements[0].closest(".panel");
      if (panel && panel.parentNode) {
        panel.parentNode.insertBefore(createOptionsBox(), panel);
      }
    }

    $(".personal-select-heading")
      .unbind("click")
      .bind("click", panelHeadingClickEvent);

    async function selectPersonnelClick(event) {
      const buildingId = event.currentTarget.dataset.buildingId;
      const input = document.getElementById(
        "schooling-assigner-count-" + buildingId
      );
      await selectPersonnel(buildingId, input ? input.value : "");
      event.preventDefault();
    }

    async function resetPersonnelClick(event) {
      await resetPersonnel(event.target.dataset.buildingId);
      event.preventDefault();
    }

    async function panelHeadingClickEvent(event) {
      // Skip redundant panelHeadingClick call which is handled by button click event
      if (
        event.target.classList.contains("schooling-personnel-select-button") ||
        event.target.parentNode.classList.contains(
          "schooling-personnel-reset-button"
        )
      ) {
        return;
      }

      let buildingIdElement = event.target.outerHTML.match(/building_id="(\d+)"/);
      if (buildingIdElement === null) {
        buildingIdElement =
          event.target.parentElement.parentElement.parentElement.parentElement.outerHTML.match(
            /building_id="(\d+)"/
          );
      }

      await panelHeadingClick(buildingIdElement[1], true);
    }

    async function panelHeadingClick(buildingId, toggle = false) {
      const panelHeading = getPanelHeading(buildingId);
      const panelBody = getPanelBody(buildingId);

      const href = panelHeading.outerHTML.match(/href="([^"]+)"/)[1];

      if (panelBody.classList.contains("hidden")) {
        if (toggle) {
          panelBody.classList.remove("hidden");
        }

        if (W.loadedBuildings.indexOf(href) === -1) {
          W.loadedBuildings.push(href);
          await $.get(href, function (data) {
            panelBody.innerHTML = data;

            const education_key = $("input[name=education]:checked").attr(
              "education_key"
            );

            if (
              typeof education_key == "undefined" &&
              typeof W.globalEducationKey != "undefined"
            ) {
              W.schooling_disable(W.globalEducationKey);
            } else if (typeof education_key != "undefined") {
              W.schooling_disable(education_key);
              W.update_schooling_free();
            }
          });
        }
      } else if (toggle) {
        panelBody.classList.add("hidden");
      }
    }

    function createPersonnelSelector(buildingId) {
      let buttonGroup = document.createElement("div");
      buttonGroup.id = "schooling-assigner-" + buildingId;
      buttonGroup.className = "btn-group btn-group-xs";

      let resetIcon = document.createElement("span");
      resetIcon.className = "glyphicon glyphicon-trash";
      resetIcon.dataset.buildingId = buildingId;

      let resetButton = document.createElement("button");
      resetButton.type = "button";
      resetButton.className =
        "btn btn-default btn-sm schooling-personnel-reset-button";
      resetButton.appendChild(resetIcon);
      resetButton.addEventListener("click", resetPersonnelClick);

      buttonGroup.appendChild(resetButton);

      // Zahlenfeld: gewünschte Gesamtzahl an Personen für diese Wache
      let input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.id = "schooling-assigner-count-" + buildingId;
      input.placeholder = "Anzahl";
      input.title = "Gewünschte Anzahl Personen von dieser Wache";
      input.className = "form-control input-sm";
      input.style.cssText =
        "width:70px;display:inline-block;float:none;vertical-align:middle;margin:0 4px;height:24px;padding:2px 5px";
      // Klicks/Tasten im Feld dürfen das Auf-/Zuklappen der Wache nicht auslösen
      ["click", "mousedown", "keyup", "keypress"].forEach((ev) =>
        input.addEventListener(ev, (e) => e.stopPropagation())
      );

      let button = document.createElement("button");
      button.type = "button";
      button.className =
        "btn btn-default btn-sm schooling-personnel-select-button";
      button.dataset.buildingId = buildingId;
      button.textContent = "Auswählen";
      button.addEventListener("click", selectPersonnelClick);

      // Enter im Feld wählt aus (und schickt nicht das Lehrgangs-Formular ab)
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          button.click();
        }
      });

      buttonGroup.appendChild(input);
      buttonGroup.appendChild(button);

      return buttonGroup;
    }

    async function selectPersonnel(buildingId, wanted) {
      const mode = getMode();
      if (mode.extra && !mode.basis) {
        alert("Bitte zuerst den Basislehrgang wählen (oder Zusatzausbildung abwählen).");
        return;
      }
      wanted = parseInt(wanted, 10);
      if (!(wanted > 0)) {
        alert("Bitte eine Anzahl größer 0 eintragen.");
        return;
      }

      await panelHeadingClick(buildingId);

      const target = selectedTarget();
      let schoolingFree = $("#schooling_free");
      let free = parseInt(schoolingFree.html(), 10) || 0;

      // Die Zahl gilt als Gesamtzahl für die Wache: bereits angehakte Personen zählen mit
      const already = countSelectedPersonnel(buildingId);
      let remaining = Math.max(0, wanted - already);
      let eligible = 0; // passende, noch nicht ausgewählte Personen auf der Wache
      let added = 0;

      $(".schooling_checkbox[building_id='" + buildingId + "']").each(
        function () {
          if ($(this).prop("checked") || $(this).prop("disabled")) {
            return;
          }
          // Personal, das auf einem Fahrzeug zugewiesen ist (Link in der Zeile), überspringen
          if ($(this).parent().parent().find("a")[0] != null) {
            return;
          }

          const parts = educationsOf(this);
          if (parts === null) {
            return; // Ausbildungs-Zelle nicht gefunden: sicherheitshalber nicht auswählen
          }

          let ok;
          if (mode.extra) {
            const hasBasis = parts.some((p) => matches(p, mode.basis));
            const hasTarget =
              target !== "" && parts.some((p) => matches(p, target));
            ok = hasBasis && !hasTarget;
          } else {
            ok = parts.length === 0; // nur Personal ohne jede Ausbildung
          }
          if (!ok) {
            return;
          }

          eligible++;
          if (remaining > 0 && free > 0) {
            $(this).prop("checked", true);
            --free;
            --remaining;
            added++;
          }
        }
      );

      schoolingFree.html(free);
      W.update_costs();

      // Hinweis, falls weniger als gewünscht ausgewählt werden konnte
      const total = already + added;
      let note = "";
      if (total < wanted) {
        note =
          eligible > added && free <= 0
            ? "Lehrgang voll"
            : "nur " + total + " verfügbar";
      }
      updateSelectionCounter(buildingId, note);
    }

    async function resetPersonnel(buildingId) {
      await panelHeadingClick(buildingId);

      let schoolingFree = $("#schooling_free");
      let free = parseInt(schoolingFree.html(), 10) || 0;

      $(".schooling_checkbox[building_id='" + buildingId + "']").each(
        function () {
          if ($(this).prop("checked")) {
            $(this).prop("checked", false);
            ++free;
          }
        }
      );

      schoolingFree.html(free);
      W.update_costs();

      updateSelectionCounter(buildingId);
    }

    function countSelectedPersonnel(buildingId) {
      let count = 0;
      let checkboxes = document.querySelectorAll(
        ".schooling_checkbox[building_id='" + buildingId + "']"
      );

      for (let i = 0; i < checkboxes.length; i++) {
        if (checkboxes[i].checked) {
          count++;
        }
      }

      return count;
    }

    function updateSelectionCounter(buildingId, note) {
      const element_id = "personnel-selection-counter-" + buildingId;

      let counter = document.createElement("span");
      counter.id = element_id;
      counter.className = note ? "label label-warning" : "label label-primary";
      counter.textContent =
        countSelectedPersonnel(buildingId) +
        " ausgewählt" +
        (note ? " – " + note : "");

      const element = document.getElementById(element_id);

      if (element) {
        element.replaceWith(counter);
      } else {
        document
          .getElementById("schooling-assigner-" + buildingId)
          .parentNode.prepend(counter);
      }
    }

    function getPanelHeading(buildingId) {
      return document.querySelector(
        ".personal-select-heading[building_id='" + buildingId + "']"
      );
    }

    function getPanelBody(buildingId) {
      return document.querySelector(
        ".panel-body[building_id='" + buildingId + "']"
      );
    }
  }

  return {
    id: "lehrgangszuweiser",
    name: "Lehrgangszuweiser (Zusatzausbildung)",
    matches,
    init() {
      if (!matches()) return;
      if (!W.$ || !W.loadedBuildings) return; // keine Schulungsseite
      if (document.getElementById("schooling-assigner-options")) return; // schon aktiv
      run();
    },
  };
})();

    // ======================================================================
    // NEUES MODUL HINZUFÜGEN – Vorlage (einfach kopieren und ausfüllen):
    //
    // register({
    //     id: 'mein-modul',                      // eindeutig, keine Leerzeichen
    //     name: 'Mein Modul',
    //     description: 'Was es macht.',
    //     where: 'Einsatzfenster',               // nur Anzeige im Panel
    //     defaultEnabled: true,
    //     match: loc => loc.pathname.startsWith('/missions/'),
    //     init(ctx) {
    //         ctx.addStyle('.foo { color: red; }');        // wird beim Ausschalten entfernt
    //         ctx.on(document, 'click', e => { ... });     // dito
    //         ctx.interval(() => { ... }, 1000);           // dito
    //         ctx.onCleanup(() => { /* eigenes Aufräumen */ });
    //         // ctx.get('key', default) / ctx.set('key', wert) für Einstellungen
    //     },
    // });
    // ======================================================================

    // ======================================================================
    // START
    // ======================================================================
    // --- Update-Hinweis ----------------------------------------------------
    // Ein Userscript kann sich nicht selbst ersetzen, das macht nur Tampermonkey.
    // Die Toolbox erkennt eine neuere Version und verlinkt die Installation.
    function isNewer(a, b) {
        const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
        const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d) return d > 0;
        }
        return false;
    }

    function showUpdate(remote) {
        const el = document.getElementById('lsstb-ver');
        if (el) {
            el.textContent = '';
            const a = document.createElement('a');
            a.href = CONFIG.updateUrl;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = `⬆ Update auf v${remote} installieren`;
            a.style.color = '#f0ad4e';
            el.append(`v${VERSION} · `, a);
        }
        updateRemote = remote;
        const ml = document.getElementById('lsstb-menu-link');
        if (ml) {
            ml.textContent = menuLabel();
            ml.title = `Update v${remote} verfügbar`;
        }
    }

    async function checkForUpdate() {
        if (!CONFIG.updateUrl) return;
        let info = store.get('update', null);                  // { t, remote }
        if (!info || Date.now() - info.t > 3 * 36e5) {         // höchstens alle 3 h nachsehen
            try {
                const r = await fetch(CONFIG.updateUrl, { cache: 'no-store' });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const head = (await r.text()).slice(0, 4000);
                const m = head.match(/@version\s+(\S+)/);
                info = { t: Date.now(), remote: m ? m[1] : null };
                store.set('update', info);
            } catch (e) {
                console.warn('[LSS-Toolbox] Update-Prüfung fehlgeschlagen:', e);
                return;
            }
        }
        if (info.remote && isNewer(info.remote, VERSION)) showUpdate(info.remote);
    }

    modules.forEach(mod => { if (isEnabled(mod)) startModule(mod); });
    if (IS_TOP) {
        buildUI();
        checkForUpdate();
    }

    // Für Debugging in der Konsole erreichbar
    window.LSSToolbox = { modules, running, store, startModule, stopModule, open: () => panelApi.open && panelApi.open() };
})();
