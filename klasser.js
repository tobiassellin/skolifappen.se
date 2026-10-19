// ============================================================================
//  SKOL-IF WEBBEN: GEMENSAM INLOGGNING, MINA KLASSER & SNYGGA NOTISER (klasser.js)
//  - Synkar klasser och elever direkt med Skol-IF Kassa (skolif_kassa -> elever)
//  - Ersätter fula svarta webbläsar-alerts med snygga, moderna notisrutor (Toasts)
// ============================================================================

(function () {
    const STORAGE_KEY = 'skolif_sparade_klasser';

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
    //  SYNK MOT SKOL-IF KASSA (FIRESTORE)
    // ==========================================
    async function resolveKassaDocId(user) {
        if (!user || !db) return null;
        const userEmail = (user.email || '').trim().toLowerCase();
        if (!userEmail) return user.uid;

        try {
            const egenRef = db.collection('skolif_kassa').doc(userEmail);
            const egenSnap = await egenRef.get();
            if (egenSnap.exists) return userEmail;

            if (user.uid) {
                try {
                    const gammalSnap = await db.collection('skolif_kassa').doc(user.uid).get();
                    if (gammalSnap.exists) return user.uid;
                } catch (e) {}
            }

            const q = db.collection('skolif_kassa').where('behoriga_anvandare', 'array-contains', userEmail);
            const deladeSnap = await q.get();
            if (!deladeSnap.empty) {
                return deladeSnap.docs[0].id;
            }

            return userEmail;
        } catch (err) {
            console.warn('Kunde inte slå upp kassa-dokument, använder e-post:', err.message);
            return userEmail;
        }
    }

    async function startKassaSync(user) {
        if (kassaUnsubscribe) {
            kassaUnsubscribe();
            kassaUnsubscribe = null;
        }
        if (!user || !db) return;

        const docId = await resolveKassaDocId(user);
        if (!docId) return;
        activeKassaDocId = docId;

        kassaUnsubscribe = db.collection('skolif_kassa').doc(docId).onSnapshot((docSnap) => {
            if (docSnap.exists) {
                const data = docSnap.data() || {};
                try {
                    kassaEleverCache = JSON.parse(data.elever || '[]');
                    if (!Array.isArray(kassaEleverCache)) kassaEleverCache = [];
                } catch (e) {
                    kassaEleverCache = [];
                }

                const kassaKlasser = buildClassesMapFromKassaElever(kassaEleverCache);
                setClassesLocal(kassaKlasser);
                notifyAllListeners();
            } else {
                kassaEleverCache = [];
                notifyAllListeners();
            }
        }, (err) => {
            console.error('Fel vid lyssning på skolif_kassa i klasser.js:', err);
        });
    }

    // Uppdatera en klass i skolif_kassa utan att någonsin röra befintliga elevers saldon!
    async function saveClass(rawKlassNamn, elevText, allowRemoveStudents = false) {
        const klassCode = normalizeKlassCode(rawKlassNamn);
        const nyaNamnLista = parseStudentNames(elevText);
        if (!klassCode || nyaNamnLista.length === 0) return false;

        // Kolla vilka som redan fanns lokalt/i kassan för att ge en personlig bekräftelse
        const lokalaFore = getClassesLocal();
        const fannsKlassenTidigare = Boolean(lokalaFore[klassCode]);
        const gamlaNamnLower = new Set(
            parseStudentNames(lokalaFore[klassCode] || '').map(n => n.toLowerCase())
        );
        const nytillagdaNamn = nyaNamnLista.filter(n => !gamlaNamnLower.has(n.toLowerCase()));

        // 1. Uppdatera lokal cache direkt
        lokalaFore[klassCode] = nyaNamnLista.join('\n');
        setClassesLocal(lokalaFore);
        notifyAllListeners();

        // 2. Om inloggad: synka med skolif_kassa i Firestore
        if (currentUser && db && activeKassaDocId) {
            try {
                const docRef = db.collection('skolif_kassa').doc(activeKassaDocId);
                const docSnap = await docRef.get();
                let nuvarandeElever = [];
                if (docSnap.exists) {
                    try {
                        nuvarandeElever = JSON.parse(docSnap.data().elever || '[]');
                    } catch (e) {
                        nuvarandeElever = [];
                    }
                }

                let maxId = nuvarandeElever.length > 0
                    ? Math.max(0, ...nuvarandeElever.map(e => Number(e.id) || 0))
                    : 0;

                const eleverIAndraKlasser = nuvarandeElever.filter(
                    e => normalizeKlassCode(e.klass) !== klassCode
                );
                const gamlaEleverIKlassen = nuvarandeElever.filter(
                    e => normalizeKlassCode(e.klass) === klassCode
                );

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
                            uppdateradeIKlassen.push(gammal);
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
                            borttagnaMedSaldo.forEach(e => uppdateradeIKlassen.push(e));
                        }
                    }
                }

                const nyKomplettLista = [...eleverIAndraKlasser, ...uppdateradeIKlassen];

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
                console.error('Kunde inte spara klass till skolif_kassa:', err);
            }
        }

        // Visa snygg och personlig bekräftelse-toast!
        if (nytillagdaNamn.length === 1 && fannsKlassenTidigare) {
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

        const eleverIKlass = kassaEleverCache.filter(e => normalizeKlassCode(e.klass) === klassCode);
        const totaltSaldo = eleverIKlass.reduce((sum, e) => sum + (Number(e.saldo) || 0), 0);
        const harSaldo = eleverIKlass.some(e => (Number(e.saldo) || 0) !== 0);

        let msg = `Är du säker på att du vill radera Klass ${klassCode} (${eleverIKlass.length || ''} elever)?\nKlassen tas bort från både Mina Klasser och Kiosken.`;
        if (harSaldo) {
            msg += `\n\n⚠️ OBSERVERA! Det finns kvarstående saldon i klassen på totalt ${totaltSaldo} kr!`;
        }
        if (!confirm(msg)) return;

        const lokala = getClassesLocal();
        delete lokala[klassCode];
        setClassesLocal(lokala);
        notifyAllListeners();

        if (currentUser && db && activeKassaDocId) {
            try {
                const docRef = db.collection('skolif_kassa').doc(activeKassaDocId);
                const kvarvarande = kassaEleverCache.filter(e => normalizeKlassCode(e.klass) !== klassCode);
                await docRef.update({
                    elever: JSON.stringify(kvarvarande),
                    senastUppdaterad: Date.now()
                });
            } catch (err) {
                console.error('Kunde inte radera klass i skolif_kassa:', err);
            }
        }

        showToast(`🗑️ Klass ${klassCode} har raderats`, 'info');
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
        kassaEleverCache = [];
        auth.signOut().then(() => {
            showToast('Du har loggats ut', 'info');
        });
    }

    if (auth) {
        auth.onAuthStateChanged((user) => {
            currentUser = user || null;
            if (user) {
                startKassaSync(user);
            } else {
                if (kassaUnsubscribe) {
                    kassaUnsubscribe();
                    kassaUnsubscribe = null;
                }
                activeKassaDocId = null;
                kassaEleverCache = [];
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
                            <h3><span>📋</span> Mina Klasser & Elever (Synkad med Kiosken)</h3>
                            <button type="button" class="skolif-modal-close" onclick="SkolIFKlasser.closeModal()">✕</button>
                        </div>
                        <div class="skolif-modal-body">
                            <!-- Inloggningsstatus -->
                            <div id="skolifModalAuthBanner" class="skolif-auth-banner logged-out"></div>

                            <!-- Sparade klasser lista -->
                            <div>
                                <div style="font-size: 0.85rem; font-weight: 800; color: #334155; margin-bottom: 8px; text-transform: uppercase;">
                                    Dina klasser i databasen
                                </div>
                                <div id="skolifModalClassList" style="display: flex; flex-direction: column; gap: 8px; max-height: 220px; overflow-y: auto;"></div>
                            </div>

                            <!-- Skapa / Redigera klass -->
                            <div style="background: #F8FAFC; border: 1.5px solid #E2E8F0; border-radius: 14px; padding: 16px;">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                    <div style="font-weight: 800; font-size: 0.95rem; color: #1E3A24;" id="skolifFormTitle">➕ Lägg till / Redigera klass</div>
                                    <span id="skolifModalCountBadge" style="font-size: 0.78rem; font-weight: 700; color: #2E7D32; background: #E8F5E9; padding: 2px 10px; border-radius: 12px;">0 elever</span>
                                </div>
                                <div style="margin-bottom: 10px;">
                                    <input type="text" id="skolifModalClassName" placeholder="Klassbeteckning (t.ex. 8B, 7A, 9C...)" style="width: 100%; padding: 9px 12px; border: 2px solid #CBD5E1; border-radius: 10px; font-size: 0.9rem; font-family: inherit; font-weight: 700;">
                                </div>
                                <div>
                                    <textarea id="skolifModalClassStudents" rows="5" placeholder="Skriv eller klistra in elever (ett namn per rad)..." oninput="SkolIFKlasser.updateModalCount()" style="width: 100%; padding: 10px 12px; border: 2px solid #CBD5E1; border-radius: 10px; font-size: 0.88rem; font-family: inherit; resize: vertical;"></textarea>
                                </div>
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px; gap: 8px; flex-wrap: wrap;">
                                    <span style="font-size: 0.75rem; color: #64748B;">☁️ Synkas automatiskt mellan Kiosken, Lagdelaren, Beep-test, Löprundan & Hjulet (saldon i Kiosken bevaras alltid!)</span>
                                    <div style="display: flex; gap: 8px;">
                                        <button type="button" class="skolif-btn-sm" onclick="SkolIFKlasser.clearModalForm()">Rensa fält</button>
                                        <button type="button" class="skolif-btn-sm primary" onclick="SkolIFKlasser.saveFromModal()">💾 Spara klass</button>
                                    </div>
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
                        <strong>💻 Du är inte inloggad</strong><br>
                        <span style="font-size: 0.78rem;">Logga in med Google för att hämta dina klasser från Kiosken/molnet!</span>
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
                : `<span class="skolif-cloud-dot offline" onclick="SkolIFKlasser.login()" title="Klicka för att logga in med Google och hämta dina klasser">🔑 Logga in för att hämta dina klasser</span>`;

            let pillsHtml = '';
            if (codes.length === 0) {
                pillsHtml = `<span style="font-size: 0.8rem; color: #94A3B8; font-style: italic;">${currentUser ? 'Inga klasser inlagda än. Klicka på "+ Hantera klasser" för att lägga in en klass!' : 'Logga in eller klicka på "+ Hantera klasser" för att välja klass.'}</span>`;
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
        if (!listEl) return;

        const klasser = getClassesLocal();
        const codes = Object.keys(klasser).sort((a, b) => a.localeCompare(b, 'sv'));

        if (codes.length === 0) {
            listEl.innerHTML = `
                <div style="text-align: center; padding: 18px; color: #64748B; font-size: 0.85rem; background: #F8FAFC; border-radius: 10px; border: 1px dashed #CBD5E1;">
                    ${currentUser ? 'Inga klasser hittades. Lägg till din första klass nedan!' : 'Logga in med Google ovan för att se dina befintliga klasser från Kiosken!'}
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
                <div class="skolif-class-item">
                    <div class="skolif-class-item-info">
                        <span style="font-size: 1.1rem;">📁</span>
                        <span class="skolif-class-item-name">${escapeHtml(label)}</span>
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
    function openModal(prefillName, prefillText) {
        injectStylesAndModal();
        updateAuthUI();
        renderModalClassList();

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
        const nameInput = document.getElementById('skolifModalClassName');
        const textInput = document.getElementById('skolifModalClassStudents');
        const titleEl = document.getElementById('skolifFormTitle');
        if (nameInput) nameInput.value = '';
        if (textInput) textInput.value = '';
        if (titleEl) titleEl.textContent = '➕ Lägg till / Redigera klass';
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
        if (!text) {
            showToast('Skriv eller klistra in minst en elev i listan!', 'warning');
            if (textInput) textInput.focus();
            return;
        }

        await saveClass(name, text, true);
        clearModalForm();
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
        saveClass: saveClass,
        deleteClass: deleteClass,
        openModal: openModal,
        closeModal: closeModal,
        editInModal: editInModal,
        clearModalForm: clearModalForm,
        saveFromModal: saveFromModal,
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
