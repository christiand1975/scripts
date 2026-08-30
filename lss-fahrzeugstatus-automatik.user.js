// ==UserScript==
// @name         LSS Fahrzeugstatus-Automatik
// @namespace    https://www.leitstellenspiel.de/
// @version      0.1.0
// @description  Setzt FMS-Status (S2/S6) automatisch je Fahrzeug: voll besetzt + (falls nötig) richtige Ausbildung -> S2, sonst S6. Läuft über alle Wachen aller Typen. Vorschau vor Ausführung.
// @author       Christian / Grisu
// @match        https://www.leitstellenspiel.de/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const LSS_BASE = 'https://www.leitstellenspiel.de';
    const STORAGE_KEY_LS = 'fsa_ls_ids';

    // ============================================================
    // EDU_MAP + MISSING_SCHOOLING – 1:1 übernommen aus
    // "LSS Ausbildungscheck – Fahrzeugkauf" (v2.13)
    // ============================================================
    const MISSING_SCHOOLING = {
        41:  { eduName: 'FGr E', min: 1 },
        122: { eduName: 'FGr E', min: 1 },
        123: { eduName: 'Fachgruppe Wasserschaden/Pumpen', min: 1 },
        65:  { eduName: 'Fachgruppe Wassergefahren', min: 1 },
        93:  { eduName: 'Rettungshundeführer (THW)', min: 1 },
        124: { eduName: 'GW-Wasserrettung', min: 1 },
    };
    const EDU_MAP = {
        'GW-Messtechnik Lehrgang': 'GW-Messtechnik',
        'Höhenrettung Lehrgang': 'GW-Höhenrettung',
        'Wechsellader Lehrgang': 'Wechsellader',
        'GW-Taucher Lehrgang': 'GW-Taucher',
        'GW-Wasserrettung Lehrgang': 'GW-Wasserrettung',
        'Flugfeldlöschfahrzeug-Ausbildung': 'Flugfeldlöschfahrzeug',
        'Rettungstreppen-Ausbildung': 'Rettungstreppen',
        'Werkfeuerwehr-Ausbildung': 'Werkfeuerwehr',
        'Feuerwehr-Verpflegungseinheit': 'Feuerwehr-Verpflegungseinheit',
        'NEA200 Fortbildung': 'NEA200',
        'Bahnrettung': 'Bahnrettung',
        'Notarzt-Ausbildung': 'Notarzt',
        'LNA-Ausbildung': 'LNA (Leitender Notarzt)',
        'OrgL-Ausbildung': 'OrgL',
        'SEG - Einsatzleitung': 'Einsatzleitung (SEG)',
        'SEG - GW-San': 'GW-San',
        'Betreuungsdienst': 'Betreuungshelfer',
        'Rettungshundeführer': 'Rettungshundeführer (SEG)',
        'Höhenretter': 'Höhenretter',
        'Einsatzleiter Bergrettung': 'Einsatzleiter Bergrettung',
        'Drohnenoperator': 'Drohnenoperator',
        'Verpflegungshelfer': 'Verpflegungshelfer',
        'Windenoperator': 'Windenoperator (RD)',
        'Intensivpflege': 'Intensivpflege',
        'Zugführer (leBefKw)': 'Zugführer (Pol)',
        'Hundertschaftsführer (FüKw)': 'Hundertschaftsführer',
        'Polizeihubschrauber': 'Polizeihubschrauber',
        'Hundeführer (Schutzhund)': 'Hundeführer',
        'Motorradstaffel': 'Motorradstaffel',
        'Brandbekämpfung': 'Brandbekämpfung (Pol)',
        'Kriminalpolizei': 'Kriminalpolizei',
        'Dienstgruppenleitung': 'Dienstgruppenleitung',
        'Reiterstaffel': 'Reiterstaffel',
        'SEK': 'SEK',
        'MEK': 'MEK',
        'Wasserwerfer': 'Wasserwerfer',
        'Lautsprecheroperator': 'Lautsprecheroperator',
        'Zugtrupp': 'Zugtrupp',
        'Fachgruppe Räumen': 'Fachgruppe Räumen',
        'Fachgruppe Wassergefahren': 'Fachgruppe Wassergefahren',
        'Fachgruppe Bergungstaucher': 'Fachgruppe Bergungstaucher',
        'Fachgruppe Rettungshundeführer': 'Rettungshundeführer (THW)',
        'Fachgruppe Wasserschaden/Pumpen': 'Fachgruppe Wasserschaden/Pumpen',
        'Fachgruppe Schwere Bergung': 'FGr SB',
        'Fachgruppe Elektroversorgung': 'FGr E',
        'Trupp Unbemannte Luftfahrtsysteme': 'Tr UL',
        'Fachzug Führung und Kommunikation': 'Fachzug Führung und Kommunikation',
        'Seenotretter': 'Seenotretter',
        'Hubschrauberpilot (Seenotrettung)': 'Hubschrauberpilot (Seenotrettung)',
        'Wasserrettungsausbildung für Notfallsanitäter': 'Wasserrettungsausbildung Notfallsanitäter',
        'Technik und Sicherheit': 'Technik und Sicherheit',
        'Logistik-Verpflegung': 'Logistik-Verpflegung',
    };

    function bereinige(name) {
        return name.toLowerCase()
            .replace(/lehrgang/g, '').replace(/ausbildung/g, '')
            .replace(/fortbildung/g, '').replace(/^gw-/, '')
            .replace(/[-_]/g, ' ').replace(/  +/g, ' ').trim();
    }
    function matchEduName(lssmName, personalName) {
        const mapped = EDU_MAP[lssmName];
        if (mapped && mapped.toLowerCase() === personalName.toLowerCase()) return true;
        const a = lssmName.toLowerCase().trim();
        const b = personalName.toLowerCase().trim();
        if (a === b) return true;
        if (a.includes(b) || b.includes(a)) return true;
        const ac = bereinige(lssmName);
        const bc = bereinige(personalName);
        if (ac === bc || ac.includes(bc) || bc.includes(ac)) return true;
        return false;
    }
    function findePersonalName(lssmEduName, ausgebildetGesamt) {
        const mapped = EDU_MAP[lssmEduName];
        if (mapped && ausgebildetGesamt[mapped] !== undefined) return mapped;
        return Object.keys(ausgebildetGesamt).find(k => matchEduName(lssmEduName, k));
    }

    // ============================================================
    // Netzwerk-Helfer
    // ============================================================
    function fetchDoc(path) {
        return fetch(LSS_BASE + path, { credentials: 'same-origin' })
            .then(r => r.text())
            .then(text => new DOMParser().parseFromString(text, 'text/html'));
    }
    function apiGet(path) {
        return fetch(LSS_BASE + path, {
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
        }).then(r => r.json());
    }
    // Bestätigt per DevTools: GET /vehicles/{id}/set_fms/{status} -> 302 -> 200
    function setFms(vehicleId, status) {
        return fetch(`${LSS_BASE}/vehicles/${vehicleId}/set_fms/${status}`, { credentials: 'same-origin' });
    }

    // ============================================================
    // Caches
    // ============================================================
    let lssmVehiclesCache = null;
    async function getLssmVehicles() {
        if (lssmVehiclesCache) return lssmVehiclesCache;
        const res = await fetch('https://api.lss-manager.de/de_DE/vehicles');
        lssmVehiclesCache = res.ok ? await res.json() : {};
        return lssmVehiclesCache;
    }

    // ============================================================
    // Wachen einer Leitstelle
    // ============================================================
    async function getWachenForLs(lsId) {
        const doc = await fetchDoc(`/buildings/${lsId}/leitstelle-buildings`);
        const table = doc.querySelector('.alliance_buildings_table') || doc.querySelector('#alliance_buildings_table') || doc.querySelector('table');
        const wachen = [];
        if (!table) return wachen;
        table.querySelectorAll('tr').forEach(tr => {
            const link = tr.querySelector('a[href^="/buildings/"]');
            if (link) {
                const id = link.getAttribute('href').split('/').pop();
                if (id === String(lsId)) return;
                wachen.push({ id, name: link.textContent.trim() });
            }
        });
        return wachen;
    }

    // ============================================================
    // Personal-Ausbildungen einer Wache
    // ============================================================
    async function getAusbildungen(wacheId) {
        const doc = await fetchDoc(`/buildings/${wacheId}/schooling_personal_select`);
        const ausgebildetGesamt = {};
        doc.querySelectorAll('[id^="school_personal_education_"]').forEach(span => {
            span.textContent.split(',').forEach(edu => {
                edu = edu.trim();
                if (edu) ausgebildetGesamt[edu] = (ausgebildetGesamt[edu] || 0) + 1;
            });
        });
        return ausgebildetGesamt;
    }

    // ============================================================
    // Aktuellen FMS-Status eines Fahrzeugobjekts ermitteln.
    // Feldname unsicher -> mehrere Kandidaten probieren, ersten Treffer nutzen.
    // Wird beim ersten Fund einmalig geloggt, damit wir das verifizieren können.
    // ============================================================
    const FMS_FIELD_CANDIDATES = ['fms_real', 'fms_show', 'fms_real_status', 'fms', 'status'];
    function ermittleAktuellenStatus(v) {
        for (const feld of FMS_FIELD_CANDIDATES) {
            if (v[feld] !== undefined && v[feld] !== null) {
                if (!window.__fsaFmsFieldLogged) {
                    window.__fsaFmsFieldLogged = true;
                    console.log(`[FZG-Status] Nutze Feld "${feld}" für aktuellen FMS-Status. Beispielwert:`, v[feld]);
                }
                return Number(v[feld]);
            }
        }
        if (!window.__fsaFmsFieldMissingLogged) {
            window.__fsaFmsFieldMissingLogged = true;
            console.warn('[FZG-Status] Kein FMS-Status-Feld gefunden in Fahrzeugobjekt. Verfügbare Felder:', Object.keys(v));
        }
        return null;
    }

    // ============================================================
    // Vorhandene Fahrzeuge einer Wache
    // ============================================================
    async function getVorhandeneFahrzeuge(wacheId) {
        const res = await apiGet(`/api/buildings/${wacheId}/vehicles`);
        const arr = Array.isArray(res) ? res : [];
        const gefiltert = arr.filter(v => String(v.building_id) === String(wacheId));
        if (gefiltert.length > 0 && !window.__fsaDebugLogged) {
            window.__fsaDebugLogged = true;
            console.log('[FZG-Status] Beispiel-Fahrzeugobjekt (zur Feldprüfung):', gefiltert[0]);
        }
        // Sicherheitsfilter: S6 immer prüfen (Kandidaten für "wieder bereit").
        // S2 nur prüfen wenn 0 Mann besetzt (Performance – besetzte S2-FZG sind
        // ohnehin schon "bereit" und müssen nicht extra geprüft werden).
        return gefiltert.filter(v => {
            const aktuell = ermittleAktuellenStatus(v);
            if (aktuell === 6) return true;
            if (aktuell === 2) return (v.assigned_personnel_count || 0) === 0;
            return false;
        });
    }

    // ============================================================
    // Pro Wache: Ziel-Status je Fahrzeug berechnen
    // ============================================================
    function berechneZielstatus(lssmVehicles, ausgebildetGesamt, fahrzeuge) {
        // "gebunden" wie im Ausbildungscheck: pro bereits vollbesetztem
        // Ausbildungs-FZG die benötigten Ausbildungen vom Pool abziehen,
        // damit nicht mehrere Fahrzeuge dieselbe Person doppelt zählen.
        const gebunden = {};
        const ergebnisse = [];

        fahrzeuge.forEach(fzg => {
            const typ = lssmVehicles[fzg.vehicle_type];
            const name = fzg.caption || fzg.name || `Fahrzeug ${fzg.id}`;
            const zugewiesen = fzg.assigned_personnel_count || 0;
            const max = typ ? (typ.staff?.max ?? typ.maxPersonnel) : null;
            const brauchtAusbildung = !!(typ && (typ.schooling || MISSING_SCHOOLING[fzg.vehicle_type]));

            if (!typ || max == null) {
                ergebnisse.push({ id: fzg.id, name, ziel: null, begruendung: 'Fahrzeugtyp unbekannt (LSSM-Katalog) – übersprungen', zugewiesen, max: max ?? '?', brauchtAusbildung });
                return;
            }

            const vollbesetzt = zugewiesen >= max;

            if (!brauchtAusbildung) {
                // Sicherheitsgrenze: bei FZG ohne Ausbildungsbedarf nur GrKw anfassen,
                // alle anderen Typen überspringen (sonst zu viele Fahrzeuge betroffen)
                const istGrKw = (typ.caption || '').toLowerCase().includes('grukw');
                if (!istGrKw) return; // komplett überspringen, taucht nicht in der Vorschau auf

                if (zugewiesen >= 1) {
                    ergebnisse.push({ id: fzg.id, name, ziel: 2, begruendung: `GrKw, keine Ausbildung nötig, ${zugewiesen}/${max} besetzt`, zugewiesen, max, brauchtAusbildung });
                } else {
                    ergebnisse.push({ id: fzg.id, name, ziel: 6, begruendung: 'GrKw, keine Ausbildung nötig, aber 0 besetzt', zugewiesen, max, brauchtAusbildung });
                }
                return;
            }

            // Ausbildungs-relevantes Fahrzeug
            const benoetigt = [];
            if (typ.schooling) {
                Object.values(typ.schooling).forEach(lehrgaenge => {
                    Object.keys(lehrgaenge).forEach(lssmEduName => {
                        benoetigt.push(findePersonalName(lssmEduName, ausgebildetGesamt) || lssmEduName);
                    });
                });
            }
            const missing = MISSING_SCHOOLING[fzg.vehicle_type];
            if (missing) benoetigt.push(missing.eduName);

            if (!vollbesetzt) {
                ergebnisse.push({ id: fzg.id, name, ziel: 6, begruendung: `Ausbildung nötig, nur ${zugewiesen}/${max} besetzt`, zugewiesen, max, brauchtAusbildung });
                return;
            }

            // Voll besetzt -> prüfen ob genug freie qualifizierte Personen da sind
            let richtig = true;
            benoetigt.forEach(personalName => {
                const gesamt = ausgebildetGesamt[personalName] || 0;
                const geb = gebunden[personalName] || 0;
                const frei = gesamt - geb;
                if (frei < 1) richtig = false;
            });

            if (richtig) {
                // Für "gebunden"-Buchhaltung: 1 Person je benötigter Ausbildung als verbraucht markieren
                benoetigt.forEach(personalName => {
                    gebunden[personalName] = (gebunden[personalName] || 0) + 1;
                });
                ergebnisse.push({ id: fzg.id, name, ziel: 2, begruendung: `Voll besetzt (${zugewiesen}/${max}), Ausbildung passt (${benoetigt.join(', ')})`, zugewiesen, max, brauchtAusbildung });
            } else {
                ergebnisse.push({ id: fzg.id, name, ziel: 6, begruendung: `Voll besetzt, aber Ausbildung fehlt/nicht mehr frei (${benoetigt.join(', ')})`, zugewiesen, max, brauchtAusbildung });
            }
        });

        return ergebnisse;
    }

    // ============================================================
    // UI
    // ============================================================
    function getSavedLsIds() {
        try { return JSON.parse(GM_getValue(STORAGE_KEY_LS, '[]')); } catch (e) { return []; }
    }
    function saveLsIds(ids) { GM_setValue(STORAGE_KEY_LS, JSON.stringify(ids)); }

    function injectHeaderLink() {
        const nav = document.querySelector('.navbar-nav') || document.querySelector('#navbar ul.nav');
        if (!nav || document.getElementById('fsa-link')) return;
        const li = document.createElement('li');
        li.innerHTML = '<a id="fsa-link" href="#" style="cursor:pointer;">FZG-Status-Automatik</a>';
        li.querySelector('a').addEventListener('click', e => { e.preventDefault(); openPanel(); });
        nav.appendChild(li);
    }

    let letzterScan = []; // { wacheId, wacheName, ergebnisse }

    function openPanel() {
        let modal = document.getElementById('fsa-modal');
        if (modal) { modal.style.display = 'block'; return; }

        modal = document.createElement('div');
        modal.id = 'fsa-modal';
        modal.style.cssText = 'position:fixed;top:3%;left:6%;width:88%;height:92%;background:#12122a;color:#e8eaf6;z-index:99999;overflow:auto;border:1px solid #2d2d5e;border-radius:8px;padding:16px;box-shadow:0 0 30px rgba(0,0,0,.6);font-family:Segoe UI,sans-serif;font-size:13px;';
        modal.innerHTML = `
            <button id="fsa-close" style="float:right;background:#1a1a2e;color:#e8eaf6;border:1px solid #2d2d5e;border-radius:5px;padding:3px 10px;cursor:pointer;">Schließen</button>
            <h3 style="color:#90caf9;margin-top:0;">🚦 Fahrzeugstatus-Automatik (S2/S6)</h3>
            <p style="color:#78909c;">Fasst nur Fahrzeuge an, die aktuell bereits in S2 oder S6 stehen (nicht im Einsatz).</p>
            <p>Leitstellen-IDs (Komma-getrennt):</p>
            <input id="fsa-ls-input" type="text" style="width:520px;padding:4px 8px;border-radius:4px;border:1px solid #2d2d5e;background:#1a1a2e;color:#e8eaf6;" placeholder="z.B. 19237992, 12345678" />
            <button id="fsa-ls-save" style="margin-left:6px;background:#1a1a2e;color:#e8eaf6;border:1px solid #2d2d5e;border-radius:5px;padding:4px 10px;cursor:pointer;">Speichern</button>
            <button id="fsa-scan-start" style="margin-left:6px;background:#c0392b;color:#fff;border:1px solid #7f1d1d;border-radius:5px;padding:4px 10px;cursor:pointer;">1) Vorschau berechnen</button>
            <button id="fsa-apply-all" style="margin-left:6px;background:#5cb85c;color:#fff;border:1px solid #3d8b3d;border-radius:5px;padding:4px 10px;cursor:pointer;" disabled>2) Alle anwenden</button>
            <div id="fsa-status" style="margin-top:10px;font-weight:600;color:#90caf9;"></div>
            <div id="fsa-results" style="margin-top:16px;"></div>
        `;
        document.body.appendChild(modal);

        document.getElementById('fsa-close').addEventListener('click', () => modal.style.display = 'none');
        document.getElementById('fsa-ls-input').value = getSavedLsIds().join(', ');
        document.getElementById('fsa-ls-save').addEventListener('click', () => {
            const ids = document.getElementById('fsa-ls-input').value.split(',').map(s => s.trim()).filter(Boolean);
            saveLsIds(ids);
        });
        document.getElementById('fsa-scan-start').addEventListener('click', runScan);
        document.getElementById('fsa-apply-all').addEventListener('click', applyAll);
    }

    async function runScan() {
        const resultsDiv = document.getElementById('fsa-results');
        const statusDiv = document.getElementById('fsa-status');
        const scanBtn = document.getElementById('fsa-scan-start');
        const applyBtn = document.getElementById('fsa-apply-all');

        const lsIds = getSavedLsIds();
        if (lsIds.length === 0) { statusDiv.textContent = 'Bitte zuerst Leitstellen-IDs eintragen und speichern.'; return; }

        scanBtn.disabled = true;
        applyBtn.disabled = true;
        letzterScan = [];
        resultsDiv.innerHTML = '';
        statusDiv.textContent = '⏳ Lade Fahrzeugkatalog (LSSM)…';

        const lssmVehicles = await getLssmVehicles();

        let wacheZaehler = 0;
        for (let i = 0; i < lsIds.length; i++) {
            const lsId = lsIds[i];
            statusDiv.textContent = `⏳ Leitstelle ${i + 1}/${lsIds.length} (#${lsId}): Wachen werden ermittelt…`;
            let wachen;
            try { wachen = await getWachenForLs(lsId); }
            catch (e) { resultsDiv.innerHTML += `<p style="color:#ef9a9a;">LS ${lsId}: Fehler (${e.message || e})</p>`; continue; }

            for (const wache of wachen) {
                wacheZaehler++;
                statusDiv.textContent = `⏳ Leitstelle ${i + 1}/${lsIds.length}: Wache ${wacheZaehler} – ${wache.name}…`;
                try {
                    const [ausgebildetGesamt, fahrzeuge] = await Promise.all([
                        getAusbildungen(wache.id),
                        getVorhandeneFahrzeuge(wache.id),
                    ]);
                    const ergebnisse = berechneZielstatus(lssmVehicles, ausgebildetGesamt, fahrzeuge)
                        .filter(e => e.ziel !== null); // unbekannte Typen nicht anzeigen/anwenden
                    if (ergebnisse.length === 0) continue;
                    letzterScan.push({ wacheId: wache.id, wacheName: wache.name, ergebnisse });
                } catch (e) {
                    resultsDiv.innerHTML += `<p style="color:#ef9a9a;">Wache ${wache.name}: Fehler (${e.message || e})</p>`;
                }
            }
        }

        renderVorschau(resultsDiv);
        statusDiv.textContent = `✅ Vorschau fertig – ${letzterScan.reduce((s, w) => s + w.ergebnisse.length, 0)} Fahrzeuge in ${letzterScan.length} Wachen.`;
        scanBtn.disabled = false;
        applyBtn.disabled = letzterScan.length === 0;
    }

    function renderVorschau(resultsDiv) {
        let html = '';
        letzterScan.forEach(w => {
            html += `<div style="border:1px solid #2d2d5e;border-radius:6px;padding:8px 12px;margin-bottom:10px;">
                <h4 style="color:#90caf9;margin:0 0 6px;"><a href="/buildings/${w.wacheId}" target="_blank" style="color:#90caf9;">${w.wacheName}</a></h4>
                <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead><tr>
                    <th style="text-align:left;padding:3px;border-bottom:1px solid #2d2d5e;">Fahrzeug</th>
                    <th style="text-align:left;padding:3px;border-bottom:1px solid #2d2d5e;">Besetzung</th>
                    <th style="text-align:left;padding:3px;border-bottom:1px solid #2d2d5e;">Ziel</th>
                    <th style="text-align:left;padding:3px;border-bottom:1px solid #2d2d5e;">Begründung</th>
                </tr></thead><tbody>`;
            w.ergebnisse.forEach(e => {
                const zielFarbe = e.ziel === 2 ? '#a5d6a7' : '#ef9a9a';
                html += `<tr>
                    <td style="padding:3px;border-bottom:1px solid #222244;">${e.name}</td>
                    <td style="padding:3px;border-bottom:1px solid #222244;">${e.zugewiesen}/${e.max}</td>
                    <td style="padding:3px;border-bottom:1px solid #222244;color:${zielFarbe};font-weight:600;">S${e.ziel}</td>
                    <td style="padding:3px;border-bottom:1px solid #222244;color:#78909c;">${e.begruendung}</td>
                </tr>`;
            });
            html += '</tbody></table></div>';
        });
        resultsDiv.innerHTML = html || '<p>Keine bekannten Fahrzeuge gefunden.</p>';
    }

    async function applyAll() {
        const statusDiv = document.getElementById('fsa-status');
        const applyBtn = document.getElementById('fsa-apply-all');
        applyBtn.disabled = true;

        const alle = letzterScan.flatMap(w => w.ergebnisse.map(e => ({ ...e, wacheName: w.wacheName })));
        let ok = 0, fehler = 0;
        for (let i = 0; i < alle.length; i++) {
            const e = alle[i];
            statusDiv.textContent = `⏳ Setze Status ${i + 1}/${alle.length}: ${e.name} (${e.wacheName}) -> S${e.ziel}…`;
            try {
                const r = await setFms(e.id, e.ziel);
                if (r.ok) ok++; else fehler++;
            } catch (err) {
                fehler++;
            }
            await new Promise(res => setTimeout(res, 250)); // kleine Pause, um den Server nicht zu fluten
        }
        statusDiv.textContent = `✅ Fertig – ${ok} erfolgreich, ${fehler} Fehler.`;
        applyBtn.disabled = false;
    }

    // ============================================================
    // Init
    // ============================================================
    injectHeaderLink();
})();
