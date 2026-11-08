// ============================================================================
//  SKOL-IF WEBBEN: GEMENSAM INLOGGNING, MINA KLASSER & SNYGGA NOTISER (klasser.js)
//  - Synkar klasser och elever direkt med Skol-IF Kassa (skolif_kassa -> elever)
//  - Ersätter fula svarta webbläsar-alerts med snygga, moderna notisrutor (Toasts)
// ============================================================================

(function () {
    const STORAGE_KEY = 'skolif_sparade_klasser';
    const LOCAL_KASSA_KEY = 'skolif_lokal_kassa';

    const firebaseConfig = {
        apiKey: "AIzaSyCmHoypbgqWYxgAVI98_gCwTJqXVUdG3hg",
        authDomain: "skol-if.firebaseapp.com",
        projectId: "skol-if",
        storageBucket: "skol-if.firebasestorage.app",
        messagingSenderId: "593631856247",
        appId: "1:593631856247:web:874d4a87142b44bc336872",
        measurementId: "G-6JP01V6CYC"
    };

    if (typeof firebase !== 'undefined' && (!firebase.apps || firebase.apps.length === 0)) {
        firebase.initializeApp(firebaseConfig);
    }

    const auth = typeof firebase !== 'undefined' && firebase.auth ? firebase.auth() : null;
    const db = typeof firebase !== 'undefined' && firebase.firestore ? firebase.firestore() : null;

    let currentUser = null;
    let authReady = false;
    let activeKassaDocId = null;
    let kassaUnsubscribe = null;
    let kassaEleverCache = [];
    let onClassSelectCallback = null;

    // ==========================================
    //  HJÄLPFUNKTIONER & NORMALISERING AV KLASSNAMN
    // ==========================================
    function normalizeKlassCode(rawName) {
        return String(rawName || '')
            .trim()
            .replace(/^klass\s+/i, '')
            .replace(/\s*-\s*(löpning|terränglopp|lopp|beep-test|beeptest)$/i, '')
            .trim()
            .toUpperCase();
    }

    function formatDisplayKlass(klassCode) {
        const clean = String(klassCode || '').trim();
        if (!clean) return '';
        if (/^klass\s+/i.test(clean)) return clean;
        return 'Klass ' + clean;
    }

    function parseStudentNames(text) {
        if (!text || typeof text !== 'string') return [];
        return text
            .split(/[\n,;]+/)
            .map(s => s.trim())
            .filter(s => s.length > 0);
    }

    function countStudents(text) {
        return parseStudentNames(text).length;
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // ==========================================
    //  SNYGGT NOTIS-SYSTEM (ERSÄTTER SVARTA ALERTS)
    // ==========================================
    function showToast(message, type) {
        injectStylesAndModal();
        const container = document.getElementById('skolifToastContainer');
        if (!container) return;

        const cleanMsg = String(message || '').trim();
        if (!cleanMsg) return;

        // Automatisk typ-detektering om ingen typ angavs
        let resolvedType = type;
        if (!resolvedType) {
            if (/^(❌|⛔|fel|kunde inte|det gick inte|obs|varning)/i.test(cleanMsg) || /fyll i|saknas|tom|måste|finns redan|inga /i.test(cleanMsg)) {
                resolvedType = /fel|kunde inte|det gick inte/i.test(cleanMsg) ? 'error' : 'warning';
            } else {
                resolvedType = 'success';
            }
        }

        // Rensa bort eventuell dubblett-emoji i början av texten om vi visar egen ikon
        const displayMsg = cleanMsg.replace(/^(✅|🎉|⚠️|❌|🗑️|📂)\s*/, '');

        let icon = '✓';
        if (resolvedType === 'warning') icon = '!';
        if (resolvedType === 'error') icon = '✕';
        if (cleanMsg.startsWith('🗑️')) icon = '🗑️';
        if (cleanMsg.startsWith('📂')) icon = '📂';

        const toast = document.createElement('div');
        toast.className = `skolif-toast-card ${resolvedType}`;
        toast.innerHTML = `
            <div class="skolif-toast-icon">${icon}</div>
            <div class="skolif-toast-text">${escapeHtml(displayMsg)}</div>
            <button type="button" class="skolif-toast-close" aria-label="Stäng">✕</button>
        `;

        const removeToast = () => {
            if (!toast.parentNode) return;
            toast.classList.add('hiding');
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 250);
        };

        toast.onclick = removeToast;
        container.appendChild(toast);

        // Max 3 synliga samtidigt
        while (container.children.length > 3) {
            container.removeChild(container.firstElementChild);
        }

        setTimeout(removeToast, 3600);
    }

    // Ersätt webbläsarens inbyggda svarta alert()-ruta globalt på alla sidor
    window.visaNotis = showToast;
    window.alert = function (msg) {
        showToast(msg);
    };

    // ==========================================
    //  LÄS & SPARA LOKAL CACHE (LOCALSTORAGE)
    // ==========================================
    function getClassesLocal() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return {};

            const normalized = {};
            Object.keys(parsed).forEach(k => {
                const code = normalizeKlassCode(k);
                if (!code) return;
                const val = typeof parsed[k] === 'string' ? parsed[k] : (parsed[k] && parsed[k].text ? parsed[k].text : '');
                if (val) normalized[code] = val;
            });
            return normalized;
        } catch (e) {
            return {};
        }
    }

    function setClassesLocal(klasserObj) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(klasserObj || {}));
        } catch (e) {
            console.error('Kunde inte spara klasser i localStorage:', e);
        }
    }

    function buildClassesMapFromKassaElever(eleverArray) {
        const grupper = {};
        if (!Array.isArray(eleverArray)) return grupper;

        eleverArray.forEach(e => {
            if (!e || !e.namn) return;
            const code = normalizeKlassCode(e.klass || 'ÖVRIGA');
            const namn = String(e.namn).trim();
            if (!code || !namn) return;
            if (!grupper[code]) grupper[code] = [];
            if (!grupper[code].some(existing => existing.toLowerCase() === namn.toLowerCase())) {
                grupper[code].push(namn);
            }
        });

        const result = {};
        Object.keys(grupper).sort((a, b) => a.localeCompare(b, 'sv')).forEach(code => {
            grupper[code].sort((a, b) => a.localeCompare(b, 'sv'));
            result[code] = grupper[code].join('\n');
        });
        return result;
    }

    // ==========================================
    //  LOKAL KASSA (NÄR MAN INTE ÄR INLOGGAD)
    // ==========================================
    function getLocalKassa() {
        let parsed = null;
        try {
            const raw = localStorage.getItem(LOCAL_KASSA_KEY);
            if (raw) parsed = JSON.parse(raw);
        } catch (e) {
            parsed = null;
        }

        const isGenuinelyDirty = Boolean(parsed && parsed.harVerkligaOfflineAndringar);
        return {
            elever: (parsed && Array.isArray(parsed.elever)) ? parsed.elever : [],
            varor: (parsed && Array.isArray(parsed.varor)) ? parsed.varor : [],
            transaktioner: (parsed && Array.isArray(parsed.transaktioner)) ? parsed.transaktioner : [],
            harLokalaAndringar: isGenuinelyDirty,
            harVerkligaOfflineAndringar: isGenuinelyDirty,
            senastUppdaterad: (parsed && Number(parsed.senastUppdaterad)) || 0
        };
    }

    function saveLocalKassa(partialData, markModified = true) {
        const current = getLocalKassa();
        const isOfflineModified = Boolean(markModified && authReady && !currentUser);
        const updated = {
            elever: Array.isArray(partialData.elever) ? partialData.elever : current.elever,
            varor: Array.isArray(partialData.varor) ? partialData.varor : current.varor,
            transaktioner: Array.isArray(partialData.transaktioner) ? partialData.transaktioner : current.transaktioner,
            harLokalaAndringar: isOfflineModified,
            harVerkligaOfflineAndringar: isOfflineModified,
            senastUppdaterad: Date.now()
        };

        try {
            localStorage.setItem(LOCAL_KASSA_KEY, JSON.stringify(updated));
        } catch (e) {
            console.error('Kunde inte spara lokal kassa i localStorage:', e);
        }

        if (!currentUser) {
            kassaEleverCache = updated.elever;
            setClassesLocal(buildClassesMapFromKassaElever(updated.elever));
            notifyAllListeners();
        }

        return updated;
    }

    // Håller localStorage-cachen (både klasser och lokal kassa) i 100% synk med molnet så raderade elever aldrig spökar
    function syncLocalCacheFromCloud(elever, varor, transaktioner) {
        const current = getLocalKassa();
        const nextElever = Array.isArray(elever) ? elever : current.elever;
        const nextVaror = Array.isArray(varor) ? varor : current.varor;
        const nextTx = Array.isArray(transaktioner) ? transaktioner : current.transaktioner;

        kassaEleverCache = nextElever;
        setClassesLocal(buildClassesMapFromKassaElever(nextElever));

        try {
            localStorage.setItem(LOCAL_KASSA_KEY, JSON.stringify({
                elever: nextElever,
                varor: nextVaror,
                transaktioner: nextTx,
                harLokalaAndringar: false,
                harVerkligaOfflineAndringar: false,
                senastUppdaterad: Date.now()
            }));
        } catch (e) {}

        notifyAllListeners();
    }

    function clearLocalKassa() {
        try {
            localStorage.removeItem(LOCAL_KASSA_KEY);
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) {}
        kassaEleverCache = [];
        notifyAllListeners();
    }

    // ==========================================
    //  SYNK & SAMMANSLAGNING MOT SKOL-IF KASSA (FIRESTORE)
    // ==========================================
    let activeResolvePromise = null;
    let activeResolveUid = null;

    async function resolveAndMergeKassa(user) {
        if (!user || !db) return null;
        const uidKey = user.uid || user.email || 'user';
        if (activeResolvePromise && activeResolveUid === uidKey) {
            return activeResolvePromise;
        }

        activeResolveUid = uidKey;
        activeResolvePromise = (async () => {
            const userEmail = (user.email || '').trim().toLowerCase();
            let docId = userEmail || user.uid;

            try {
                if (userEmail) {
                    const egenRef = db.collection('skolif_kassa').doc(userEmail);
                    const egenSnap = await egenRef.get();

                    if (egenSnap.exists) {
                        docId = userEmail;
                    } else {
                        // Kolla ev. äldre kassa under user.uid
                        let migrated = false;
                        if (user.uid) {
                            try {
                                const gammalSnap = await db.collection('skolif_kassa').doc(user.uid).get();
                                if (gammalSnap.exists) {
                                    const gammalData = gammalSnap.data() || {};
                                    await egenRef.set({
                                        kassaId: userEmail,
                                        namn: gammalData.namn || `Skol-IF Kassa (${userEmail})`,
                                        skapare: userEmail,
                                        behoriga_anvandare: [userEmail],
                                        elever: gammalData.elever || '[]',
                                        varor: gammalData.varor || '[]',
                                        transaktioner: gammalData.transaktioner || '[]',
                                        senastUppdaterad: Date.now()
                                    });
                                    docId = userEmail;
                                    migrated = true;
                                }
                            } catch (e) {}
                        }

                        if (!migrated) {
                            // Kolla om inbjuden till en kollegas kassa
                            const q = db.collection('skolif_kassa').where('behoriga_anvandare', 'array-contains', userEmail);
                            const deladeSnap = await q.get();
                            if (!deladeSnap.empty) {
                                docId = deladeSnap.docs[0].id;
                            } else {
                                docId = userEmail;
                            }
                        }
                    }
                }

                // Kolla om användaren har gjort verkliga ändringar i lokal kassa (utloggat läge) innan inloggning!
                const lokalKassa = getLocalKassa();
                const harLokalData = lokalKassa.harVerkligaOfflineAndringar && (
                    lokalKassa.elever.length > 0 ||
                    lokalKassa.varor.length > 0 ||
                    lokalKassa.transaktioner.length > 0
                );

                const targetRef = db.collection('skolif_kassa').doc(docId);
                const targetSnap = await targetRef.get();

                if (harLokalData) {
                    let molnElever = [];
                    let molnVaror = [];
                    let molnTransaktioner = [];

                    if (targetSnap.exists) {
                        const d = targetSnap.data() || {};
                        try { molnElever = JSON.parse(d.elever || '[]'); } catch (e) { molnElever = []; }
                        try { molnVaror = JSON.parse(d.varor || '[]'); } catch (e) { molnVaror = []; }
                        try { molnTransaktioner = JSON.parse(d.transaktioner || '[]'); } catch (e) { molnTransaktioner = []; }
                    }

                    const molnArTom = molnElever.length === 0 && molnVaror.length === 0 && molnTransaktioner.length === 0;

                    if (molnArTom) {
                        // Molnet var tomt -> Ladda över hela den lokala kassan till molnet!
                        const payload = {
                            elever: JSON.stringify(lokalKassa.elever),
                            varor: JSON.stringify(lokalKassa.varor),
                            transaktioner: JSON.stringify(lokalKassa.transaktioner),
                            senastUppdaterad: Date.now()
                        };
                        if (targetSnap.exists) {
                            await targetRef.update(payload);
                        } else {
                            await targetRef.set({
                                kassaId: docId,
                                namn: `Skol-IF Kassa (${userEmail || docId})`,
                                skapare: userEmail || docId,
                                behoriga_anvandare: [userEmail || docId],
                                ...payload
                            });
                        }
                        syncLocalCacheFromCloud(lokalKassa.elever, lokalKassa.varor, lokalKassa.transaktioner);
                        showToast('☁️ Din lokala kassa har laddats upp till molnet!', 'success');
                    } else {
                        // Både lokal kassa och molnkassa (t.ex. från mobilen) har innehåll -> Slå ihop dem smart!
                        const sammanslagnaElever = molnElever.map(e => ({ ...e }));
                        let maxId = sammanslagnaElever.length > 0
                            ? Math.max(0, ...sammanslagnaElever.map(e => Number(e.id) || 0))
                            : 0;

                        const molnTxIds = new Set(molnTransaktioner.map(t => t && t.id));
                        const nyaLokalaTx = lokalKassa.transaktioner.filter(t => t && !molnTxIds.has(t.id));
                        const elevIdMap = new Map();

                        lokalKassa.elever.forEach(lokElev => {
                            if (!lokElev || !lokElev.namn) return;
                            const namnClean = String(lokElev.namn).trim();
                            const namnLow = namnClean.toLowerCase();
                            const klassNorm = normalizeKlassCode(lokElev.klass);

                            const befintlig = sammanslagnaElever.find(m =>
                                String(m.namn || '').trim().toLowerCase() === namnLow &&
                                normalizeKlassCode(m.klass) === klassNorm
                            );

                            if (befintlig) {
                                elevIdMap.set(lokElev.id, befintlig.id);
                                if (lokElev.tagg && !befintlig.tagg) {
                                    befintlig.tagg = lokElev.tagg;
                                }
                                // Räkna ut saldo-förändring från eventuella nya lokala transaktioner för denna elev
                                const elevNyaTx = nyaLokalaTx.filter(t => t.elevId === lokElev.id);
                                if (elevNyaTx.length > 0) {
                                    const delta = elevNyaTx.reduce((sum, t) => {
                                        const b = Number(t.belopp) || 0;
                                        return t.typ === 'KÖP' ? sum - b : sum + b;
                                    }, 0);
                                    befintlig.saldo = (Number(befintlig.saldo) || 0) + delta;
                                } else if ((Number(befintlig.saldo) || 0) === 0 && (Number(lokElev.saldo) || 0) !== 0) {
                                    befintlig.saldo = Number(lokElev.saldo) || 0;
                                }
                            } else {
                                maxId++;
                                elevIdMap.set(lokElev.id, maxId);
                                sammanslagnaElever.push({
                                    ...lokElev,
                                    id: maxId,
                                    namn: namnClean,
                                    klass: klassNorm,
                                    saldo: Number(lokElev.saldo) || 0
                                });
                            }
                        });

                        // Slå ihop varor (lägg till nya lokala varor som saknas i molnet)
                        const sammanslagnaVaror = [...molnVaror];
                        lokalKassa.varor.forEach(lokVara => {
                            if (!lokVara || !lokVara.namn) return;
                            const finnsVara = sammanslagnaVaror.some(v =>
                                String(v.namn || '').trim().toLowerCase() === String(lokVara.namn).trim().toLowerCase()
                            );
                            if (!finnsVara) {
                                sammanslagnaVaror.push(lokVara);
                            }
                        });

                        // Slå ihop transaktioner (med mappat elevId)
                        const mappadeNyaTx = nyaLokalaTx.map(t => ({
                            ...t,
                            elevId: elevIdMap.has(t.elevId) ? elevIdMap.get(t.elevId) : t.elevId
                        }));
                        const sammanslagnaTransaktioner = [...molnTransaktioner, ...mappadeNyaTx];

                        await targetRef.update({
                            elever: JSON.stringify(sammanslagnaElever),
                            varor: JSON.stringify(sammanslagnaVaror),
                            transaktioner: JSON.stringify(sammanslagnaTransaktioner),
                            senastUppdaterad: Date.now()
                        });

                        syncLocalCacheFromCloud(sammanslagnaElever, sammanslagnaVaror, sammanslagnaTransaktioner);
                        showToast('☁️ Din lokala kassa har slagits ihop med molnet!', 'success');
                    }
                } else if (targetSnap.exists) {
                    // Molnkassan är enda sanningen – uppdatera lokal cache direkt så gamla raderade elever rensas bort
                    const d = targetSnap.data() || {};
                    let molnElever = [];
                    let molnVaror = [];
                    let molnTransaktioner = [];
                    try { molnElever = JSON.parse(d.elever || '[]'); } catch (e) { molnElever = []; }
                    try { molnVaror = JSON.parse(d.varor || '[]'); } catch (e) { molnVaror = []; }
                    try { molnTransaktioner = JSON.parse(d.transaktioner || '[]'); } catch (e) { molnTransaktioner = []; }
                    syncLocalCacheFromCloud(molnElever, molnVaror, molnTransaktioner);
                } else {
                    // Ingen lokal data och ingen molnkassa fanns -> skapa ny tom molnkassa
                    await targetRef.set({
                        kassaId: docId,
                        namn: `Skol-IF Kassa (${userEmail || docId})`,
                        skapare: userEmail || docId,
                        behoriga_anvandare: [userEmail || docId],
                        elever: '[]',
                        varor: '[]',
                        transaktioner: '[]',
                        senastUppdaterad: Date.now()
                    });
                    syncLocalCacheFromCloud([], [], []);
                }

                return docId;
            } catch (err) {
                console.warn('Fel vid resolveAndMergeKassa:', err);
                return docId;
            }
        })();

        return activeResolvePromise;
    }

    async function startKassaSync(user) {
        if (kassaUnsubscribe) {
            kassaUnsubscribe();
            kassaUnsubscribe = null;
        }
        if (!user || !db) return;

        const docId = await resolveAndMergeKassa(user);
        if (!docId) return;
        activeKassaDocId = docId;

        kassaUnsubscribe = db.collection('skolif_kassa').doc(docId).onSnapshot((docSnap) => {
            if (docSnap.exists) {
                const data = docSnap.data() || {};
                let molnElever = [];
                let molnVaror = undefined;
                let molnTx = undefined;
                try {
                    molnElever = JSON.parse(data.elever || '[]');
                    if (!Array.isArray(molnElever)) molnElever = [];
                } catch (e) {
                    molnElever = [];
                }
                if (data.varor !== undefined) {
                    try { molnVaror = JSON.parse(data.varor || '[]'); } catch (e) {}
                }
                if (data.transaktioner !== undefined) {
                    try { molnTx = JSON.parse(data.transaktioner || '[]'); } catch (e) {}
                }
                if (data.elevlagePin && typeof data.elevlagePin === 'string') {
                    try { localStorage.setItem('skolif_elevlage_pin', data.elevlagePin); } catch (e) {}
                }
                if (data.lokstod !== undefined) {
                    try {
                        const parsedLok = typeof data.lokstod === 'string' ? JSON.parse(data.lokstod) : data.lokstod;
                        if (Array.isArray(parsedLok)) {
                            localStorage.setItem('skolif_lokstod_v1', JSON.stringify(parsedLok));
                            renderLokstodTab();
                        }
                    } catch (e) {}
                }
                if (data.testhistorik !== undefined) {
                    try {
                        const parsedHist = typeof data.testhistorik === 'string' ? JSON.parse(data.testhistorik) : data.testhistorik;
                        if (Array.isArray(parsedHist)) {
                            localStorage.setItem('skolif_testhistorik_v1', JSON.stringify(parsedHist));
                            renderTestHistoryModalContent();
                        }
                    } catch (e) {}
                }

                syncLocalCacheFromCloud(molnElever, molnVaror, molnTx);
            } else {
                syncLocalCacheFromCloud([], [], []);
            }
        }, (err) => {
            console.error('Fel vid lyssning på skolif_kassa i klasser.js:', err);
        });
    }

    // Hjälpfunktion för att hämta aktuell elevlista (från molncache eller lokal kassa)
    function getActiveEleverArray() {
        return currentUser ? [...kassaEleverCache] : [...(getLocalKassa().elever || [])];
    }

    // Hjälpfunktion för att spara en komplett uppdaterad elevlista till både moln (om inloggad) och lokalt
    async function persistEleverArray(nyKomplettLista) {
        if (currentUser && db) {
            try {
                if (!activeKassaDocId) {
                    activeKassaDocId = await resolveAndMergeKassa(currentUser);
                }
                syncLocalCacheFromCloud(nyKomplettLista);
                const docRef = db.collection('skolif_kassa').doc(activeKassaDocId);
                const docSnap = await docRef.get();
                if (docSnap.exists) {
                    await docRef.update({
                        elever: JSON.stringify(nyKomplettLista),
                        senastUppdaterad: Date.now()
                    });
                } else {
                    const userEmail = (currentUser.email || '').trim().toLowerCase();
                    await docRef.set({
                        kassaId: activeKassaDocId,
                        namn: `Skol-IF Kassa (${userEmail})`,
                        skapare: userEmail,
                        behoriga_anvandare: [userEmail],
                        elever: JSON.stringify(nyKomplettLista),
                        varor: '[]',
                        transaktioner: '[]',
                        senastUppdaterad: Date.now()
                    });
                }
            } catch (err) {
                console.error('Kunde inte spara elevlista till skolif_kassa:', err);
            }
        } else {
            saveLocalKassa({ elever: nyKomplettLista }, true);
        }

        notifyAllListeners();
    }

    // Hjälpfunktion för att uppdatera en klass i en elevlista utan att röra befintliga saldon (stödjer även klassnamnsbyte t.ex. 8B -> 9B)
    function mergeKlassIntoEleverList(nuvarandeElever, klassCode, nyaNamnLista, allowRemoveStudents, oldKlassCode = null) {
        let maxId = nuvarandeElever.length > 0
            ? Math.max(0, ...nuvarandeElever.map(e => Number(e.id) || 0))
            : 0;

        const normOld = oldKlassCode ? normalizeKlassCode(oldKlassCode) : null;
        const arKlassByte = Boolean(normOld && normOld !== klassCode);

        const eleverIAndraKlasser = nuvarandeElever.filter(e => {
            const k = normalizeKlassCode(e.klass);
            if (arKlassByte) return k !== klassCode && k !== normOld;
            return k !== klassCode;
        });

        const gamlaEleverIKlassen = nuvarandeElever.filter(e => {
            const k = normalizeKlassCode(e.klass);
            if (arKlassByte) return k === klassCode || k === normOld;
            return k === klassCode;
        });

        const uppdateradeIKlassen = [];
        const tillagdaLower = new Set();

        nyaNamnLista.forEach(namn => {
            const low = namn.toLowerCase();
            if (tillagdaLower.has(low)) return;
            tillagdaLower.add(low);

            const befintlig = gamlaEleverIKlassen.find(
                e => String(e.namn || '').trim().toLowerCase() === low
            );
            if (befintlig) {
                uppdateradeIKlassen.push({
                    ...befintlig,
                    id: befintlig.id,
                    namn: befintlig.namn,
                    klass: klassCode,
                    saldo: Number(befintlig.saldo) || 0
                });
            } else {
                maxId++;
                uppdateradeIKlassen.push({
                    id: maxId,
                    namn: namn,
                    klass: klassCode,
                    saldo: 0
                });
            }
        });

        if (!allowRemoveStudents) {
            gamlaEleverIKlassen.forEach(gammal => {
                const low = String(gammal.namn || '').trim().toLowerCase();
                if (!tillagdaLower.has(low)) {
                    uppdateradeIKlassen.push({
                        ...gammal,
                        klass: klassCode
                    });
                }
            });
        } else {
            const borttagnaMedSaldo = gamlaEleverIKlassen.filter(gammal => {
                const low = String(gammal.namn || '').trim().toLowerCase();
                return !tillagdaLower.has(low) && (Number(gammal.saldo) || 0) !== 0;
            });

            if (borttagnaMedSaldo.length > 0) {
                const namnPaSaldoElever = borttagnaMedSaldo.map(e => `${e.namn} (${e.saldo} kr)`).join(', ');
                const ok = confirm(
                    `⚠️ OBS! Följande elever som du tog bort från listan har saldo kvar i kiosken:\n${namnPaSaldoElever}\n\nVill du verkligen ta bort dem helt även från kiosken? (Klicka Avbryt för att behålla dem)`
                );
                if (!ok) {
                    borttagnaMedSaldo.forEach(e => uppdateradeIKlassen.push({
                        ...e,
                        klass: klassCode
                    }));
                }
            }
        }

        return [...eleverIAndraKlasser, ...uppdateradeIKlassen];
    }

    // Uppdatera en klass i skolif_kassa (eller lokalt) utan att någonsin röra befintliga elevers saldon!
    async function saveClass(rawKlassNamn, elevText, allowRemoveStudents = true, oldRawKlassNamn = null) {
        const klassCode = normalizeKlassCode(rawKlassNamn);
        const oldKlassCode = oldRawKlassNamn ? normalizeKlassCode(oldRawKlassNamn) : null;
        const arKlassByte = Boolean(oldKlassCode && oldKlassCode !== klassCode);
        const nyaNamnLista = parseStudentNames(elevText);
        if (!klassCode) return false;
        if (nyaNamnLista.length === 0 && !allowRemoveStudents) return false;

        const lokalaFore = getClassesLocal();
        const referensKod = arKlassByte ? oldKlassCode : klassCode;
        const fannsKlassenTidigare = Boolean(lokalaFore[referensKod]);
        const gamlaNamnLower = new Set(
            parseStudentNames(lokalaFore[referensKod] || '').map(n => n.toLowerCase())
        );
        const nytillagdaNamn = nyaNamnLista.filter(n => !gamlaNamnLower.has(n.toLowerCase()));

        let nuvarandeElever = getActiveEleverArray();
        if (currentUser && db && activeKassaDocId) {
            try {
                const docSnap = await db.collection('skolif_kassa').doc(activeKassaDocId).get();
                if (docSnap.exists) {
                    nuvarandeElever = JSON.parse(docSnap.data().elever || '[]');
                }
            } catch (e) {}
        }

        const nyKomplettLista = mergeKlassIntoEleverList(
            nuvarandeElever,
            klassCode,
            nyaNamnLista,
            allowRemoveStudents,
            oldKlassCode
        );

        await persistEleverArray(nyKomplettLista);

        // Visa snygg och personlig bekräftelse-toast!
        if (nyaNamnLista.length === 0) {
            showToast(`🗑️ Klass ${referensKod} har raderats`, 'info');
        } else if (arKlassByte) {
            showToast(`Klass ${oldKlassCode} har ändrats till ${klassCode} (${nyaNamnLista.length} elever)!`, 'success');
        } else if (nytillagdaNamn.length === 1 && fannsKlassenTidigare) {
            showToast(`${nytillagdaNamn[0]} är tillagd i ${klassCode}!`, 'success');
        } else if (nytillagdaNamn.length > 1 && fannsKlassenTidigare) {
            showToast(`${nytillagdaNamn.length} nya elever är tillagda i ${klassCode}!`, 'success');
        } else if (nyaNamnLista.length === 1) {
            showToast(`${nyaNamnLista[0]} är tillagd i ${klassCode}!`, 'success');
        } else {
            showToast(`Klass ${klassCode} (${nyaNamnLista.length} elever) är sparad!`, 'success');
        }

        return true;
    }

    async function deleteClass(rawKlassNamn) {
        const klassCode = normalizeKlassCode(rawKlassNamn);
        if (!klassCode) return;

        const kallaElever = getActiveEleverArray();
        const eleverIKlass = kallaElever.filter(e => normalizeKlassCode(e.klass) === klassCode);
        const totaltSaldo = eleverIKlass.reduce((sum, e) => sum + (Number(e.saldo) || 0), 0);
        const harSaldo = eleverIKlass.some(e => (Number(e.saldo) || 0) !== 0);

        let msg = `Är du säker på att du vill radera Klass ${klassCode} (${eleverIKlass.length || ''} elever)?\nKlassen tas bort från både Mina Klasser och Kiosken.`;
        if (harSaldo) {
            msg += `\n\n⚠️ OBSERVERA! Det finns kvarstående saldon i klassen på totalt ${totaltSaldo} kr!`;
        }
        if (!confirm(msg)) return;

        const kvarvarande = kallaElever.filter(e => normalizeKlassCode(e.klass) !== klassCode);
        await persistEleverArray(kvarvarande);
        showToast(`🗑️ Klass ${klassCode} har raderats`, 'info');
    }

    // Lägg till en enskild elev snabbt
    async function addSingleStudent(rawNamn, rawKlass) {
        const namn = String(rawNamn || '').trim();
        const klassCode = normalizeKlassCode(rawKlass);
        if (!namn || !klassCode) {
            showToast('Fyll i både elevens namn och klass!', 'warning');
            return false;
        }

        const elever = getActiveEleverArray();
        const finnsRedan = elever.some(
            e => String(e.namn || '').trim().toLowerCase() === namn.toLowerCase() &&
                 normalizeKlassCode(e.klass) === klassCode
        );
        if (finnsRedan) {
            showToast(`${namn} finns redan i ${klassCode}.`, 'warning');
            return false;
        }

        const nyttId = elever.length > 0 ? Math.max(0, ...elever.map(e => Number(e.id) || 0)) + 1 : 1;
        elever.push({ id: nyttId, namn: namn, klass: klassCode, saldo: 0 });
        await persistEleverArray(elever);
        showToast(`${namn} är tillagd i ${klassCode}!`, 'success');
        return true;
    }

    // Massimportera elever där klassen står på samma rad (t.ex. "Tobias Sellin 9B")
    async function massImportStudents(rawText) {
        const text = String(rawText || '').trim();
        if (!text) {
            showToast('Klistra in en lista med elever först!', 'warning');
            return false;
        }

        const elever = getActiveEleverArray();
        let aktuelltId = elever.length > 0 ? Math.max(0, ...elever.map(e => Number(e.id) || 0)) : 0;
        let tillagdaStycken = 0;
        let senasteNamn = '';
        let senasteKlass = '';

        const rader = text.split('\n');
        for (const rad of rader) {
            const renRad = rad.trim();
            if (!renRad) continue;

            const ordLista = renRad.replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean);
            let hittadKlass = '';
            const namnDelar = [];

            for (const ord of ordLista) {
                if (/\d/.test(ord) && !hittadKlass) {
                    hittadKlass = normalizeKlassCode(ord);
                } else {
                    namnDelar.push(ord);
                }
            }

            const namn = namnDelar.join(' ').trim();
            if (namn && hittadKlass) {
                const finnsRedan = elever.some(
                    e => String(e.namn || '').trim().toLowerCase() === namn.toLowerCase() &&
                         normalizeKlassCode(e.klass) === hittadKlass
                );
                if (!finnsRedan) {
                    aktuelltId++;
                    elever.push({ id: aktuelltId, namn: namn, klass: hittadKlass, saldo: 0 });
                    tillagdaStycken++;
                    senasteNamn = namn;
                    senasteKlass = hittadKlass;
                }
            }
        }

        if (tillagdaStycken > 0) {
            await persistEleverArray(elever);
            if (tillagdaStycken === 1) {
                showToast(`${senasteNamn} är tillagd i ${senasteKlass}!`, 'success');
            } else {
                showToast(`${tillagdaStycken} nya elever har lagts till!`, 'success');
            }
            return true;
        } else {
            showToast('Inga nya elever hittades (kontrollera att klass t.ex. 9B står med på raden).', 'warning');
            return false;
        }
    }

    // Läsårsbyte: Flytta upp alla klasser +1 årskurs (t.ex. 7A -> 8A, 8B -> 9B)
    async function upgradeAllClassesYear() {
        const elever = getActiveEleverArray();
        if (elever.length === 0) {
            showToast('Det finns inga elever att flytta upp ännu.', 'warning');
            return;
        }

        const berordaElever = elever.filter(e => /\d+/.test(String(e.klass || '')));
        if (berordaElever.length === 0) {
            showToast('Inga klasser med årskurssiffror (t.ex. 7A, 8B) hittades.', 'warning');
            return;
        }

        const nior = elever.filter(e => /^9/i.test(normalizeKlassCode(e.klass)));
        let infoNior = '';
        if (nior.length > 0) {
            infoNior = `\n\nℹ️ Info: ${nior.length} st elever i åk 9 flyttas till åk 10 (enkla att radera efteråt om de slutat).`;
        }

        const ok = confirm(
            `Vill du genomföra läsårsbyte och höja alla klasser ett årskurs-steg?\n\nExempel:\n7A ➔ 8A\n8B ➔ 9B\n9C ➔ 10C\n\nTotalt ${berordaElever.length} elever uppdateras (alla saldon i Kiosken följer med).${infoNior}`
        );
        if (!ok) return;

        const uppdaterade = elever.map(e => ({
            ...e,
            klass: normalizeKlassCode(e.klass).replace(/(\d+)/, match => String(parseInt(match, 10) + 1))
        }));

        await persistEleverArray(uppdaterade);
        showToast('🎉 Läsårsbytet är klart! Alla klasser har flyttats upp en årskurs.', 'success');
    }

    // Byt namn / höj en enskild klass (t.ex. 8B -> 9B)
    async function renameSingleClass(rawFromKlass, rawToKlass) {
        const fromCode = normalizeKlassCode(rawFromKlass);
        const toCode = normalizeKlassCode(rawToKlass);
        if (!fromCode) {
            showToast('Välj vilken klass du vill ändra!', 'warning');
            return false;
        }
        if (!toCode) {
            showToast('Ange det nya klassnamnet (t.ex. 9B)!', 'warning');
            return false;
        }
        if (fromCode === toCode) {
            showToast('Det nya klassnamnet är samma som det nuvarande.', 'warning');
            return false;
        }

        const elever = getActiveEleverArray();
        const berorda = elever.filter(e => normalizeKlassCode(e.klass) === fromCode);
        if (berorda.length === 0) return false;

        const uppdaterade = elever.map(e => {
            if (normalizeKlassCode(e.klass) === fromCode) {
                return { ...e, klass: toCode };
            }
            return e;
        });

        await persistEleverArray(uppdaterade);
        showToast(`Klass ${fromCode} har ändrats till ${toCode} (${berorda.length} elever)!`, 'success');
        return true;
    }

    // Exportera hela elevregistret med klasser och saldon till Excel / CSV
    function exportStudentsCSV() {
        const elever = getActiveEleverArray();
        if (elever.length === 0) {
            showToast('Det finns inga elever att exportera ännu.', 'warning');
            return;
        }

        let csvInnehall = 'Namn;Klass;Saldo (kr)\r\n';
        const sorterade = [...elever].sort((a, b) => {
            const kDiff = String(a.klass || '').localeCompare(String(b.klass || ''), 'sv');
            if (kDiff !== 0) return kDiff;
            return String(a.namn || '').localeCompare(String(b.namn || ''), 'sv');
        });

        let totaltInnestaende = 0;
        let totalaSkulder = 0;
        let totaltNetto = 0;

        sorterade.forEach(e => {
            const rentNamn = `"${String(e.namn || '').replace(/"/g, '""')}"`;
            const renKlass = `"${String(e.klass || '').replace(/"/g, '""')}"`;
            const saldo = Number(e.saldo) || 0;
            csvInnehall += `${rentNamn};${renKlass};${saldo}\r\n`;
            if (saldo > 0) totaltInnestaende += saldo;
            if (saldo < 0) totalaSkulder += saldo;
            totaltNetto += saldo;
        });

        csvInnehall += '\r\n';
        csvInnehall += '"--- SAMMANFATTNING BALANS ---";"";""\r\n';
        csvInnehall += `"Totalt innestående saldo (positiva saldon)";"";${totaltInnestaende}\r\n`;
        csvInnehall += `"Totala skulder (negativa saldon)";"";${totalaSkulder}\r\n`;
        csvInnehall += `"Nettobalans (totalt kapital i kassan)";"";${totaltNetto}\r\n`;
        csvInnehall += `"Totalt antal elever";"";${sorterade.length}\r\n`;

        const d = new Date();
        const datumStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const blob = new Blob(['\uFEFF' + csvInnehall], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.setAttribute('download', `skolif_elever_klasser_${datumStr}.csv`);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('📥 Elevlistan har laddats ner (Excel/CSV)!', 'success');
    }

    function notifyAllListeners() {
        renderAllClassBars();
        renderModalClassList();
        updateAuthUI();
        window.dispatchEvent(new CustomEvent('skolif-klasser-updated', {
            detail: { classes: getClassesLocal(), user: currentUser }
        }));
    }

    // ==========================================
    //  INLOGGNING & UTLOGGNING (GEMENSAM)
    // ==========================================
    let isSigningIn = false;
    function loginWithGoogle() {
        if (!auth || isSigningIn) return;
        isSigningIn = true;
        const provider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(provider)
            .then((res) => {
                if (res && res.user) {
                    const namn = res.user.displayName || res.user.email || '';
                    showToast(`Inloggad som ${namn}`, 'success');
                }
            })
            .catch((error) => {
                if (error.code === 'auth/cancelled-popup-request' || error.code === 'auth/popup-closed-by-user') {
                    return;
                }
                console.error('Inloggningsfel:', error);
                if (error.code === 'auth/unauthorized-domain') {
                    showToast('Domänen måste läggas till under Authorized Domains i Firebase Console.', 'error');
                } else {
                    showToast('Det gick inte att logga in. Kontrollera popup-blockerare.', 'error');
                }
            })
            .finally(() => {
                isSigningIn = false;
            });
    }

    function logoutGoogle() {
        if (!auth) return;
        if (!confirm('Vill du logga ut från Skol-IF Webben?')) return;
        if (kassaUnsubscribe) {
            kassaUnsubscribe();
            kassaUnsubscribe = null;
        }
        activeKassaDocId = null;
        activeResolvePromise = null;
        activeResolveUid = null;
        clearLocalKassa();
        auth.signOut().then(() => {
            showToast('Du har loggats ut', 'info');
        });
    }

    if (auth) {
        auth.onAuthStateChanged((user) => {
            authReady = true;
            currentUser = user || null;
            if (user) {
                startKassaSync(user);
            } else {
                if (kassaUnsubscribe) {
                    kassaUnsubscribe();
                    kassaUnsubscribe = null;
                }
                activeKassaDocId = null;
                activeResolvePromise = null;
                activeResolveUid = null;
                const lokalKassa = getLocalKassa();
                kassaEleverCache = lokalKassa.elever;
            }
            updateAuthUI();
            renderAllClassBars();
            renderModalClassList();
        });
    }

    // ==========================================
    //  GEMENSAM MODAL, STILAR & TOAST-CONTAINER
    // ==========================================
    function injectStylesAndModal() {
        if (document.getElementById('skolifKlasserStyles')) return;

        // Injicera PWA-manifest och app-ikon automatiskt på alla undersidor
        if (document.head && !document.querySelector('link[rel="manifest"]')) {
            const manifestLink = document.createElement('link');
            manifestLink.rel = 'manifest';
            manifestLink.href = 'manifest.json';
            document.head.appendChild(manifestLink);

            const iconLink = document.createElement('link');
            iconLink.rel = 'icon';
            iconLink.type = 'image/svg+xml';
            iconLink.href = 'icon.svg';
            document.head.appendChild(iconLink);

            const appleIcon = document.createElement('link');
            appleIcon.rel = 'apple-touch-icon';
            appleIcon.href = 'icon.svg';
            document.head.appendChild(appleIcon);

            const themeMeta = document.createElement('meta');
            themeMeta.name = 'theme-color';
            themeMeta.content = '#143625';
            document.head.appendChild(themeMeta);

            const appleCapable = document.createElement('meta');
            appleCapable.name = 'apple-mobile-web-app-capable';
            appleCapable.content = 'yes';
            document.head.appendChild(appleCapable);
        }

        window.addEventListener('beforeinstallprompt', function (e) {
            e.preventDefault();
            window._skolifDeferredInstallPrompt = e;
        });

        const style = document.createElement('style');
        style.id = 'skolifKlasserStyles';
        style.textContent = `
            /* SNYGGA FLYTANDE NOTISRUTOR (TOASTS) */
            #skolifToastContainer {
                position: fixed;
                top: 22px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 99999;
                display: flex;
                flex-direction: column;
                gap: 10px;
                pointer-events: none;
                width: 92%;
                max-width: 440px;
            }
            .skolif-toast-card {
                pointer-events: auto;
                background: #FFFFFF;
                color: #1E293B;
                border-radius: 14px;
                padding: 13px 16px;
                box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15, 23, 42, 0.08);
                border: 1px solid #E2E8F0;
                border-left: 5px solid #22C55E;
                display: flex;
                align-items: center;
                gap: 12px;
                font-family: 'Poppins', sans-serif;
                cursor: pointer;
                animation: skolifToastIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
                transition: opacity 0.22s ease, transform 0.22s ease;
            }
            .skolif-toast-card.hiding {
                opacity: 0;
                transform: translateY(-12px) scale(0.96);
            }
            .skolif-toast-card.warning {
                border-left-color: #F59E0B;
            }
            .skolif-toast-card.error {
                border-left-color: #EF4444;
            }
            .skolif-toast-card.info {
                border-left-color: #3B82F6;
            }
            @keyframes skolifToastIn {
                from { opacity: 0; transform: translateY(-18px) scale(0.95); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .skolif-toast-icon {
                width: 30px;
                height: 30px;
                border-radius: 50%;
                background: #DCFCE7;
                color: #15803D;
                font-weight: 900;
                font-size: 0.95rem;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }
            .skolif-toast-card.warning .skolif-toast-icon {
                background: #FEF3C7;
                color: #B45309;
            }
            .skolif-toast-card.error .skolif-toast-icon {
                background: #FEE2E2;
                color: #DC2626;
            }
            .skolif-toast-card.info .skolif-toast-icon {
                background: #DBEAFE;
                color: #1D4ED8;
            }
            .skolif-toast-text {
                flex: 1;
                font-size: 0.9rem;
                font-weight: 700;
                color: #1E293B;
                line-height: 1.35;
            }
            .skolif-toast-close {
                background: transparent;
                border: none;
                color: #94A3B8;
                font-size: 0.85rem;
                cursor: pointer;
                padding: 4px;
                line-height: 1;
            }
            .skolif-toast-close:hover {
                color: #475569;
            }

            /* NAVBAR & KLASS-RAD */
            .skolif-nav-auth-btn {
                background: rgba(255, 255, 255, 0.18);
                border: 1.5px solid rgba(255, 255, 255, 0.45);
                color: white;
                padding: 6px 14px;
                border-radius: 20px;
                font-size: 0.85rem;
                font-weight: 700;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 6px;
                font-family: 'Poppins', sans-serif;
                transition: all 0.2s;
                text-decoration: none;
            }
            .skolif-nav-auth-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: translateY(-1px);
            }
            .skolif-klasser-bar-wrap {
                background: #F4F9F5;
                border: 1.5px solid #D1E7D5;
                border-radius: 12px;
                padding: 10px 14px;
                margin-bottom: 14px;
            }
            .skolif-klasser-bar-wrap.dark-theme {
                background: rgba(15, 23, 42, 0.65);
                border-color: rgba(34, 197, 94, 0.35);
            }
            .skolif-klasser-bar-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
                margin-bottom: 8px;
            }
            .skolif-klasser-bar-title {
                font-size: 0.78rem;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                color: #1E3A24;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .skolif-klasser-bar-wrap.dark-theme .skolif-klasser-bar-title {
                color: #4ADE80;
            }
            .skolif-cloud-dot {
                font-size: 0.72rem;
                padding: 2px 8px;
                border-radius: 12px;
                font-weight: 700;
                background: #DCFCE7;
                color: #15803D;
                text-transform: none;
                letter-spacing: 0;
            }
            .skolif-cloud-dot.offline {
                background: #FEF3C7;
                color: #B45309;
                cursor: pointer;
            }
            .skolif-klasser-pills {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                align-items: center;
            }
            .skolif-class-pill {
                background: white;
                border: 1.5px solid #C8E6C9;
                padding: 5px 12px;
                border-radius: 20px;
                font-size: 0.82rem;
                font-weight: 700;
                color: #2E7D32;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 6px;
                transition: all 0.15s;
                box-shadow: 0 1px 3px rgba(0,0,0,0.04);
                font-family: inherit;
            }
            .skolif-class-pill:hover {
                background: #2E7D32;
                color: white;
                border-color: #2E7D32;
                transform: translateY(-1px);
            }
            .skolif-class-pill-count {
                font-size: 0.72rem;
                opacity: 0.8;
                font-weight: 600;
            }
            .skolif-manage-btn {
                background: transparent;
                border: 1px dashed #2E7D32;
                color: #2E7D32;
                padding: 4px 10px;
                border-radius: 16px;
                font-size: 0.78rem;
                font-weight: 700;
                cursor: pointer;
                font-family: inherit;
                transition: all 0.15s;
            }
            .skolif-manage-btn:hover {
                background: #E8F5E9;
            }
            .skolif-klasser-bar-wrap.dark-theme .skolif-manage-btn {
                border-color: #4ADE80;
                color: #4ADE80;
            }
            .skolif-klasser-bar-wrap.dark-theme .skolif-manage-btn:hover {
                background: rgba(34, 197, 94, 0.15);
            }

            /* MODAL */
            .skolif-modal-overlay {
                position: fixed;
                top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(15, 23, 42, 0.65);
                backdrop-filter: blur(4px);
                display: none;
                justify-content: center;
                align-items: center;
                z-index: 3000;
                padding: 16px;
            }
            .skolif-modal-overlay.open {
                display: flex;
            }
            .skolif-modal-box {
                background: #FFFFFF;
                color: #1E293B;
                width: 100%;
                max-width: 660px;
                max-height: 92vh;
                border-radius: 20px;
                box-shadow: 0 20px 50px rgba(0,0,0,0.3);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                font-family: 'Poppins', sans-serif;
            }
            .skolif-modal-header {
                padding: 18px 24px;
                background: #1E3A24;
                color: white;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .skolif-modal-header h3 {
                font-size: 1.2rem;
                font-weight: 800;
                margin: 0;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .skolif-modal-close {
                background: rgba(255,255,255,0.15);
                border: none;
                color: white;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                font-size: 1rem;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .skolif-modal-body {
                padding: 20px 24px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 18px;
            }
            .skolif-auth-banner {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
                flex-wrap: wrap;
                padding: 12px 16px;
                border-radius: 12px;
                background: #F0FDF4;
                border: 1px solid #BBF7D0;
                font-size: 0.85rem;
                color: #166534;
            }
            .skolif-auth-banner.logged-out {
                background: #FFFBEB;
                border-color: #FDE68A;
                color: #92400E;
            }
            .skolif-class-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 14px;
                background: #F8FAFC;
                border: 1px solid #E2E8F0;
                border-radius: 12px;
                gap: 10px;
                flex-wrap: wrap;
            }
            .skolif-class-item-info {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .skolif-class-item-name {
                font-weight: 800;
                color: #1E3A24;
                font-size: 0.95rem;
            }
            .skolif-class-item-badge {
                background: #E8F5E9;
                color: #2E7D32;
                font-size: 0.75rem;
                font-weight: 700;
                padding: 2px 8px;
                border-radius: 12px;
            }
            .skolif-btn-sm {
                padding: 6px 12px;
                border-radius: 8px;
                font-size: 0.8rem;
                font-weight: 700;
                cursor: pointer;
                border: 1px solid #CBD5E1;
                background: white;
                color: #334155;
                font-family: inherit;
                transition: all 0.15s;
            }
            .skolif-btn-sm:hover { background: #F1F5F9; }
            .skolif-btn-sm.primary {
                background: #2E7D32;
                color: white;
                border-color: #2E7D32;
            }
            .skolif-btn-sm.primary:hover { background: #1B5E20; }
            .skolif-btn-sm.danger:hover {
                background: #FEE2E2;
                color: #DC2626;
                border-color: #FCA5A5;
            }
            .skolif-tab-row {
                display: flex;
                gap: 6px;
                border-bottom: 2px solid #E2E8F0;
                padding-bottom: 10px;
                flex-wrap: wrap;
            }
            .skolif-tab-btn {
                padding: 7px 14px;
                border-radius: 10px;
                font-size: 0.82rem;
                font-weight: 700;
                cursor: pointer;
                border: 2px solid #E2E8F0;
                background: #FFFFFF;
                color: #475569;
                font-family: inherit;
                transition: all 0.15s;
            }
            .skolif-tab-btn.active {
                background: #E8F5E9;
                border-color: #4CAF50;
                color: #2E7D32;
            }
            /* ELEVLÄGE / KIOSKLÅS */
            .skolif-elevlage-pill {
                background: rgba(255, 255, 255, 0.16);
                border: 1.5px solid rgba(255, 255, 255, 0.45);
                color: white;
                padding: 6px 13px;
                border-radius: 20px;
                font-size: 0.84rem;
                font-weight: 700;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 6px;
                font-family: 'Poppins', sans-serif;
                transition: all 0.2s;
                white-space: nowrap;
            }
            .skolif-elevlage-pill:hover {
                background: rgba(255, 255, 255, 0.28);
            }
            .skolif-elevlage-pill.locked {
                background: linear-gradient(135deg, #F59E0B, #D97706) !important;
                border-color: #FDE68A !important;
                color: #FFFFFF !important;
                box-shadow: 0 4px 14px rgba(245, 158, 11, 0.4);
            }
            body.skolif-elevlage-locked .skolif-hide-in-elevlage,
            body.skolif-elevlage-locked [data-skolif-auth-btn],
            body.skolif-elevlage-locked .skolif-manage-btn {
                display: none !important;
            }
            .skolif-lok-chip {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 5px 11px;
                border-radius: 18px;
                font-size: 0.8rem;
                font-weight: 600;
                cursor: pointer;
                border: 1.5px solid #CBD5E1;
                background: white;
                color: #334155;
                user-select: none;
                transition: all 0.15s;
            }
            .skolif-lok-chip.selected {
                background: #DCFCE7;
                border-color: #22C55E;
                color: #166534;
                font-weight: 700;
            }
            .skolif-modal-overlay,
            .skolif-modal-overlay * {
                box-sizing: border-box;
            }
            .skolif-class-item-actions {
                display: flex;
                gap: 6px;
                align-items: center;
                flex-wrap: wrap;
            }

            /* ====== MOBILANPASSNING (INGEN UTZOOMNING ELLER AVKLIPPNING) ====== */
            @media (max-width: 640px) {
                html, body {
                    max-width: 100vw;
                    overflow-x: hidden;
                }
                nav, nav > div, .nav-actions, .nav-links {
                    flex-wrap: wrap !important;
                }
                .skolif-modal-overlay {
                    padding: 6px !important;
                    width: 100vw !important;
                    max-width: 100vw !important;
                    left: 0 !important;
                    right: 0 !important;
                }
                .skolif-modal-box {
                    width: 100% !important;
                    max-width: 100% !important;
                    max-height: 93vh !important;
                    max-height: 93dvh !important;
                    border-radius: 16px !important;
                    margin: 0 !important;
                }
                .skolif-modal-header {
                    padding: 13px 15px !important;
                }
                .skolif-modal-header h3 {
                    font-size: 1.05rem !important;
                }
                .skolif-modal-body {
                    padding: 12px 13px !important;
                    gap: 11px !important;
                    overflow-x: hidden !important;
                }
                .skolif-auth-banner {
                    padding: 10px 12px !important;
                    font-size: 0.82rem !important;
                    word-break: break-word;
                }
                .skolif-auth-banner > div:last-child,
                .skolif-auth-banner > button {
                    width: 100%;
                    justify-content: center;
                }
                .skolif-tab-row {
                    display: flex !important;
                    gap: 6px !important;
                    padding-bottom: 8px !important;
                }
                .skolif-tab-btn {
                    flex: 1 1 0 !important;
                    text-align: center !important;
                    justify-content: center !important;
                    padding: 9px 6px !important;
                    font-size: 0.8rem !important;
                }
                .skolif-top-drawer-bar {
                    flex-direction: column !important;
                    align-items: stretch !important;
                    gap: 8px !important;
                }
                .skolif-top-drawer-btns {
                    display: flex !important;
                    width: 100% !important;
                    gap: 6px !important;
                }
                .skolif-top-drawer-btns .skolif-btn-sm {
                    flex: 1 1 0 !important;
                    text-align: center !important;
                    justify-content: center !important;
                    padding: 9px 8px !important;
                    font-size: 0.82rem !important;
                }
                .skolif-mobile-stack {
                    flex-direction: column !important;
                    align-items: stretch !important;
                }
                .skolif-mobile-stack > input,
                .skolif-mobile-stack > select,
                .skolif-mobile-stack > button {
                    width: 100% !important;
                    max-width: 100% !important;
                    min-width: 0 !important;
                    flex: none !important;
                }
                /* 16px på fält i mobilen förhindrar att iPhone/Safari tvångszoomar & klipper sidan */
                .skolif-modal-box input,
                .skolif-modal-box textarea,
                .skolif-modal-box select {
                    font-size: 16px !important;
                    max-width: 100% !important;
                    min-width: 0 !important;
                }
                .skolif-drawer-header-row {
                    flex-direction: column !important;
                    align-items: stretch !important;
                    gap: 8px !important;
                }
                #skolifImportModeSwitch:not([hidden]) {
                    display: flex !important;
                    width: 100% !important;
                }
                #skolifImportModeSwitch[hidden] {
                    display: none !important;
                }
                #skolifImportModeSwitch button {
                    flex: 1 1 0 !important;
                    text-align: center !important;
                    padding: 6px 6px !important;
                    font-size: 0.78rem !important;
                }
                .skolif-form-footer-btns {
                    width: 100% !important;
                    display: flex !important;
                    gap: 8px !important;
                }
                .skolif-form-footer-btns .skolif-btn-sm {
                    flex: 1 1 0 !important;
                    padding: 9px 10px !important;
                    font-size: 0.85rem !important;
                    text-align: center !important;
                }
                .skolif-class-item {
                    flex-direction: column !important;
                    align-items: stretch !important;
                    padding: 10px 12px !important;
                    gap: 8px !important;
                }
                .skolif-class-item-info {
                    justify-content: space-between !important;
                    width: 100% !important;
                }
                .skolif-class-item-actions {
                    width: 100% !important;
                    display: flex !important;
                    gap: 6px !important;
                }
                .skolif-class-item-actions .skolif-btn-sm:not(.danger) {
                    flex: 1 1 0 !important;
                    padding: 8px 8px !important;
                    font-size: 0.82rem !important;
                    text-align: center !important;
                }
                .skolif-class-item-actions .skolif-btn-sm.danger {
                    padding: 8px 11px !important;
                }
                .skolif-tool-card-row {
                    flex-direction: column !important;
                    align-items: stretch !important;
                    gap: 10px !important;
                    padding: 12px 13px !important;
                }
                .skolif-tool-card-row > div {
                    min-width: 0 !important;
                    width: 100% !important;
                }
                .skolif-tool-card-row > button {
                    width: 100% !important;
                    padding: 10px 12px !important;
                    font-size: 0.86rem !important;
                    text-align: center !important;
                }
                .skolif-pin-row-mobile {
                    width: 100% !important;
                    display: flex !important;
                    gap: 8px !important;
                }
                .skolif-pin-row-mobile input {
                    flex: 1 1 0 !important;
                }
                .skolif-pin-row-mobile button {
                    flex: 1 1 0 !important;
                }
            }
        `;
        document.head.appendChild(style);

        if (document.body) {
            const toastContainer = document.createElement('div');
            toastContainer.id = 'skolifToastContainer';
            document.body.appendChild(toastContainer);

            const modalHtml = `
                <div class="skolif-modal-overlay" id="skolifKlasserModal" onclick="if(event.target===this) SkolIFKlasser.closeModal()">
                    <div class="skolif-modal-box">
                        <div class="skolif-modal-header">
                            <h3 id="skolifMainModalTitle"><span>📋</span> Mina Klasser</h3>
                            <button type="button" class="skolif-modal-close" onclick="SkolIFKlasser.closeModal()">✕</button>
                        </div>
                        <div class="skolif-modal-body" style="gap: 14px; padding: 16px 20px;">
                            <!-- Inloggningsstatus -->
                            <div id="skolifModalAuthBanner" class="skolif-auth-banner logged-out"></div>

                            <!-- Flikar (visas för Mina Klasser, döljs när LOK-stöd öppnas separat) -->
                            <div class="skolif-tab-row" id="skolifMainTabRow">
                                <button type="button" id="skolifTabBtn-klasser" class="skolif-tab-btn active" onclick="SkolIFKlasser.switchTab('klasser')">📂 Mina Klasser</button>
                                <button type="button" id="skolifTabBtn-verktyg" class="skolif-tab-btn" onclick="SkolIFKlasser.switchTab('verktyg')">⚙️ Läsårsbyte & Inställningar</button>
                            </div>

                            <!-- FLIK 1: KLASSER & ELEVER -->
                            <div id="skolifTabContent-klasser" style="display: flex; flex-direction: column; gap: 12px;">
                                <!-- Topprad med knappar för att fälla ut formulär -->
                                <div class="skolif-top-drawer-bar" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
                                    <div style="font-size: 0.82rem; font-weight: 800; color: #334155; text-transform: uppercase; letter-spacing: 0.3px;">
                                        Dina sparade klasser
                                    </div>
                                    <div class="skolif-top-drawer-btns" style="display: flex; gap: 8px; flex-wrap: wrap;">
                                        <button type="button" class="skolif-btn-sm" id="skolifBtnToggleSingle" onclick="SkolIFKlasser.toggleClassDrawer('single')" style="padding: 6px 12px;">👤 + Enskild elev</button>
                                        <button type="button" class="skolif-btn-sm primary" id="skolifBtnToggleClass" onclick="SkolIFKlasser.toggleClassDrawer('class')" style="padding: 6px 13px;">➕ Ny klass / Importera</button>
                                    </div>
                                </div>

                                <!-- UTFÄLLBAR 1: Snabblägg till enskild elev -->
                                <div id="skolifSingleStudentDrawer" style="display: none; background: #F0FDF4; border: 1.5px solid #BBF7D0; border-radius: 12px; padding: 12px 14px;">
                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                        <div style="font-weight: 800; font-size: 0.85rem; color: #166534;">👤 Lägg till enskild elev i en klass</div>
                                        <button type="button" onclick="SkolIFKlasser.toggleClassDrawer(null)" style="background:none; border:none; color:#64748B; cursor:pointer; font-weight:800; font-size:0.85rem;">✕</button>
                                    </div>
                                    <div class="skolif-mobile-stack" style="display: flex; gap: 8px; flex-wrap: wrap;">
                                        <input type="text" id="skolifSingleStudentName" placeholder="Elevens namn (t.ex. Anna Andersson)" style="flex: 2; min-width: 160px; padding: 8px 10px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.85rem; font-family: inherit; background: white;" onkeydown="if(event.key==='Enter') SkolIFKlasser.addSingleFromModal()">
                                        <input type="text" id="skolifSingleStudentClass" placeholder="Klass (t.ex. 8B)" style="flex: 1; min-width: 85px; max-width: 120px; padding: 8px 10px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.85rem; font-family: inherit; text-transform: uppercase; font-weight: 700; background: white;" onkeydown="if(event.key==='Enter') SkolIFKlasser.addSingleFromModal()">
                                        <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.addSingleFromModal()" style="padding: 8px 14px;">Lägg till</button>
                                    </div>
                                </div>

                                <!-- UTFÄLLBAR 2: Skapa / Redigera klass eller Massimport -->
                                <div id="skolifClassFormDrawer" style="display: none; background: #F8FAFC; border: 1.5px solid #CBD5E1; border-radius: 12px; padding: 14px;">
                                    <div class="skolif-drawer-header-row" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;">
                                        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 8px;">
                                            <div style="font-weight: 800; font-size: 0.92rem; color: #1E3A24;" id="skolifFormTitle">➕ Lägg till ny klass</div>
                                            <button type="button" onclick="SkolIFKlasser.clearModalForm()" style="background:none; border:none; color:#64748B; cursor:pointer; font-weight:800; font-size:0.95rem; padding: 0 4px;" title="Stäng">✕</button>
                                        </div>
                                        <div id="skolifImportModeSwitch" style="display: inline-flex; background: #E2E8F0; padding: 3px; border-radius: 8px;">
                                            <button type="button" id="skolifModeBtnSingleClass" onclick="SkolIFKlasser.setClassDrawerMode('singleClass')" style="border:none; background:white; color:#0F172A; font-weight:700; font-size:0.76rem; padding:5px 10px; border-radius:6px; cursor:pointer; font-family:inherit;">📁 En klass</button>
                                            <button type="button" id="skolifModeBtnMassImport" onclick="SkolIFKlasser.setClassDrawerMode('massImport')" style="border:none; background:transparent; color:#475569; font-weight:700; font-size:0.76rem; padding:5px 10px; border-radius:6px; cursor:pointer; font-family:inherit;">⚡ Flera klasser samtidigt</button>
                                        </div>
                                    </div>

                                    <!-- Läge A: En klass -->
                                    <div id="skolifSingleClassFormArea">
                                        <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
                                            <input type="text" id="skolifModalClassName" placeholder="Klassbeteckning (t.ex. 8B)" style="flex: 1; min-width: 0; padding: 8px 11px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.86rem; font-family: inherit; font-weight: 700; text-transform: uppercase; background: white;">
                                            <span id="skolifModalCountBadge" style="font-size: 0.76rem; font-weight: 800; color: #2E7D32; background: #E8F5E9; padding: 5px 11px; border-radius: 999px; white-space: nowrap;">0 elever</span>
                                        </div>
                                        <div>
                                            <textarea id="skolifModalClassStudents" rows="5" placeholder="Skriv eller klistra in elever i klassen (ett namn per rad)..." oninput="SkolIFKlasser.updateModalCount()" style="width: 100%; padding: 8px 11px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.84rem; font-family: inherit; resize: vertical; background: white;"></textarea>
                                        </div>
                                        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 8px; flex-wrap: wrap;">
                                            <span style="font-size: 0.73rem; color: #64748B;">💡 Tips: Ändra klassbeteckningen ovan (t.ex. 8B ➔ 9B) om du vill byta namn på klassen.</span>
                                            <div class="skolif-form-footer-btns" style="display: flex; gap: 8px;">
                                                <button type="button" class="skolif-btn-sm" onclick="SkolIFKlasser.clearModalForm()">Avbryt</button>
                                                <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.saveFromModal()">💾 Spara klass</button>
                                            </div>
                                        </div>
                                    </div>

                                    <!-- Läge B: Massimport (flera klasser samtidigt) -->
                                    <div id="skolifMassImportFormArea" style="display: none;">
                                        <p style="font-size: 0.8rem; color: #475569; margin: 0 0 8px 0; line-height: 1.4;">
                                            Klistra in en lista där både elevens namn och klass står på varje rad (t.ex. <strong>Tobias Sellin 9B</strong> eller <strong>Anna Andersson 7A</strong>). Alla klasser skapas automatiskt!
                                        </p>
                                        <textarea id="skolifMassImportText" rows="6" placeholder="Exempel:\nTobias Sellin 9B\nAnna Andersson 7A\nErik Eriksson 8C" style="width: 100%; padding: 9px 11px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.84rem; font-family: inherit; resize: vertical; margin-bottom: 8px; background: white;"></textarea>
                                        <div class="skolif-form-footer-btns" style="display: flex; justify-content: flex-end; gap: 8px;">
                                            <button type="button" class="skolif-btn-sm" onclick="SkolIFKlasser.clearModalForm()">Avbryt</button>
                                            <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.massImportFromModal()">🚀 Kör massimport</button>
                                        </div>
                                    </div>
                                </div>

                                <!-- Sparade klasser lista (Huvudvy med gott om plats) -->
                                <div id="skolifModalClassList" style="display: flex; flex-direction: column; gap: 7px; max-height: 310px; overflow-y: auto;"></div>
                            </div>

                            <!-- FLIK 2: LÄSÅRSBYTE & INSTÄLLNINGAR -->
                            <div id="skolifTabContent-verktyg" style="display: none; flex-direction: column; gap: 12px;">
                                <!-- 1. Läsårsbyte (+1 årskurs för alla klasser) -->
                                <div class="skolif-tool-card-row" style="background: #F0FDF4; border: 1.5px solid #BBF7D0; border-radius: 12px; padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <div style="flex: 1; min-width: 180px;">
                                        <div style="font-weight: 800; font-size: 0.92rem; color: #166534; margin-bottom: 3px;">🎓 Nytt läsår – Höj alla klasser (+1 årskurs)</div>
                                        <div style="font-size: 0.79rem; color: #334155; line-height: 1.4;">
                                            Stegar upp alla klasser ett år (t.ex. <strong>7A ➔ 8A</strong>, <strong>8B ➔ 9B</strong>). Alla elevers saldon i Kiosken följer med!
                                        </div>
                                    </div>
                                    <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.upgradeAllYear()" style="padding: 9px 14px; white-space: nowrap;">🚀 Höj alla klasser (+1)</button>
                                </div>

                                <!-- 2. Exportera elevlista till Excel / CSV -->
                                <div class="skolif-tool-card-row" style="background: #F8FAFC; border: 1.5px solid #E2E8F0; border-radius: 12px; padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <div style="flex: 1; min-width: 180px;">
                                        <div style="font-weight: 800; font-size: 0.92rem; color: #0F172A; margin-bottom: 3px;">📄 Exportera elevregister till Excel (CSV)</div>
                                        <div style="font-size: 0.79rem; color: #475569;">Ladda ner en reservkopia med alla klasser, elever och saldon i Kiosken.</div>
                                    </div>
                                    <button type="button" class="skolif-btn-sm" onclick="SkolIFKlasser.exportCSV()" style="background: #0284C7; color: white; border-color: #0284C7; padding: 9px 14px; white-space: nowrap;">📥 Ladda ner Excel/CSV</button>
                                </div>

                                <!-- 3. PIN-kod för Elevläge (Kiosklås) -->
                                <div class="skolif-tool-card-row" style="background: #FFFBEB; border: 1.5px solid #FDE68A; border-radius: 12px; padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <div style="flex: 1; min-width: 180px;">
                                        <div style="font-weight: 800; font-size: 0.92rem; color: #B45309; margin-bottom: 3px;">🔒 PIN-kod för Elevläge (Kassa & Redskapsbod)</div>
                                        <div style="font-size: 0.79rem; color: #78350F;">Låser admin-knappar när elever står själva i kiosken eller redskapsboden.</div>
                                    </div>
                                    <div class="skolif-pin-row-mobile" style="display: flex; gap: 6px; align-items: center;">
                                        <input type="password" id="skolifSettingsPinInput" maxlength="4" inputmode="numeric" placeholder="4 siffror" style="width: 95px; padding: 7px 10px; border: 1.5px solid #F59E0B; border-radius: 8px; font-size: 0.85rem; font-weight: 800; text-align: center; letter-spacing: 3px; background: white;">
                                        <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.savePinFromSettings()" style="background: #D97706; border-color: #D97706; padding: 8px 14px;">Spara PIN</button>
                                    </div>
                                </div>
                            </div>

                            <!-- FLIK 4: LOK-STÖD (ARENAN) -->
                            <div id="skolifTabContent-lokstod" style="display: none; flex-direction: column; gap: 12px;">
                                <div style="background: linear-gradient(135deg, #143625, #1E4E35); color: white; border-radius: 12px; padding: 13px 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <div>
                                        <div style="font-weight: 800; font-size: 0.92rem;">🏟️ LOK-stödsunderlag för Arenan (Skol-IF)</div>
                                        <div style="font-size: 0.76rem; color: rgba(255,255,255,0.85);">Spara närvaro från rasternas aktiviteter & turneringar så du enkelt kan föra in dem i Arenan.</div>
                                    </div>
                                    <a href="https://forening.idrottsarenan.se" target="_blank" rel="noopener noreferrer" class="skolif-btn-sm" style="background: #4ADE80; color: #064E3B; border: none; text-decoration: none; font-weight: 800; white-space: nowrap;">🏟️ Öppna Arenan ↗</a>
                                </div>

                                <!-- Skapa nytt LOK-tillfälle -->
                                <div style="background: #F8FAFC; border: 1.5px solid #E2E8F0; border-radius: 12px; padding: 13px 14px;">
                                    <div style="font-weight: 800; font-size: 0.86rem; color: #1E3A24; margin-bottom: 8px;">➕ Registrera närvaro för Skol-IF-aktivitet</div>
                                    <div class="skolif-mobile-stack" style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px;">
                                        <input type="date" id="skolifLokDate" style="padding: 7px 10px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.82rem; font-family: inherit;">
                                        <input type="text" id="skolifLokTitle" placeholder="Aktivitet (t.ex. Rastturnering, Fredagsfys, Öppen hall)" style="flex: 2; min-width: 180px; padding: 7px 10px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.82rem; font-family: inherit;">
                                        <select id="skolifLokClassSelect" onchange="SkolIFKlasser.onLokClassChange()" style="flex: 1; min-width: 130px; padding: 7px 10px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.82rem; font-family: inherit; background: white;"></select>
                                    </div>
                                    <div style="display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 8px;">
                                        <span style="font-size: 0.72rem; color: #64748B; font-weight: 600; align-self: center;">Snabbval:</span>
                                        <button type="button" class="skolif-btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="document.getElementById('skolifLokTitle').value='Rastturnering'">🏆 Rastturnering</button>
                                        <button type="button" class="skolif-btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="document.getElementById('skolifLokTitle').value='Öppen idrottshall'">🏀 Öppen hall</button>
                                        <button type="button" class="skolif-btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="document.getElementById('skolifLokTitle').value='Rastaktivitet'">⚽ Rastaktivitet</button>
                                        <button type="button" class="skolif-btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="document.getElementById('skolifLokTitle').value='Skol-IF Träning'">🏃 Skol-IF Träning</button>
                                    </div>
                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                                        <span style="font-size: 0.76rem; font-weight: 700; color: #334155;">Klicka på de elever som deltog (<span id="skolifLokSelectedCount">0</span> valda):</span>
                                        <div style="display: flex; gap: 6px;">
                                            <button type="button" class="skolif-btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="SkolIFKlasser.toggleAllLokStudents(true)">Välj alla</button>
                                            <button type="button" class="skolif-btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="SkolIFKlasser.toggleAllLokStudents(false)">Avmarkera</button>
                                        </div>
                                    </div>
                                    <div id="skolifLokStudentChips" style="display: flex; flex-wrap: wrap; gap: 6px; max-height: 125px; overflow-y: auto; padding: 8px; background: white; border: 1px solid #E2E8F0; border-radius: 8px; margin-bottom: 8px;"></div>
                                    <div style="display: flex; justify-content: flex-end;">
                                        <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.saveLokFromModal()" style="padding: 8px 16px;">💾 Spara LOK-aktivitet</button>
                                    </div>
                                </div>

                                <!-- Sparade LOK-aktiviteter -->
                                <div>
                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                                        <span style="font-size: 0.78rem; font-weight: 800; color: #334155; text-transform: uppercase;">Sparade aktiviteter (Redo för Arenan)</span>
                                        <button type="button" class="skolif-btn-sm" style="padding: 4px 10px; font-size: 0.74rem;" onclick="SkolIFKlasser.exportLokCSV()">📥 Exportera LOK-lista (Excel/CSV)</button>
                                    </div>
                                    <div id="skolifLokListContainer" style="display: flex; flex-direction: column; gap: 6px; max-height: 185px; overflow-y: auto;"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            const wrapper = document.createElement('div');
            wrapper.innerHTML = modalHtml;
            document.body.appendChild(wrapper.firstElementChild);

            // PIN-MODAL FÖR ELEVLÄGE
            const pinModalHtml = `
                <div class="skolif-modal-overlay" id="skolifPinModal" onclick="if(event.target===this) SkolIFKlasser.closePinModal()">
                    <div class="skolif-modal-box" style="max-width: 390px; text-align: center;">
                        <div class="skolif-modal-header">
                            <h3 id="skolifPinModalTitle"><span>🔒</span> Elevläge (PIN-lås)</h3>
                            <button type="button" class="skolif-modal-close" onclick="SkolIFKlasser.closePinModal()">✕</button>
                        </div>
                        <div class="skolif-modal-body" style="padding: 22px 24px; gap: 14px; align-items: center;">
                            <div style="font-size: 2.3rem;" id="skolifPinModalIcon">🔒</div>
                            <p id="skolifPinModalDesc" style="font-size: 0.86rem; color: #475569; line-height: 1.45;"></p>
                            <input type="password" id="skolifPinModalInput" maxlength="4" inputmode="numeric" placeholder="••••" style="width: 160px; padding: 10px 14px; font-size: 1.5rem; font-weight: 800; letter-spacing: 8px; text-align: center; border: 2px solid #CBD5E1; border-radius: 12px; outline: none; font-family: inherit;" onkeydown="if(event.key==='Enter') SkolIFKlasser.submitPinModal()">
                            <div style="display: flex; gap: 8px; width: 100%; justify-content: center;">
                                <button type="button" class="skolif-btn-sm" onclick="SkolIFKlasser.closePinModal()" style="padding: 9px 16px;">Avbryt</button>
                                <button type="button" class="skolif-btn-sm primary" id="skolifPinModalSubmitBtn" onclick="SkolIFKlasser.submitPinModal()" style="padding: 9px 20px;">Bekräfta</button>
                            </div>
                            <button type="button" id="skolifPinGoogleFallbackBtn" onclick="SkolIFKlasser.unlockWithGoogle()" style="background: none; border: none; color: #2E7D32; font-size: 0.76rem; font-weight: 700; text-decoration: underline; cursor: pointer; margin-top: 4px; display: none;">Glömt PIN? Lås upp med Google-inloggning</button>
                        </div>
                    </div>
                </div>
            `;
            const pinWrap = document.createElement('div');
            pinWrap.innerHTML = pinModalHtml;
            document.body.appendChild(pinWrap.firstElementChild);

            // HISTORIK-MODAL FÖR BEEP-TEST & LÖPRUNDAN
            const histModalHtml = `
                <div class="skolif-modal-overlay" id="skolifTestHistoryModal" onclick="if(event.target===this) SkolIFKlasser.closeHistoryModal()">
                    <div class="skolif-modal-box" style="max-width: 780px;">
                        <div class="skolif-modal-header">
                            <h3 id="skolifHistModalTitle"><span>📈</span> Sparad Testhistorik & Utveckling</h3>
                            <button type="button" class="skolif-modal-close" onclick="SkolIFKlasser.closeHistoryModal()">✕</button>
                        </div>
                        <div class="skolif-modal-body" style="padding: 18px 22px; gap: 14px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; background: #F8FAFC; padding: 10px 14px; border-radius: 12px; border: 1.5px solid #E2E8F0;">
                                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                    <span style="font-size: 0.82rem; font-weight: 800; color: #1E3A24;">Filtrera klass:</span>
                                    <select id="skolifHistClassFilter" onchange="SkolIFKlasser.renderTestHistoryModalContent()" style="padding: 6px 12px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.84rem; font-weight: 700; font-family: inherit; background: white;"></select>
                                    <select id="skolifHistTypeFilter" onchange="SkolIFKlasser.renderTestHistoryModalContent()" style="padding: 6px 12px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.84rem; font-weight: 700; font-family: inherit; background: white;">
                                        <option value="ALL">Alla tester (Beep-test & Löprundan)</option>
                                        <option value="beeptest">📢 Endast Beep-test</option>
                                        <option value="lopning">⏱️ Endast Löprundan</option>
                                    </select>
                                </div>
                                <button type="button" class="skolif-btn-sm" onclick="SkolIFKlasser.exportTestHistoryCSV()" style="background: #0284C7; color: white; border-color: #0284C7;">📥 Exportera historik (CSV)</button>
                            </div>
                            <div id="skolifHistContentArea" style="display: flex; flex-direction: column; gap: 14px; max-height: 62vh; overflow-y: auto;"></div>
                        </div>
                    </div>
                </div>
            `;
            const histWrap = document.createElement('div');
            histWrap.innerHTML = histModalHtml;
            document.body.appendChild(histWrap.firstElementChild);
        }
    }

    // ==========================================
    //  RENDERA UI-KOMPONENTER
    // ==========================================
    function updateAuthUI() {
        const authBtns = document.querySelectorAll('[data-skolif-auth-btn]');
        authBtns.forEach(btn => {
            if (currentUser && currentUser.email) {
                const shortName = currentUser.displayName || currentUser.email.split('@')[0];
                btn.innerHTML = `🟢 ${escapeHtml(shortName)}`;
                btn.title = `Inloggad som ${currentUser.email} (Klicka för att öppna Mina Klasser & Konto)`;
                btn.onclick = () => openModal();
            } else {
                btn.innerHTML = `👤 Logga in`;
                btn.title = `Logga in en gång för hela Skol-IF Webben`;
                btn.onclick = () => loginWithGoogle();
            }
        });

        const banner = document.getElementById('skolifModalAuthBanner');
        if (banner) {
            if (currentUser && currentUser.email) {
                const isOwner = currentUser.email.trim().toLowerCase() === 'tobias.sellin@gmail.com';
                banner.className = 'skolif-auth-banner';
                banner.innerHTML = `
                    <div>
                        <strong>☁️ Synkad med Google (${escapeHtml(currentUser.email)})</strong><br>
                        <span style="font-size: 0.78rem;">Alla klasser och elever hämtas och synkas direkt med din databas och Kiosken.</span>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        ${isOwner ? `<a href="statistik.html" class="skolif-btn-sm primary" style="text-decoration: none;">📊 Webbstatistik</a>` : ''}
                        <button type="button" class="skolif-btn-sm" onclick="SkolIFKlasser.logout()">Logga ut</button>
                    </div>
                `;
            } else {
                banner.className = 'skolif-auth-banner logged-out';
                banner.innerHTML = `
                    <div>
                        <strong>💻 Lokalt läge (Sparas på denna dator)</strong><br>
                        <span style="font-size: 0.78rem;">Du kan använda klasser och kassan direkt utan inloggning! Logga in med Google om du vill synka med molnet & mobilen.</span>
                    </div>
                    <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.login()">🔑 Logga in med Google</button>
                `;
            }
        }
    }

    function renderAllClassBars() {
        const bars = document.querySelectorAll('[data-skolif-classbar]');
        const klasser = getClassesLocal();
        const codes = Object.keys(klasser).sort((a, b) => a.localeCompare(b, 'sv'));

        bars.forEach(bar => {
            const isDark = bar.dataset.theme === 'dark';
            bar.className = 'skolif-klasser-bar-wrap' + (isDark ? ' dark-theme' : '');

            const cloudStatusHtml = (currentUser && currentUser.email)
                ? `<span class="skolif-cloud-dot" title="Synkad med ${escapeHtml(currentUser.email)}">☁️ Synkad med Kiosken & Molnet</span>`
                : `<span class="skolif-cloud-dot offline" onclick="SkolIFKlasser.login()" title="Sparas lokalt på datorn. Klicka för att logga in med Google och synka med molnet">💻 Lokal lagring (Logga in för molnsynk)</span>`;

            let pillsHtml = '';
            if (codes.length === 0) {
                pillsHtml = `<span style="font-size: 0.8rem; color: #94A3B8; font-style: italic;">Inga klasser inlagda än. Klicka på "+ Hantera klasser" för att lägga in en klass (eller logga in för att hämta från molnet).</span>`;
            } else {
                pillsHtml = codes.map(code => {
                    const count = countStudents(klasser[code]);
                    const label = formatDisplayKlass(code);
                    return `
                        <button type="button" class="skolif-class-pill" onclick="SkolIFKlasser.triggerSelect('${escapeHtml(code)}')" title="Klicka för att ladda ${escapeHtml(label)} (${count} elever)">
                            <span>📁 ${escapeHtml(label)}</span>
                            <span class="skolif-class-pill-count">(${count})</span>
                        </button>
                    `;
                }).join('');
            }

            bar.innerHTML = `
                <div class="skolif-klasser-bar-header">
                    <div class="skolif-klasser-bar-title">
                        <span>📂 Mina Klasser</span>
                        ${cloudStatusHtml}
                    </div>
                    <button type="button" class="skolif-manage-btn" onclick="SkolIFKlasser.openModal()">+ Hantera klasser</button>
                </div>
                <div class="skolif-klasser-pills">
                    ${pillsHtml}
                </div>
            `;
        });
    }

    function renderModalClassList() {
        const listEl = document.getElementById('skolifModalClassList');
        const klasser = getClassesLocal();
        const codes = Object.keys(klasser).sort((a, b) => a.localeCompare(b, 'sv'));

        // Uppdatera även dropdowns i verktygsfliken
        const renameSel = document.getElementById('skolifRenameFromSelect');
        const deleteSel = document.getElementById('skolifDeleteClassSelect');
        const optionsHtml = codes.length === 0
            ? '<option value="">Inga klasser inlagda</option>'
            : '<option value="">-- Välj klass --</option>' + codes.map(c => `<option value="${escapeHtml(c)}">Klass ${escapeHtml(c)} (${countStudents(klasser[c])} elever)</option>`).join('');
        if (renameSel) renameSel.innerHTML = optionsHtml;
        if (deleteSel) deleteSel.innerHTML = optionsHtml;

        if (!listEl) return;

        if (codes.length === 0) {
            listEl.innerHTML = `
                <div style="text-align: center; padding: 14px; color: #64748B; font-size: 0.82rem; background: #F8FAFC; border-radius: 10px; border: 1px dashed #CBD5E1;">
                    Inga klasser inlagda än. Lägg till en elev eller klass nedan (eller använd Massimport)!
                </div>
            `;
            return;
        }

        listEl.innerHTML = codes.map(code => {
            const count = countStudents(klasser[code]);
            const label = formatDisplayKlass(code);
            const useBtnHtml = typeof onClassSelectCallback === 'function'
                ? `<button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.triggerSelect('${escapeHtml(code)}'); SkolIFKlasser.closeModal();">⚡ Välj klass</button>`
                : '';

            return `
                <div class="skolif-class-item" style="padding: 8px 12px;">
                    <div class="skolif-class-item-info">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="font-size: 1rem;">📁</span>
                            <span class="skolif-class-item-name" style="font-size: 0.9rem;">${escapeHtml(label)}</span>
                        </div>
                        <span class="skolif-class-item-badge">${count} elever</span>
                    </div>
                    <div class="skolif-class-item-actions" style="display: flex; gap: 6px;">
                        ${useBtnHtml}
                        <button type="button" class="skolif-btn-sm" onclick="SkolIFKlasser.editInModal('${escapeHtml(code)}')">✏️ Visa / Ändra</button>
                        <button type="button" class="skolif-btn-sm danger" onclick="SkolIFKlasser.removeFromModal('${escapeHtml(code)}')">🗑️</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    // ==========================================
    //  MODAL-INTERAKTION
    // ==========================================
    let editingOriginalKlassCode = null;

    function toggleClassDrawer(drawerType) {
        const singleDrawer = document.getElementById('skolifSingleStudentDrawer');
        const classDrawer = document.getElementById('skolifClassFormDrawer');

        if (drawerType === 'single') {
            const isOpening = singleDrawer && singleDrawer.style.display === 'none';
            if (singleDrawer) singleDrawer.style.display = isOpening ? 'block' : 'none';
            if (classDrawer) classDrawer.style.display = 'none';
            if (isOpening) {
                const nameIn = document.getElementById('skolifSingleStudentName');
                if (nameIn) nameIn.focus();
            }
        } else if (drawerType === 'class') {
            const isOpening = classDrawer && classDrawer.style.display === 'none';
            if (classDrawer) classDrawer.style.display = isOpening ? 'block' : 'none';
            if (singleDrawer) singleDrawer.style.display = 'none';
            if (isOpening) {
                editingOriginalKlassCode = null;
                setClassDrawerMode('singleClass');
                const nameIn = document.getElementById('skolifModalClassName');
                if (nameIn) nameIn.focus();
            }
        } else {
            if (singleDrawer) singleDrawer.style.display = 'none';
            if (classDrawer) classDrawer.style.display = 'none';
        }
    }

    function setClassDrawerMode(mode) {
        const singleArea = document.getElementById('skolifSingleClassFormArea');
        const massArea = document.getElementById('skolifMassImportFormArea');
        const btnSingle = document.getElementById('skolifModeBtnSingleClass');
        const btnMass = document.getElementById('skolifModeBtnMassImport');
        const titleEl = document.getElementById('skolifFormTitle');
        const modeSwitch = document.getElementById('skolifImportModeSwitch');

        if (modeSwitch) {
            modeSwitch.hidden = Boolean(editingOriginalKlassCode);
            modeSwitch.style.display = editingOriginalKlassCode ? 'none' : 'inline-flex';
        }

        if (mode === 'massImport') {
            if (singleArea) singleArea.style.display = 'none';
            if (massArea) massArea.style.display = 'block';
            if (btnSingle) { btnSingle.style.background = 'transparent'; btnSingle.style.color = '#475569'; }
            if (btnMass) { btnMass.style.background = 'white'; btnMass.style.color = '#0F172A'; }
            if (titleEl) titleEl.textContent = '⚡ Importera flera klasser samtidigt';
        } else {
            if (singleArea) singleArea.style.display = 'block';
            if (massArea) massArea.style.display = 'none';
            if (btnSingle) { btnSingle.style.background = 'white'; btnSingle.style.color = '#0F172A'; }
            if (btnMass) { btnMass.style.background = 'transparent'; btnMass.style.color = '#475569'; }
            if (titleEl && !editingOriginalKlassCode) titleEl.textContent = '➕ Lägg till ny klass';
        }
    }

    function switchTab(tabName) {
        if (tabName === 'massimport') {
            switchTab('klasser');
            const classDrawer = document.getElementById('skolifClassFormDrawer');
            if (classDrawer) classDrawer.style.display = 'block';
            setClassDrawerMode('massImport');
            return;
        }

        const headerTitle = document.getElementById('skolifMainModalTitle');
        const tabRow = document.getElementById('skolifMainTabRow');
        if (tabName === 'lokstod') {
            if (headerTitle) headerTitle.innerHTML = '<span>🏟️</span> LOK-stöd & Närvaro (Arenan)';
            if (tabRow) tabRow.style.display = 'none';
        } else {
            if (headerTitle) headerTitle.innerHTML = '<span>📋</span> Mina Klasser';
            if (tabRow) tabRow.style.display = 'flex';
        }

        ['klasser', 'lokstod', 'verktyg'].forEach(t => {
            const btn = document.getElementById('skolifTabBtn-' + t);
            const content = document.getElementById('skolifTabContent-' + t);
            if (btn) {
                if (t === tabName) btn.classList.add('active');
                else btn.classList.remove('active');
            }
            if (content) {
                content.style.display = (t === tabName) ? 'flex' : 'none';
            }
        });
        renderModalClassList();
        if (tabName === 'lokstod') {
            renderLokstodTab();
        }
        if (tabName === 'verktyg') {
            const pinIn = document.getElementById('skolifSettingsPinInput');
            if (pinIn) pinIn.value = getElevlagePin() || '';
        }
    }

    function openModal(prefillName, prefillText, initialTab) {
        injectStylesAndModal();
        if (isElevlageActive()) {
            requireTeacherUnlock(() => openModal(prefillName, prefillText, initialTab));
            return;
        }
        updateAuthUI();
        renderModalClassList();
        const targetTab = initialTab || 'klasser';
        switchTab(targetTab);

        if (targetTab === 'klasser') {
            const hasClasses = Object.keys(getClassesLocal()).length > 0;
            const classDrawer = document.getElementById('skolifClassFormDrawer');
            const singleDrawer = document.getElementById('skolifSingleStudentDrawer');
            if (singleDrawer) singleDrawer.style.display = 'none';

            if (prefillName || prefillText || !hasClasses) {
                if (classDrawer) classDrawer.style.display = 'block';
                setClassDrawerMode('singleClass');
                const nameInput = document.getElementById('skolifModalClassName');
                const textInput = document.getElementById('skolifModalClassStudents');
                if (nameInput && prefillName) nameInput.value = normalizeKlassCode(prefillName);
                if (textInput && prefillText) textInput.value = prefillText;
                updateModalCount();
            } else {
                if (classDrawer) classDrawer.style.display = 'none';
            }
        }

        const modal = document.getElementById('skolifKlasserModal');
        if (modal) modal.classList.add('open');
    }

    function closeModal() {
        const modal = document.getElementById('skolifKlasserModal');
        if (modal) modal.classList.remove('open');
    }

    function updateModalCount() {
        const textInput = document.getElementById('skolifModalClassStudents');
        const badge = document.getElementById('skolifModalCountBadge');
        if (textInput && badge) {
            badge.textContent = countStudents(textInput.value) + ' elever';
        }
    }

    function editInModal(rawCode) {
        const code = normalizeKlassCode(rawCode);
        const klasser = getClassesLocal();
        if (!(code in klasser)) return;
        switchTab('klasser');
        editingOriginalKlassCode = code;
        const singleDrawer = document.getElementById('skolifSingleStudentDrawer');
        const classDrawer = document.getElementById('skolifClassFormDrawer');
        if (singleDrawer) singleDrawer.style.display = 'none';
        if (classDrawer) classDrawer.style.display = 'block';
        setClassDrawerMode('singleClass');
        const nameInput = document.getElementById('skolifModalClassName');
        const textInput = document.getElementById('skolifModalClassStudents');
        const titleEl = document.getElementById('skolifFormTitle');
        if (nameInput) nameInput.value = code;
        if (textInput) textInput.value = klasser[code];
        if (titleEl) titleEl.textContent = `✏️ Redigerar ${formatDisplayKlass(code)}`;
        updateModalCount();
        if (textInput) textInput.focus();
    }

    function clearModalForm() {
        editingOriginalKlassCode = null;
        const nameInput = document.getElementById('skolifModalClassName');
        const textInput = document.getElementById('skolifModalClassStudents');
        const titleEl = document.getElementById('skolifFormTitle');
        const classDrawer = document.getElementById('skolifClassFormDrawer');
        if (nameInput) nameInput.value = '';
        if (textInput) textInput.value = '';
        if (titleEl) titleEl.textContent = '➕ Lägg till ny klass';
        setClassDrawerMode('singleClass');
        updateModalCount();
        if (classDrawer && Object.keys(getClassesLocal()).length > 0) {
            classDrawer.style.display = 'none';
        }
    }

    async function saveFromModal() {
        const nameInput = document.getElementById('skolifModalClassName');
        const textInput = document.getElementById('skolifModalClassStudents');
        const name = (nameInput ? nameInput.value : '').trim();
        const text = (textInput ? textInput.value : '').trim();

        if (!name) {
            showToast('Ange en klassbeteckning (t.ex. 7B)!', 'warning');
            if (nameInput) nameInput.focus();
            return;
        }
        if (!text && !editingOriginalKlassCode) {
            showToast('Skriv eller klistra in minst en elev i listan!', 'warning');
            if (textInput) textInput.focus();
            return;
        }

        await saveClass(name, text, true, editingOriginalKlassCode);
        clearModalForm();
    }

    async function addSingleFromModal() {
        const nameEl = document.getElementById('skolifSingleStudentName');
        const classEl = document.getElementById('skolifSingleStudentClass');
        const ok = await addSingleStudent(nameEl ? nameEl.value : '', classEl ? classEl.value : '');
        if (ok && nameEl) {
            nameEl.value = '';
            nameEl.focus();
        }
    }

    async function massImportFromModal() {
        const textEl = document.getElementById('skolifMassImportText');
        const ok = await massImportStudents(textEl ? textEl.value : '');
        if (ok && textEl) {
            textEl.value = '';
            clearModalForm();
            switchTab('klasser');
        }
    }

    async function renameFromTool() {
        const fromEl = document.getElementById('skolifRenameFromSelect');
        const toEl = document.getElementById('skolifRenameToInput');
        const ok = await renameSingleClass(fromEl ? fromEl.value : '', toEl ? toEl.value : '');
        if (ok && toEl) {
            toEl.value = '';
        }
    }

    async function deleteFromTool() {
        const sel = document.getElementById('skolifDeleteClassSelect');
        if (!sel || !sel.value) {
            showToast('Välj en klass i listan först!', 'warning');
            return;
        }
        await deleteClass(sel.value);
    }

    async function removeFromModal(code) {
        await deleteClass(code);
    }

    function triggerSelect(rawCode) {
        const code = normalizeKlassCode(rawCode);
        const klasser = getClassesLocal();
        const text = klasser[code];
        if (!text) return;
        if (typeof onClassSelectCallback === 'function') {
            onClassSelectCallback(formatDisplayKlass(code), text, code);
            const antal = countStudents(text);
            showToast(`📂 Klass ${code} (${antal} elever) har laddats in!`, 'info');
        }
    }

    // ==========================================
    //  BESÖKSSTATISTIK & DOLD GENVÄG (statistik.html)
    // ==========================================
    const STATS_DOC_ID = '_webb_statistik_';
    const STATS_QUEUE_KEY = 'skolif_pending_stats_v1';
    const LOCAL_STATS_MIRROR_KEY = 'skolif_local_stats_mirror_v1';

    function detectPageKey() {
        const path = (window.location.pathname || '').toLowerCase();
        if (path.includes('statistik')) return 'statistik';
        if (path.includes('kiosk')) return 'kiosk';
        if (path.includes('redskapsboden')) return 'redskapsboden';
        if (path.includes('turnering')) return 'turnering';
        if (path.includes('lopning')) return 'lopning';
        if (path.includes('beeptest')) return 'beeptest';
        if (path.includes('lagdelaren')) return 'lagdelaren';
        if (path.includes('tabata')) return 'tabata';
        if (path.includes('hjulet')) return 'hjulet';
        return 'index';
    }

    function detectDeviceType() {
        const ua = navigator.userAgent || '';
        if (/ipad|tablet|playbook|silk/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
            return 'surfplatta';
        }
        if (/mobile|iphone|ipod|android.*mobile|windows phone/i.test(ua) || window.innerWidth < 768) {
            return 'mobil';
        }
        return 'dator';
    }

    function getTodayDateString() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function updateLocalStatsMirror(eventObj) {
        try {
            const raw = localStorage.getItem(LOCAL_STATS_MIRROR_KEY);
            const mirror = raw ? JSON.parse(raw) : {
                totalaSidvisningar: 0,
                unikaBesokare: 0,
                totalaSessioner: 0,
                sidor: {},
                enheter: {},
                dagar: {}
            };
            mirror.totalaSidvisningar = (mirror.totalaSidvisningar || 0) + 1;
            if (eventObj.isNewVisitor) mirror.unikaBesokare = (mirror.unikaBesokare || 0) + 1;
            if (eventObj.isNewSession) mirror.totalaSessioner = (mirror.totalaSessioner || 0) + 1;

            mirror.sidor = mirror.sidor || {};
            mirror.sidor[eventObj.pageKey] = (mirror.sidor[eventObj.pageKey] || 0) + 1;

            mirror.enheter = mirror.enheter || {};
            mirror.enheter[eventObj.deviceType] = (mirror.enheter[eventObj.deviceType] || 0) + 1;

            mirror.dagar = mirror.dagar || {};
            const day = mirror.dagar[eventObj.todayStr] || { visningar: 0, besokare: 0, sidor: {} };
            day.visningar = (day.visningar || 0) + 1;
            if (eventObj.isNewDailyVisitor) day.besokare = (day.besokare || 0) + 1;
            day.sidor = day.sidor || {};
            day.sidor[eventObj.pageKey] = (day.sidor[eventObj.pageKey] || 0) + 1;
            mirror.dagar[eventObj.todayStr] = day;
            mirror.senastUppdaterad = Date.now();
            mirror.senastAktivSida = eventObj.pageKey;

            localStorage.setItem(LOCAL_STATS_MIRROR_KEY, JSON.stringify(mirror));
        } catch (e) {}
    }

    async function sendStatEventToFirestore(eventObj) {
        if (!db || typeof firebase === 'undefined' || !firebase.firestore || !firebase.firestore.FieldValue) {
            return false;
        }
        const inc = firebase.firestore.FieldValue.increment;
        const payload = {
            kassaId: STATS_DOC_ID,
            namn: 'Skol-IF Webbstatistik',
            senastUppdaterad: Date.now(),
            senastAktivSida: eventObj.pageKey,
            senastEnhet: eventObj.deviceType,
            totalaSidvisningar: inc(eventObj.views || 1),
            sidor: {
                [eventObj.pageKey]: inc(eventObj.views || 1)
            },
            enheter: {
                [eventObj.deviceType]: inc(eventObj.views || 1)
            },
            dagar: {
                [eventObj.todayStr]: {
                    visningar: inc(eventObj.views || 1),
                    sidor: {
                        [eventObj.pageKey]: inc(eventObj.views || 1)
                    }
                }
            }
        };

        if (eventObj.isNewVisitor) {
            payload.unikaBesokare = inc(1);
        }
        if (eventObj.isNewSession) {
            payload.totalaSessioner = inc(1);
        }
        if (eventObj.isNewDailyVisitor) {
            payload.dagar[eventObj.todayStr].besokare = inc(1);
        }

        await db.collection('skolif_kassa').doc(STATS_DOC_ID).set(payload, { merge: true });
        return true;
    }

    async function flushPendingStatsQueue() {
        try {
            const raw = localStorage.getItem(STATS_QUEUE_KEY);
            if (!raw) return;
            const queue = JSON.parse(raw);
            if (!Array.isArray(queue) || queue.length === 0) return;

            localStorage.removeItem(STATS_QUEUE_KEY);
            for (const ev of queue) {
                try {
                    await sendStatEventToFirestore(ev);
                } catch (err) {
                    // Om det fortfarande inte går (t.ex. ej inloggad), spara kvar i kön
                    const currentRaw = localStorage.getItem(STATS_QUEUE_KEY);
                    const currentQ = currentRaw ? JSON.parse(currentRaw) : [];
                    currentQ.push(ev);
                    localStorage.setItem(STATS_QUEUE_KEY, JSON.stringify(currentQ.slice(-50)));
                    break;
                }
            }
        } catch (e) {}
    }

    async function recordPageVisit() {
        const pageKey = detectPageKey();
        if (pageKey === 'statistik') return;

        const todayStr = getTodayDateString();
        const deviceType = detectDeviceType();

        let isNewVisitor = false;
        let isNewDailyVisitor = false;
        let isNewSession = false;

        try {
            let visitorId = localStorage.getItem('skolif_visitor_id');
            if (!visitorId) {
                visitorId = 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                localStorage.setItem('skolif_visitor_id', visitorId);
                isNewVisitor = true;
            }

            const lastVisitDate = localStorage.getItem('skolif_last_visit_date');
            if (lastVisitDate !== todayStr) {
                localStorage.setItem('skolif_last_visit_date', todayStr);
                isNewDailyVisitor = true;
            }

            if (!sessionStorage.getItem('skolif_session_active')) {
                sessionStorage.setItem('skolif_session_active', '1');
                isNewSession = true;
            }
        } catch (e) {}

        const eventObj = {
            pageKey,
            todayStr,
            deviceType,
            isNewVisitor,
            isNewDailyVisitor,
            isNewSession,
            views: 1,
            ts: Date.now()
        };

        updateLocalStatsMirror(eventObj);

        try {
            await flushPendingStatsQueue();
            await sendStatEventToFirestore(eventObj);
        } catch (err) {
            try {
                const raw = localStorage.getItem(STATS_QUEUE_KEY);
                const queue = raw ? JSON.parse(raw) : [];
                queue.push(eventObj);
                localStorage.setItem(STATS_QUEUE_KEY, JSON.stringify(queue.slice(-50)));
            } catch (e) {}
        }
    }

    const ADMIN_STATS_EMAIL = 'tobias.sellin@gmail.com';

    function isStatsAdminUser(userObj) {
        const u = userObj !== undefined ? userObj : currentUser;
        return Boolean(u && u.email && u.email.trim().toLowerCase() === ADMIN_STATS_EMAIL);
    }

    function updateHiddenStatsButtonVisibility() {
        if (!document.body) return;
        let btn = document.getElementById('skolifHiddenStatsBtn');

        if (isStatsAdminUser()) {
            if (!btn) {
                btn = document.createElement('a');
                btn.id = 'skolifHiddenStatsBtn';
                btn.href = 'statistik.html';
                btn.title = 'Öppna webbstatistik (Endast synlig för dig)';
                btn.innerHTML = '📊 <span>Statistik</span>';
                btn.style.cssText = 'position:fixed;bottom:14px;right:16px;padding:7px 14px;display:inline-flex;align-items:center;gap:6px;font-size:0.8rem;font-weight:700;font-family:Poppins,sans-serif;color:#4ADE80;background:rgba(7,18,12,0.92);border:1px solid rgba(74,222,128,0.4);border-radius:99px;text-decoration:none;box-shadow:0 8px 24px rgba(0,0,0,0.45);transition:all 0.2s;z-index:9990;user-select:none;';
                btn.onmouseover = function () {
                    btn.style.transform = 'translateY(-2px)';
                    btn.style.background = 'rgba(22,101,52,0.95)';
                    btn.style.color = '#FFFFFF';
                };
                btn.onmouseout = function () {
                    btn.style.transform = 'translateY(0)';
                    btn.style.background = 'rgba(7,18,12,0.92)';
                    btn.style.color = '#4ADE80';
                };
                document.body.appendChild(btn);
            }
            btn.style.display = 'inline-flex';
        } else if (btn) {
            btn.style.display = 'none';
        }
    }

    window.addEventListener('keydown', function (e) {
        if (e.altKey && (e.key === 's' || e.key === 'S') && isStatsAdminUser()) {
            e.preventDefault();
            window.location.href = 'statistik.html';
        }
    });

    if (auth) {
        auth.onAuthStateChanged((user) => {
            updateHiddenStatsButtonVisibility();
            if (user) {
                flushPendingStatsQueue();
            }
        });
    }

    // ==========================================
    //  1. ELEVLÄGE / KIOSKLÅS (PIN-KOD)
    // ==========================================
    const ELEVLAGE_PIN_KEY = 'skolif_elevlage_pin';
    const ELEVLAGE_ACTIVE_KEY = 'skolif_elevlage_active';
    let pinModalMode = 'UNLOCK'; // 'SET_AND_LOCK' eller 'UNLOCK'
    let pendingUnlockCallback = null;

    function getElevlagePin() {
        try {
            return (localStorage.getItem(ELEVLAGE_PIN_KEY) || '').trim();
        } catch (e) {
            return '';
        }
    }

    async function setElevlagePin(newPin) {
        const clean = String(newPin || '').replace(/\D/g, '').slice(0, 4);
        if (clean.length !== 4) return false;
        try {
            localStorage.setItem(ELEVLAGE_PIN_KEY, clean);
        } catch (e) {}

        if (currentUser && db) {
            try {
                if (!activeKassaDocId) activeKassaDocId = await resolveAndMergeKassa(currentUser);
                await db.collection('skolif_kassa').doc(activeKassaDocId).set({
                    elevlagePin: clean,
                    senastUppdaterad: Date.now()
                }, { merge: true });
            } catch (e) {}
        }
        return true;
    }

    function isElevlageActive() {
        try {
            return localStorage.getItem(ELEVLAGE_ACTIVE_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function setElevlageActive(active) {
        try {
            localStorage.setItem(ELEVLAGE_ACTIVE_KEY, active ? '1' : '0');
        } catch (e) {}
        updateElevlageUI();
        window.dispatchEvent(new CustomEvent('skolif-elevlage-changed', { detail: { locked: Boolean(active) } }));
    }

    function updateElevlageUI() {
        if (!document.body) return;
        const locked = isElevlageActive();
        if (locked) {
            document.body.classList.add('skolif-elevlage-locked');
        } else {
            document.body.classList.remove('skolif-elevlage-locked');
        }

        const btns = document.querySelectorAll('[data-skolif-elevlage-btn]');
        btns.forEach(btn => {
            btn.classList.add('skolif-elevlage-pill');
            if (locked) {
                btn.classList.add('locked');
                btn.innerHTML = '🔒 Elevläge PÅ <span style="font-weight:500;font-size:0.74rem;opacity:0.95;">(Lås upp)</span>';
                btn.title = 'Elevläge är aktivt – adminfunktioner är låsta. Klicka för att låsa upp med PIN-kod.';
            } else {
                btn.classList.remove('locked');
                btn.innerHTML = '🔓 Elevläge';
                btn.title = 'Aktivera låst Elevläge när elever står i kiosken eller redskapsboden';
            }
        });
    }

    function openPinModal(mode, onUnlockedCallback) {
        injectStylesAndModal();
        pinModalMode = mode || 'UNLOCK';
        pendingUnlockCallback = typeof onUnlockedCallback === 'function' ? onUnlockedCallback : null;

        const modal = document.getElementById('skolifPinModal');
        const title = document.getElementById('skolifPinModalTitle');
        const icon = document.getElementById('skolifPinModalIcon');
        const desc = document.getElementById('skolifPinModalDesc');
        const input = document.getElementById('skolifPinModalInput');
        const submitBtn = document.getElementById('skolifPinModalSubmitBtn');
        const googleFallback = document.getElementById('skolifPinGoogleFallbackBtn');

        if (!modal || !input) return;
        input.value = '';

        if (pinModalMode === 'SET_AND_LOCK') {
            if (title) title.innerHTML = '<span>🔒</span> Välj PIN-kod för Elevläge';
            if (icon) icon.textContent = '🛡️';
            if (desc) desc.innerHTML = 'Välj en <strong>4-siffrig PIN-kod</strong>. I Elevläge kan eleverna sälja varor och låna ut redskap, men inte ändra saldon, varor eller radera elever.';
            if (submitBtn) submitBtn.textContent = 'Spara & Lås';
            if (googleFallback) googleFallback.style.display = 'none';
        } else {
            if (title) title.innerHTML = '<span>🔓</span> Lås upp Elevläge';
            if (icon) icon.textContent = '🔒';
            if (desc) desc.innerHTML = 'Ange din <strong>4-siffriga PIN-kod</strong> för att återgå till lärarläge och låsa upp alla inställningar.';
            if (submitBtn) submitBtn.textContent = 'Lås upp';
            if (googleFallback) googleFallback.style.display = 'inline-block';
        }

        modal.classList.add('open');
        setTimeout(() => input.focus(), 60);
    }

    function closePinModal() {
        const modal = document.getElementById('skolifPinModal');
        if (modal) modal.classList.remove('open');
        pendingUnlockCallback = null;
    }

    async function submitPinModal() {
        const input = document.getElementById('skolifPinModalInput');
        if (!input) return;
        const val = String(input.value || '').replace(/\D/g, '').trim();

        if (pinModalMode === 'SET_AND_LOCK') {
            if (val.length !== 4) {
                showToast('Ange exakt 4 siffror som PIN-kod (t.ex. 1234)!', 'warning');
                input.focus();
                return;
            }
            await setElevlagePin(val);
            setElevlageActive(true);
            closePinModal();
            showToast('🔒 Elevläge är nu aktiverat! Admin-knappar är dolda.', 'success');
        } else {
            const savedPin = getElevlagePin();
            if (!savedPin || val === savedPin) {
                const cb = pendingUnlockCallback;
                setElevlageActive(false);
                closePinModal();
                showToast('🔓 Upplåst! Lärarläge är nu aktivt.', 'info');
                if (typeof cb === 'function') cb();
            } else {
                showToast('Fel PIN-kod! Försök igen.', 'error');
                input.value = '';
                input.focus();
            }
        }
    }

    function toggleElevlage() {
        if (isElevlageActive()) {
            openPinModal('UNLOCK');
        } else {
            const savedPin = getElevlagePin();
            if (!savedPin) {
                openPinModal('SET_AND_LOCK');
            } else {
                setElevlageActive(true);
                showToast('🔒 Elevläge aktiverat! Klicka på knappen igen för att låsa upp med PIN.', 'info');
            }
        }
    }

    function requireTeacherUnlock(callback) {
        if (!isElevlageActive()) {
            if (typeof callback === 'function') callback();
            return true;
        }
        openPinModal('UNLOCK', callback);
        return false;
    }

    async function savePinFromSettings() {
        const pinIn = document.getElementById('skolifSettingsPinInput');
        if (!pinIn) return;
        const val = String(pinIn.value || '').replace(/\D/g, '').trim();
        if (val.length !== 4) {
            showToast('PIN-koden måste bestå av 4 siffror!', 'warning');
            pinIn.focus();
            return;
        }
        await setElevlagePin(val);
        showToast('🔒 Ny 4-siffrig PIN-kod för Elevläge har sparats!', 'success');
    }

    async function unlockWithGoogle() {
        if (!auth || typeof firebase === 'undefined') return;
        try {
            const provider = new firebase.auth.GoogleAuthProvider();
            await auth.signInWithPopup(provider);
            const cb = pendingUnlockCallback;
            setElevlageActive(false);
            closePinModal();
            showToast('🔓 Upplåst via Google-inloggning!', 'success');
            if (typeof cb === 'function') cb();
        } catch (err) {
            showToast('Verifieringen avbröts.', 'warning');
        }
    }

    // ==========================================
    //  2. LOK-STÖDSUNDERLAG (KOPPLAT TILL ARENAN)
    // ==========================================
    const LOK_STORAGE_KEY = 'skolif_lokstod_v1';
    let lokSelectedStudentsSet = new Set();

    function getLokList() {
        try {
            const raw = localStorage.getItem(LOK_STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    async function persistLokList(list) {
        const cleanList = Array.isArray(list) ? list.slice(0, 250) : [];
        try {
            localStorage.setItem(LOK_STORAGE_KEY, JSON.stringify(cleanList));
        } catch (e) {}

        if (currentUser && db) {
            try {
                if (!activeKassaDocId) activeKassaDocId = await resolveAndMergeKassa(currentUser);
                await db.collection('skolif_kassa').doc(activeKassaDocId).set({
                    lokstod: JSON.stringify(cleanList),
                    senastUppdaterad: Date.now()
                }, { merge: true });
            } catch (err) {
                console.warn('Kunde inte synka LOK-stöd till molnet:', err);
            }
        }
        renderLokstodTab();
    }

    async function saveLokActivity(opts) {
        const options = opts || {};
        const datum = options.datum || getTodayDateString();
        const titel = String(options.titel || 'Skol-IF Aktivitet').trim();
        const klass = String(options.klass || 'Blandat').trim();
        const rawNames = Array.isArray(options.deltagare) ? options.deltagare : [];
        const deltagare = [...new Set(rawNames.map(n => String(n || '').trim()).filter(Boolean))];

        if (deltagare.length === 0) {
            showToast('Välj minst en deltagande elev för LOK-stödet!', 'warning');
            return false;
        }

        const list = getLokList();
        const newEntry = {
            id: 'lok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            datum,
            titel,
            klass,
            deltagare,
            antal: deltagare.length,
            skapad: Date.now()
        };
        list.unshift(newEntry);
        await persistLokList(list);
        showToast(`🏟️ Sparat i LOK-stöd: "${titel}" (${deltagare.length} deltagare)!`, 'success');
        return true;
    }

    function onLokClassChange() {
        const classSel = document.getElementById('skolifLokClassSelect');
        const chipBox = document.getElementById('skolifLokStudentChips');
        if (!classSel || !chipBox) return;

        const klasser = getClassesLocal();
        const selectedClass = classSel.value;
        let students = [];

        if (selectedClass === '__ALL__') {
            Object.keys(klasser).sort((a, b) => a.localeCompare(b, 'sv')).forEach(code => {
                parseStudentNames(klasser[code]).forEach(n => students.push(`${n} (${code})`));
            });
        } else if (selectedClass && klasser[selectedClass]) {
            students = parseStudentNames(klasser[selectedClass]);
        }

        lokSelectedStudentsSet = new Set(students);
        renderLokStudentChips(students);
    }

    function renderLokStudentChips(allStudentsInSelection) {
        const chipBox = document.getElementById('skolifLokStudentChips');
        const countEl = document.getElementById('skolifLokSelectedCount');
        if (!chipBox) return;

        const currentStudents = allStudentsInSelection || Array.from(chipBox.querySelectorAll('[data-lok-student]')).map(el => el.dataset.lokStudent);
        if (countEl) countEl.textContent = String(lokSelectedStudentsSet.size);

        if (!currentStudents || currentStudents.length === 0) {
            chipBox.innerHTML = `<span style="font-size: 0.78rem; color: #94A3B8; font-style: italic;">Välj en klass i rullgardinsmenyn ovan för att bocka i deltagare.</span>`;
            return;
        }

        chipBox.innerHTML = currentStudents.map(name => {
            const isSel = lokSelectedStudentsSet.has(name);
            return `<span class="skolif-lok-chip ${isSel ? 'selected' : ''}" data-lok-student="${escapeHtml(name)}" onclick="SkolIFKlasser.toggleSingleLokStudent(this)">${isSel ? '✓' : '+'} ${escapeHtml(name)}</span>`;
        }).join('');
    }

    function toggleSingleLokStudent(el) {
        if (!el || !el.dataset.lokStudent) return;
        const name = el.dataset.lokStudent;
        if (lokSelectedStudentsSet.has(name)) {
            lokSelectedStudentsSet.delete(name);
        } else {
            lokSelectedStudentsSet.add(name);
        }
        renderLokStudentChips();
    }

    function toggleAllLokStudents(selectAll) {
        const chipBox = document.getElementById('skolifLokStudentChips');
        if (!chipBox) return;
        const all = Array.from(chipBox.querySelectorAll('[data-lok-student]')).map(el => el.dataset.lokStudent);
        if (selectAll) {
            lokSelectedStudentsSet = new Set(all);
        } else {
            lokSelectedStudentsSet.clear();
        }
        renderLokStudentChips(all);
    }

    async function saveLokFromModal() {
        const dateEl = document.getElementById('skolifLokDate');
        const titleEl = document.getElementById('skolifLokTitle');
        const classSel = document.getElementById('skolifLokClassSelect');

        const datum = (dateEl && dateEl.value) ? dateEl.value : getTodayDateString();
        const titel = (titleEl && titleEl.value.trim()) ? titleEl.value.trim() : 'Rastaktivitet';
        const klassVal = (classSel && classSel.value) ? (classSel.value === '__ALL__' ? 'Alla klasser' : `Klass ${classSel.value}`) : '';

        const ok = await saveLokActivity({
            datum,
            titel,
            klass: klassVal,
            deltagare: Array.from(lokSelectedStudentsSet)
        });
        if (ok && titleEl) {
            titleEl.value = '';
        }
    }

    function renderLokstodTab() {
        const dateEl = document.getElementById('skolifLokDate');
        if (dateEl && !dateEl.value) {
            dateEl.value = getTodayDateString();
        }

        const classSel = document.getElementById('skolifLokClassSelect');
        if (classSel) {
            const prev = classSel.value;
            const klasser = getClassesLocal();
            const codes = Object.keys(klasser).sort((a, b) => a.localeCompare(b, 'sv'));
            if (codes.length === 0) {
                classSel.innerHTML = '<option value="">Inga klasser inlagda</option>';
            } else {
                classSel.innerHTML = codes.map(c => `<option value="${escapeHtml(c)}">Klass ${escapeHtml(c)} (${countStudents(klasser[c])} elever)</option>`).join('') +
                    `<option value="__ALL__">Alla klasser samtidigt</option>`;
                if (prev && (klasser[prev] || prev === '__ALL__')) {
                    classSel.value = prev;
                } else {
                    classSel.value = codes[0];
                }
            }
            onLokClassChange();
        }

        const listEl = document.getElementById('skolifLokListContainer');
        if (!listEl) return;

        const list = getLokList();
        if (list.length === 0) {
            listEl.innerHTML = `
                <div style="text-align: center; padding: 14px; color: #64748B; font-size: 0.8rem; background: #F8FAFC; border-radius: 10px; border: 1px dashed #CBD5E1;">
                    Inga sparade LOK-stödsaktiviteter än. Registrera ovan eller klicka "🏟️ Spara som LOK-stöd" direkt efter ett lopp, beep-test eller turnering!
                </div>
            `;
            return;
        }

        listEl.innerHTML = list.map(item => `
            <div style="background: white; border: 1.5px solid #E2E8F0; border-radius: 10px; padding: 9px 12px; display: flex; flex-direction: column; gap: 6px;">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
                    <div>
                        <span style="font-weight: 800; font-size: 0.88rem; color: #1E3A24;">🏟️ ${escapeHtml(item.titel)}</span>
                        <span style="font-size: 0.76rem; color: #64748B; margin-left: 6px;">📅 ${escapeHtml(item.datum)} • ${escapeHtml(item.klass || '')}</span>
                        <span class="skolif-class-item-badge" style="margin-left: 6px;">${Number(item.antal) || (item.deltagare || []).length} deltagare</span>
                    </div>
                    <div style="display: flex; gap: 5px;">
                        <button type="button" class="skolif-btn-sm" style="padding: 4px 9px; font-size: 0.74rem;" onclick="SkolIFKlasser.copyLokNames('${escapeHtml(item.id)}')">📋 Kopiera namn</button>
                        <button type="button" class="skolif-btn-sm danger" style="padding: 4px 8px; font-size: 0.74rem;" onclick="SkolIFKlasser.deleteLokItem('${escapeHtml(item.id)}')">🗑️</button>
                    </div>
                </div>
                <div style="font-size: 0.75rem; color: #475569; line-height: 1.4;">
                    ${(item.deltagare || []).map(n => escapeHtml(n)).join(', ')}
                </div>
            </div>
        `).join('');
    }

    function copyLokNames(id) {
        const item = getLokList().find(x => x.id === id);
        if (!item) return;
        const txt = `LOK-stöd: ${item.titel} (${item.datum}) - ${item.klass || ''}\nAntal deltagare: ${(item.deltagare || []).length}\n\n` + (item.deltagare || []).join('\n');
        if (navigator.clipboard) {
            navigator.clipboard.writeText(txt).then(() => {
                showToast('📋 Deltagarlistan har kopierats till urklipp (redo för Arenan)!', 'info');
            });
        }
    }

    async function deleteLokItem(id) {
        if (!confirm('Vill du ta bort detta LOK-stödstillfälle?')) return;
        const next = getLokList().filter(x => x.id !== id);
        await persistLokList(next);
        showToast('🗑️ LOK-tillfället har tagits bort.', 'info');
    }

    function exportLokCSV() {
        const list = getLokList();
        if (list.length === 0) {
            showToast('Det finns inga sparade LOK-aktiviteter att exportera än.', 'warning');
            return;
        }
        let csv = '\uFEFFDatum;Aktivitet;Klass/Grupp;Antal deltagare;Deltagare\r\n';
        list.forEach(item => {
            const names = (item.deltagare || []).join(', ').replace(/"/g, '""');
            csv += `${item.datum};"${String(item.titel || '').replace(/"/g, '""')}";"${String(item.klass || '').replace(/"/g, '""')}";${(item.deltagare || []).length};"${names}"\r\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `SkolIF_LOK_stod_underlag_${getTodayDateString()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('📥 LOK-stödsunderlaget har laddats ner!', 'success');
    }

    // ==========================================
    //  3. SPARAD TESTHISTORIK (BEEP-TEST & LÖPRUNDAN)
    // ==========================================
    const TEST_HIST_KEY = 'skolif_testhistorik_v1';

    function getTestHistory() {
        try {
            const raw = localStorage.getItem(TEST_HIST_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    async function persistTestHistory(list) {
        const clean = Array.isArray(list) ? list.slice(0, 200) : [];
        try {
            localStorage.setItem(TEST_HIST_KEY, JSON.stringify(clean));
        } catch (e) {}

        if (currentUser && db) {
            try {
                if (!activeKassaDocId) activeKassaDocId = await resolveAndMergeKassa(currentUser);
                await db.collection('skolif_kassa').doc(activeKassaDocId).set({
                    testhistorik: JSON.stringify(clean),
                    senastUppdaterad: Date.now()
                }, { merge: true });
            } catch (err) {
                console.warn('Kunde inte synka testhistorik till molnet:', err);
            }
        }
    }

    async function saveTestSession(sessionObj) {
        if (!sessionObj || !Array.isArray(sessionObj.resultat) || sessionObj.resultat.length === 0) {
            showToast('Det finns inga resultat att spara!', 'warning');
            return false;
        }
        const rawKlass = String(sessionObj.klass || '').replace(/^klass\s+/i, '').trim();
        const klassCode = normalizeKlassCode(rawKlass.split(/[\s\-•]+/)[0] || rawKlass) || 'ÖVRIGA';

        const list = getTestHistory();
        const entry = {
            id: 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            typ: sessionObj.typ || 'beeptest', // 'beeptest' | 'lopning'
            titel: String(sessionObj.titel || klassCode).trim(),
            klass: klassCode,
            datum: sessionObj.datum || getTodayDateString(),
            distansKm: Number(sessionObj.distansKm) || 0,
            resultat: sessionObj.resultat, // [{ namn, primarText, sekundarText, sortValue }]
            skapad: Date.now()
        };

        list.unshift(entry);
        await persistTestHistory(list);
        showToast(`☁️ Resultatet för Klass ${klassCode} (${entry.resultat.length} elever) har sparats i historiken!`, 'success');
        return true;
    }

    function openHistoryModal(initialType, initialKlass) {
        injectStylesAndModal();
        if (isElevlageActive()) {
            requireTeacherUnlock(() => openHistoryModal(initialType, initialKlass));
            return;
        }

        const modal = document.getElementById('skolifTestHistoryModal');
        const typeSel = document.getElementById('skolifHistTypeFilter');
        const classSel = document.getElementById('skolifHistClassFilter');
        if (!modal) return;

        if (typeSel && initialType) {
            typeSel.value = initialType;
        }

        const list = getTestHistory();
        const klasser = getClassesLocal();
        const allKlassSet = new Set(Object.keys(klasser));
        list.forEach(item => {
            if (item.klass) allKlassSet.add(item.klass);
        });
        const sortedKlasser = Array.from(allKlassSet).sort((a, b) => a.localeCompare(b, 'sv'));

        if (classSel) {
            classSel.innerHTML = `<option value="ALL">Alla klasser</option>` +
                sortedKlasser.map(k => `<option value="${escapeHtml(k)}">Klass ${escapeHtml(k)}</option>`).join('');
            if (initialKlass) {
                const norm = normalizeKlassCode(String(initialKlass).replace(/^klass\s+/i, '').split(/[\s\-•]+/)[0]);
                if (allKlassSet.has(norm)) classSel.value = norm;
            }
        }

        renderTestHistoryModalContent();
        modal.classList.add('open');
    }

    function closeHistoryModal() {
        const modal = document.getElementById('skolifTestHistoryModal');
        if (modal) modal.classList.remove('open');
    }

    function renderTestHistoryModalContent() {
        const area = document.getElementById('skolifHistContentArea');
        const classSel = document.getElementById('skolifHistClassFilter');
        const typeSel = document.getElementById('skolifHistTypeFilter');
        if (!area) return;

        const filterKlass = classSel ? classSel.value : 'ALL';
        const filterType = typeSel ? typeSel.value : 'ALL';

        const filtered = getTestHistory().filter(item => {
            if (filterKlass !== 'ALL' && item.klass !== filterKlass) return false;
            if (filterType !== 'ALL' && item.typ !== filterType) return false;
            return true;
        });

        if (filtered.length === 0) {
            area.innerHTML = `
                <div style="text-align: center; padding: 32px 16px; color: #64748B; background: #F8FAFC; border-radius: 12px; border: 1.5px dashed #CBD5E1;">
                    <div style="font-size: 2rem; margin-bottom: 6px;">📈</div>
                    <div style="font-weight: 700; color: #334155;">Inga sparade testresultat hittades för detta val</div>
                    <div style="font-size: 0.82rem; margin-top: 4px;">När du avslutar ett <strong>Beep-test</strong> eller en <strong>Löprunda</strong> klickar du på <em>"☁️ Spara resultat på klassen"</em> för att följa elevernas utveckling över tid!</div>
                </div>
            `;
            return;
        }

        // Bygg individuell utvecklingsöversikt om det finns minst 2 tester av samma typ
        let progressHtml = '';
        const byTypeAndStudent = {};
        // Gå igenom kronologiskt (äldst först)
        [...filtered].reverse().forEach(session => {
            (session.resultat || []).forEach(r => {
                if (!r || !r.namn) return;
                const key = `${session.typ}__${r.namn.trim().toLowerCase()}`;
                if (!byTypeAndStudent[key]) {
                    byTypeAndStudent[key] = {
                        namn: r.namn,
                        klass: session.klass,
                        typ: session.typ,
                        entries: []
                    };
                }
                byTypeAndStudent[key].entries.push({
                    datum: session.datum,
                    primarText: r.primarText,
                    sortValue: Number(r.sortValue) || 0
                });
            });
        });

        const studentsWithProgress = Object.values(byTypeAndStudent).filter(s => s.entries.length >= 2);
        if (studentsWithProgress.length > 0) {
            const rows = studentsWithProgress.map(s => {
                const first = s.entries[0];
                const last = s.entries[s.entries.length - 1];
                const improved = s.typ === 'beeptest'
                    ? last.sortValue > first.sortValue
                    : (last.sortValue > 0 && first.sortValue > 0 && last.sortValue < first.sortValue);
                const badgeColor = improved ? 'background:#DCFCE7;color:#166534;border:1px solid #86EFAC;' : 'background:#F1F5F9;color:#475569;border:1px solid #CBD5E1;';
                const icon = s.typ === 'beeptest' ? '📢' : '⏱️';
                return `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 11px;background:white;border-radius:8px;border:1px solid #E2E8F0;font-size:0.82rem;gap:8px;flex-wrap:wrap;">
                        <div>
                            <strong>${icon} ${escapeHtml(s.namn)}</strong>
                            <span style="color:#64748B;font-size:0.75rem;margin-left:5px;">(Klass ${escapeHtml(s.klass)} • ${s.entries.length} tester)</span>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span style="color:#64748B;">${escapeHtml(first.primarText)} <small>(${escapeHtml(first.datum)})</small></span>
                            <span>➔</span>
                            <span style="padding:2px 9px;border-radius:12px;font-weight:800;${badgeColor}">${escapeHtml(last.primarText)} <small>(${escapeHtml(last.datum)})</small> ${improved ? '🌟' : ''}</span>
                        </div>
                    </div>
                `;
            }).join('');

            progressHtml = `
                <div style="background:#F0FDF4;border:1.5px solid #BBF7D0;border-radius:12px;padding:12px 14px;">
                    <div style="font-weight:800;font-size:0.86rem;color:#166534;margin-bottom:8px;">🌱 Individuell utveckling över tid (Första ➔ Senaste testet)</div>
                    <div style="display:flex;flex-direction:column;gap:5px;max-height:170px;overflow-y:auto;">${rows}</div>
                </div>
            `;
        }

        const sessionsHtml = filtered.map(session => {
            const icon = session.typ === 'beeptest' ? '📢 Beep-test' : `⏱️ Löprundan${session.distansKm ? ` (${session.distansKm} km)` : ''}`;
            const rows = (session.resultat || []).map((r, i) => `
                <span style="display:inline-flex;align-items:center;gap:4px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:3px 8px;font-size:0.76rem;">
                    <strong>#${i + 1} ${escapeHtml(r.namn)}:</strong> <span style="color:#2E7D32;font-weight:700;">${escapeHtml(r.primarText)}</span>
                </span>
            `).join('');

            return `
                <div style="background:white;border:1.5px solid #E2E8F0;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
                        <div>
                            <span style="font-weight:800;font-size:0.92rem;color:#1E3A24;">${icon} – Klass ${escapeHtml(session.klass)}</span>
                            <span style="font-size:0.78rem;color:#64748B;margin-left:8px;">📅 ${escapeHtml(session.datum)} • ${(session.resultat || []).length} elever</span>
                        </div>
                        <button type="button" class="skolif-btn-sm danger" style="padding:4px 9px;font-size:0.74rem;" onclick="SkolIFKlasser.deleteTestSession('${escapeHtml(session.id)}')">🗑️ Radera</button>
                    </div>
                    <div style="display:flex;flex-wrap:wrap;gap:5px;">${rows}</div>
                </div>
            `;
        }).join('');

        area.innerHTML = progressHtml + sessionsHtml;
    }

    async function deleteTestSession(id) {
        if (!confirm('Vill du radera detta sparade testtillfälle från historiken?')) return;
        const next = getTestHistory().filter(x => x.id !== id);
        await persistTestHistory(next);
        renderTestHistoryModalContent();
        showToast('🗑️ Testtillfället har raderats.', 'info');
    }

    function exportTestHistoryCSV() {
        const list = getTestHistory();
        if (list.length === 0) {
            showToast('Ingen testhistorik att exportera än.', 'warning');
            return;
        }
        let csv = '\uFEFFDatum;Typ;Klass;Titel;Placering;Elev;Resultat;Detalj\r\n';
        list.forEach(s => {
            (s.resultat || []).forEach((r, idx) => {
                csv += `${s.datum};${s.typ};"${s.klass}";"${String(s.titel || '').replace(/"/g, '""')}";${idx + 1};"${String(r.namn || '').replace(/"/g, '""')}";"${String(r.primarText || '')}";"${String(r.sekundarText || '')}"\r\n`;
            });
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `SkolIF_Testhistorik_${getTodayDateString()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('📥 Testhistoriken har exporterats till Excel/CSV!', 'success');
    }

    // ==========================================
    //  HÅLL SKÄRMEN VAKEN (SCREEN WAKE LOCK) PÅ VERKTYGSSIDOR
    // ==========================================
    let skolifWakeLockSentinel = null;

    async function requestSkolifWakeLock() {
        if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
        if (skolifWakeLockSentinel && !skolifWakeLockSentinel.released) return;
        try {
            skolifWakeLockSentinel = await navigator.wakeLock.request('screen');
            skolifWakeLockSentinel.addEventListener('release', () => {
                skolifWakeLockSentinel = null;
            });
        } catch (e) {}
    }

    function initScreenWakeLock() {
        const pageKey = detectPageKey();
        if (pageKey === 'index' || pageKey === 'statistik') return;

        // Begär Wake Lock direkt samt vid första klick/pek på verktygssidornas timers och tester
        requestSkolifWakeLock();
        document.addEventListener('click', requestSkolifWakeLock, { passive: true });
        document.addEventListener('touchstart', requestSkolifWakeLock, { passive: true });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                requestSkolifWakeLock();
            }
        });
    }

    window.addEventListener('DOMContentLoaded', () => {
        injectStylesAndModal();
        updateHiddenStatsButtonVisibility();
        updateElevlageUI();
        updateAuthUI();
        renderAllClassBars();
        recordPageVisit();
        initScreenWakeLock();
    });

    window.SkolIFKlasser = {
        getClasses: getClassesLocal,
        getActiveElever: getActiveEleverArray,
        getLocalKassa: getLocalKassa,
        saveLocalKassa: saveLocalKassa,
        syncLocalCacheFromCloud: syncLocalCacheFromCloud,
        clearLocalKassa: clearLocalKassa,
        resolveAndMergeKassa: resolveAndMergeKassa,
        saveClass: saveClass,
        deleteClass: deleteClass,
        openModal: openModal,
        closeModal: closeModal,
        switchTab: switchTab,
        toggleClassDrawer: toggleClassDrawer,
        setClassDrawerMode: setClassDrawerMode,
        editInModal: editInModal,
        clearModalForm: clearModalForm,
        saveFromModal: saveFromModal,
        addSingleFromModal: addSingleFromModal,
        massImportFromModal: massImportFromModal,
        upgradeAllYear: upgradeAllClassesYear,
        renameFromTool: renameFromTool,
        deleteFromTool: deleteFromTool,
        exportCSV: exportStudentsCSV,
        removeFromModal: removeFromModal,
        updateModalCount: updateModalCount,
        login: loginWithGoogle,
        logout: logoutGoogle,
        toast: showToast,
        // 1. Elevläge (PIN)
        isElevlage: isElevlageActive,
        toggleElevlage: toggleElevlage,
        requireTeacherUnlock: requireTeacherUnlock,
        openPinModal: openPinModal,
        closePinModal: closePinModal,
        submitPinModal: submitPinModal,
        savePinFromSettings: savePinFromSettings,
        unlockWithGoogle: unlockWithGoogle,
        // 2. LOK-stöd (Arenan)
        saveLokActivity: saveLokActivity,
        onLokClassChange: onLokClassChange,
        toggleSingleLokStudent: toggleSingleLokStudent,
        toggleAllLokStudents: toggleAllLokStudents,
        saveLokFromModal: saveLokFromModal,
        copyLokNames: copyLokNames,
        deleteLokItem: deleteLokItem,
        exportLokCSV: exportLokCSV,
        openLokModal: function () { openModal(null, null, 'lokstod'); },
        // 3. Testhistorik (Beep-test & Löprundan)
        saveTestSession: saveTestSession,
        getTestHistory: getTestHistory,
        openHistoryModal: openHistoryModal,
        closeHistoryModal: closeHistoryModal,
        renderTestHistoryModalContent: renderTestHistoryModalContent,
        deleteTestSession: deleteTestSession,
        exportTestHistoryCSV: exportTestHistoryCSV,
        openInstallAppModal: function () {
            if (window._skolifDeferredInstallPrompt) {
                window._skolifDeferredInstallPrompt.prompt();
                window._skolifDeferredInstallPrompt.userChoice.then(function () {
                    window._skolifDeferredInstallPrompt = null;
                });
                return;
            }
            let modal = document.getElementById('skolifInstallAppModal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'skolifInstallAppModal';
                modal.className = 'skolif-modal-overlay';
                modal.onclick = function (e) { if (e.target === modal) modal.classList.remove('visas'); };
                modal.innerHTML = `
                    <div class="skolif-modal-box" style="max-width: 480px;">
                        <div class="skolif-modal-header">
                            <div>
                                <h2>📲 Spara Skol-IF som app</h2>
                                <p>Öppna sidan i helskärm med egen Skol-IF-ikon på hemskärmen</p>
                            </div>
                            <button type="button" class="skolif-modal-close" onclick="document.getElementById('skolifInstallAppModal').classList.remove('visas')">✕</button>
                        </div>
                        <div class="skolif-modal-body" style="display:flex; flex-direction:column; gap:12px;">
                            <div style="display:flex; align-items:center; gap:14px; background:#F0FDF4; border:1px solid #BBF7D0; border-radius:12px; padding:12px 14px;">
                                <img src="icon.svg" alt="Skol-IF Ikon" style="width:52px; height:52px; border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.12); flex-shrink:0;">
                                <div style="font-size:0.83rem; color:#166534; line-height:1.45;">
                                    <strong>Skol-IF &amp; Idrott Hub</strong> fungerar som en riktig webbapp (PWA) med denna ikon på iPhone, iPad, Chromebook och dator.
                                </div>
                            </div>
                            <div style="background:#F8FAFC; border:1px solid #E2E8F0; border-radius:12px; padding:12px 14px;">
                                <div style="font-weight:800; font-size:0.86rem; color:#0F172A; margin-bottom:4px;">🍏 På iPhone &amp; iPad (Safari):</div>
                                <div style="font-size:0.82rem; color:#334155; line-height:1.5;">
                                    1. Tryck på <strong>Dela-knappen</strong> (fyrkant med pil uppåt ⬆️) i Safari.<br>
                                    2. Bläddra ner och välj <strong>”Lägg till på hemskärmen”</strong>.
                                </div>
                            </div>
                            <div style="background:#F8FAFC; border:1px solid #E2E8F0; border-radius:12px; padding:12px 14px;">
                                <div style="font-weight:800; font-size:0.86rem; color:#0F172A; margin-bottom:4px;">💻 På Dator &amp; Chromebook (Chrome / Edge):</div>
                                <div style="font-size:0.82rem; color:#334155; line-height:1.5;">
                                    1. Klicka på <strong>installations-ikonen (📲 / skärm med pil)</strong> längst till höger i adressfältet högst upp.<br>
                                    2. Eller öppna webbläsarmenyn (<strong>⋮</strong>) &rarr; <strong>”Cast, spara och dela”</strong> &rarr; <strong>”Installera sidan som app”</strong>.
                                </div>
                            </div>
                            <div style="background:#F8FAFC; border:1px solid #E2E8F0; border-radius:12px; padding:12px 14px;">
                                <div style="font-weight:800; font-size:0.86rem; color:#0F172A; margin-bottom:4px;">🤖 På Android:</div>
                                <div style="font-size:0.82rem; color:#334155; line-height:1.5;">
                                    Hämta vår riktiga Android-app direkt på <a href="https://play.google.com/store/apps/details?id=com.sellin.tabatatimer" target="_blank" style="color:#15803D; font-weight:700;">Google Play</a> eller välj <strong>”Lägg till på startskärmen”</strong> i Chrome-menyn.
                                </div>
                            </div>
                        </div>
                    </div>
                `;
                document.body.appendChild(modal);
            }
            modal.classList.add('visas');
        },
        onSelect: function (cb) {
            onClassSelectCallback = cb;
            renderAllClassBars();
            renderModalClassList();
        },
        triggerSelect: triggerSelect,
        refreshBars: renderAllClassBars
    };
})();
