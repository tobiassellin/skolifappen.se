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
                            <h3><span>📋</span> Mina Klasser & Elever (Gemensam vy)</h3>
                            <button type="button" class="skolif-modal-close" onclick="SkolIFKlasser.closeModal()">✕</button>
                        </div>
                        <div class="skolif-modal-body" style="gap: 14px; padding: 16px 20px;">
                            <!-- Inloggningsstatus -->
                            <div id="skolifModalAuthBanner" class="skolif-auth-banner logged-out"></div>

                            <!-- Flikar -->
                            <div class="skolif-tab-row">
                                <button type="button" id="skolifTabBtn-klasser" class="skolif-tab-btn active" onclick="SkolIFKlasser.switchTab('klasser')">📂 Klasser & Elever</button>
                                <button type="button" id="skolifTabBtn-massimport" class="skolif-tab-btn" onclick="SkolIFKlasser.switchTab('massimport')">⚡ Massimport</button>
                                <button type="button" id="skolifTabBtn-verktyg" class="skolif-tab-btn" onclick="SkolIFKlasser.switchTab('verktyg')">🎓 Läsårsbyte & Verktyg</button>
                            </div>

                            <!-- FLIK 1: KLASSER & ELEVER -->
                            <div id="skolifTabContent-klasser" style="display: flex; flex-direction: column; gap: 14px;">
                                <!-- Snabblägg till enskild elev -->
                                <div style="background: #F0FDF4; border: 1.5px solid #BBF7D0; border-radius: 12px; padding: 12px 14px;">
                                    <div style="font-weight: 800; font-size: 0.85rem; color: #166534; margin-bottom: 6px;">➕ Snabblägg till enskild elev</div>
                                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                        <input type="text" id="skolifSingleStudentName" placeholder="Elevens namn (t.ex. Anna Andersson)" style="flex: 2; min-width: 160px; padding: 7px 10px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.85rem; font-family: inherit;" onkeydown="if(event.key==='Enter') SkolIFKlasser.addSingleFromModal()">
                                        <input type="text" id="skolifSingleStudentClass" placeholder="Klass (t.ex. 8B)" style="flex: 1; min-width: 85px; max-width: 120px; padding: 7px 10px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.85rem; font-family: inherit; text-transform: uppercase; font-weight: 700;" onkeydown="if(event.key==='Enter') SkolIFKlasser.addSingleFromModal()">
                                        <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.addSingleFromModal()" style="padding: 7px 14px;">Lägg till</button>
                                    </div>
                                </div>

                                <!-- Sparade klasser lista -->
                                <div>
                                    <div style="font-size: 0.8rem; font-weight: 800; color: #334155; margin-bottom: 6px; text-transform: uppercase;">
                                        Dina klasser (Klicka på ✏️ för att ändra elever eller höja t.ex. 8B ➔ 9B)
                                    </div>
                                    <div id="skolifModalClassList" style="display: flex; flex-direction: column; gap: 6px; max-height: 175px; overflow-y: auto;"></div>
                                </div>

                                <!-- Skapa / Redigera klass -->
                                <div style="background: #F8FAFC; border: 1.5px solid #E2E8F0; border-radius: 12px; padding: 14px;">
                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                        <div style="font-weight: 800; font-size: 0.9rem; color: #1E3A24;" id="skolifFormTitle">➕ Skapa eller redigera hel klass</div>
                                        <span id="skolifModalCountBadge" style="font-size: 0.75rem; font-weight: 700; color: #2E7D32; background: #E8F5E9; padding: 2px 10px; border-radius: 12px;">0 elever</span>
                                    </div>
                                    <div style="margin-bottom: 8px;">
                                        <input type="text" id="skolifModalClassName" placeholder="Klassbeteckning (t.ex. 8B – ändra till 9B om du vill höja klassen!)" style="width: 100%; padding: 8px 11px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.86rem; font-family: inherit; font-weight: 700; text-transform: uppercase;">
                                    </div>
                                    <div>
                                        <textarea id="skolifModalClassStudents" rows="4" placeholder="Skriv eller klistra in elever i klassen (ett namn per rad)..." oninput="SkolIFKlasser.updateModalCount()" style="width: 100%; padding: 8px 11px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.84rem; font-family: inherit; resize: vertical;"></textarea>
                                    </div>
                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 8px; flex-wrap: wrap;">
                                        <span style="font-size: 0.72rem; color: #64748B;">☁️ Alla ändringar gäller på hela sajten & i Kiosken (saldon bevaras alltid!)</span>
                                        <div style="display: flex; gap: 8px;">
                                            <button type="button" class="skolif-btn-sm" onclick="SkolIFKlasser.clearModalForm()">Rensa / Avbryt</button>
                                            <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.saveFromModal()">💾 Spara klass</button>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- FLIK 2: MASSIMPORT -->
                            <div id="skolifTabContent-massimport" style="display: none; flex-direction: column; gap: 12px;">
                                <div style="background: #F8FAFC; border: 1.5px solid #E2E8F0; border-radius: 12px; padding: 16px;">
                                    <div style="font-weight: 800; font-size: 0.95rem; color: #1E3A24; margin-bottom: 6px;">⚡ Massimportera elever (flera klasser samtidigt)</div>
                                    <p style="font-size: 0.82rem; color: #475569; margin-bottom: 10px; line-height: 1.4;">
                                        Klistra in en lista där både elevens namn och klass står på varje rad (t.ex. <strong>Tobias Sellin 9B</strong> eller <strong>Anna Andersson 7A</strong>). Programmet känner automatiskt av vilken del som är klassen och sorterar in eleverna rätt!
                                    </p>
                                    <textarea id="skolifMassImportText" rows="7" placeholder="Exempel:\nTobias Sellin 9B\nAnna Andersson 7A\nErik Eriksson 8C" style="width: 100%; padding: 10px 12px; border: 1.5px solid #CBD5E1; border-radius: 10px; font-size: 0.86rem; font-family: inherit; resize: vertical; margin-bottom: 10px;"></textarea>
                                    <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.massImportFromModal()" style="width: 100%; padding: 10px; font-size: 0.9rem;">🚀 Kör massimport</button>
                                </div>
                            </div>

                            <!-- FLIK 3: LÄSÅRSBYTE & VERKTYG -->
                            <div id="skolifTabContent-verktyg" style="display: none; flex-direction: column; gap: 12px;">
                                <!-- 1. Läsårsbyte (+1 årskurs för alla klasser) -->
                                <div style="background: #E8F5E9; border: 1.5px solid #C8E6C9; border-radius: 12px; padding: 14px 16px;">
                                    <div style="font-weight: 800; font-size: 0.92rem; color: #2E7D32; margin-bottom: 4px;">🎓 Läsårsbyte – Höj alla klasser (+1 årskurs)</div>
                                    <p style="font-size: 0.8rem; color: #334155; margin-bottom: 10px; line-height: 1.4;">
                                        Stegar automatiskt upp alla klassbeteckningar ett årskurs-steg (t.ex. <strong>7A ➔ 8A</strong>, <strong>8B ➔ 9B</strong>, <strong>9C ➔ 10C</strong>). Alla elevers saldon i Kiosken följer med!
                                    </p>
                                    <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.upgradeAllYear()" style="width: 100%; padding: 9px; font-size: 0.88rem;">🚀 Flytta upp alla klasser 1 årskurs</button>
                                </div>

                                <!-- 2. Byt klassnamn på en enskild klass (t.ex. 8B -> 9B) -->
                                <div style="background: #F8FAFC; border: 1.5px solid #E2E8F0; border-radius: 12px; padding: 14px 16px;">
                                    <div style="font-weight: 800; font-size: 0.9rem; color: #1E3A24; margin-bottom: 4px;">🔄 Höj eller byt namn på en enskild klass (t.ex. 8B ➔ 9B)</div>
                                    <p style="font-size: 0.78rem; color: #64748B; margin-bottom: 8px;">Välj en klass och ange det nya klassnamnet så flyttas alla elever i klassen över (med bevarade saldon).</p>
                                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                        <select id="skolifRenameFromSelect" style="flex: 1; min-width: 140px; padding: 7px 10px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.85rem; font-family: inherit; background: white;"></select>
                                        <input type="text" id="skolifRenameToInput" placeholder="Nytt namn (t.ex. 9B)" style="flex: 1; min-width: 130px; padding: 7px 10px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.85rem; font-family: inherit; text-transform: uppercase; font-weight: 700;">
                                        <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.renameFromTool()">Byt klassnamn</button>
                                    </div>
                                </div>

                                <!-- 3. Radera en hel klass -->
                                <div style="background: #FFF5F5; border: 1.5px solid #FECACA; border-radius: 12px; padding: 14px 16px;">
                                    <div style="font-weight: 800; font-size: 0.9rem; color: #C62828; margin-bottom: 4px;">🗑️ Radera en hel klass (t.ex. avgångsklasser)</div>
                                    <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px;">
                                        <select id="skolifDeleteClassSelect" style="flex: 2; min-width: 160px; padding: 7px 10px; border: 1.5px solid #CBD5E1; border-radius: 8px; font-size: 0.85rem; font-family: inherit; background: white;"></select>
                                        <button type="button" class="skolif-btn-sm danger" onclick="SkolIFKlasser.deleteFromTool()" style="background: #C62828; color: white; border-color: #C62828;">Radera klass</button>
                                    </div>
                                </div>

                                <!-- 4. Exportera elevlista till Excel / CSV -->
                                <div style="background: #F0F9FF; border: 1.5px solid #BAE6FD; border-radius: 12px; padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
                                    <div>
                                        <div style="font-weight: 800; font-size: 0.9rem; color: #0369A1;">📄 Exportera elevregister till Excel / CSV</div>
                                        <div style="font-size: 0.78rem; color: #475569;">Ladda ner alla elever, klasser och aktuella saldon i Kiosken.</div>
                                    </div>
                                    <button type="button" class="skolif-btn-sm" onclick="SkolIFKlasser.exportCSV()" style="background: #0284C7; color: white; border-color: #0284C7;">📥 Ladda ner Excel/CSV</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            const wrapper = document.createElement('div');
            wrapper.innerHTML = modalHtml;
            document.body.appendChild(wrapper.firstElementChild);
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
                banner.className = 'skolif-auth-banner';
                banner.innerHTML = `
                    <div>
                        <strong>☁️ Synkad med Google (${escapeHtml(currentUser.email)})</strong><br>
                        <span style="font-size: 0.78rem;">Alla klasser och elever hämtas och synkas direkt med din databas och Kiosken.</span>
                    </div>
                    <button type="button" class="skolif-btn-sm" onclick="SkolIFKlasser.logout()">Logga ut</button>
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
                        <span style="font-size: 1rem;">📁</span>
                        <span class="skolif-class-item-name" style="font-size: 0.9rem;">${escapeHtml(label)}</span>
                        <span class="skolif-class-item-badge">${count} elever</span>
                    </div>
                    <div style="display: flex; gap: 6px;">
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

    function switchTab(tabName) {
        ['klasser', 'massimport', 'verktyg'].forEach(t => {
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
    }

    function openModal(prefillName, prefillText, initialTab) {
        injectStylesAndModal();
        updateAuthUI();
        renderModalClassList();
        switchTab(initialTab || 'klasser');

        if (prefillName || prefillText) {
            const nameInput = document.getElementById('skolifModalClassName');
            const textInput = document.getElementById('skolifModalClassStudents');
            if (nameInput && prefillName) nameInput.value = normalizeKlassCode(prefillName);
            if (textInput && prefillText) textInput.value = prefillText;
            updateModalCount();
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
        const nameInput = document.getElementById('skolifModalClassName');
        const textInput = document.getElementById('skolifModalClassStudents');
        const titleEl = document.getElementById('skolifFormTitle');
        if (nameInput) nameInput.value = code;
        if (textInput) textInput.value = klasser[code];
        if (titleEl) titleEl.textContent = `✏️ Redigerar ${formatDisplayKlass(code)} (du kan även ändra klassnamn nedan)`;
        updateModalCount();
        if (textInput) textInput.focus();
    }

    function clearModalForm() {
        editingOriginalKlassCode = null;
        const nameInput = document.getElementById('skolifModalClassName');
        const textInput = document.getElementById('skolifModalClassStudents');
        const titleEl = document.getElementById('skolifFormTitle');
        if (nameInput) nameInput.value = '';
        if (textInput) textInput.value = '';
        if (titleEl) titleEl.textContent = '➕ Skapa eller redigera hel klass';
        updateModalCount();
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

    window.addEventListener('DOMContentLoaded', () => {
        injectStylesAndModal();
        updateAuthUI();
        renderAllClassBars();
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
        onSelect: function (cb) {
            onClassSelectCallback = cb;
            renderAllClassBars();
            renderModalClassList();
        },
        triggerSelect: triggerSelect,
        refreshBars: renderAllClassBars
    };
})();
