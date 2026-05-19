import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './supabase-config.js';

// ---------- DOM ----------

const bestNewsPhoto = document.getElementById('best-news-photo');
const photoGrid = document.getElementById('citizen-photo-grid');
const articleList = document.getElementById('article-list');
const statusEl = document.getElementById('realtime-status');
const dateEl = document.getElementById('current-date');
const sessionEl = document.getElementById('session-status');

// ---------- Config ----------

const CITIZEN_CHANNEL = 'citizen-lens-photos';
const EVENT_NEW = 'new-photo';
const EVENT_VOTE = 'vote';
const EVENT_RESET = 'reset-photos';

const MAX_LIBRARY = 100;
const VISIBLE_SLOTS = 8;
const FLICKER_INTERVAL_MS = 2500;
const FLICKER_FADE_MS = 200;

// ---------- State ----------

const photoLibrary = [];      // [{id, dataUrl, votes, createdAt}]
let flickerTimerId = null;

const articlesById = new Map();
let currentSessionId = null;
let supabase = null;
let isSessionPinned = false;

// ---------- Small helpers ----------

function setStatus(text) {
    statusEl.textContent = text;
}

function setSessionStatus() {
    sessionEl.textContent = currentSessionId
        ? `SESSION: ${currentSessionId.slice(0, 8)}`
        : 'SESSION: --';
}

function formatDate() {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    dateEl.textContent = formatter.format(new Date());
}

function isConfigured() {
    return (
        SUPABASE_URL &&
        SUPABASE_ANON_KEY &&
        !SUPABASE_URL.includes('PASTE_') &&
        !SUPABASE_ANON_KEY.includes('PASTE_')
    );
}

function getSessionIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('session_id');
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function formatTime(value) {
    if (!value) return 'Filed moments ago';
    return `Filed ${new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ---------- Citizen Lens: library + BEST ----------

function addPhotoToLibrary(photo) {
    if (!photo || !photo.id || photoLibrary.some((p) => p.id === photo.id)) return;
    photoLibrary.push({
        id: photo.id,
        dataUrl: photo.dataUrl,
        votes: typeof photo.votes === 'number' ? photo.votes : 0,
        createdAt: photo.createdAt || new Date().toISOString(),
    });
    while (photoLibrary.length > MAX_LIBRARY) photoLibrary.shift();
}

function applyVote(photoId) {
    const photo = photoLibrary.find((p) => p.id === photoId);
    if (photo) photo.votes += 1;
}

function getBestPhoto() {
    if (photoLibrary.length === 0) return null;
    const sorted = [...photoLibrary].sort((a, b) => {
        if (b.votes !== a.votes) return b.votes - a.votes;
        return new Date(b.createdAt) - new Date(a.createdAt);
    });
    // Only treat a photo as BEST once it has at least one vote.
    if (sorted[0].votes === 0) return null;
    return sorted[0];
}

// ---------- Citizen Lens: BEST NEWS top half ----------

function renderBest() {
    const best = getBestPhoto();
    if (!best) {
        bestNewsPhoto.innerHTML = '<div class="empty-best">Awaiting votes</div>';
        return;
    }
    const existing = bestNewsPhoto.querySelector('img');
    if (!existing || existing.dataset.photoId !== best.id) {
        bestNewsPhoto.innerHTML =
            `<img src="${best.dataUrl}" alt="Best news photo" data-photo-id="${best.id}">`;
    }
}

// ---------- Citizen Lens: bottom 4x2 grid ----------

function getSlotEls() {
    return Array.from(photoGrid.querySelectorAll('.citizen-slot'));
}

function fillSlot(slot, photo) {
    slot.dataset.photoId = photo.id;
    slot.innerHTML = `<img src="${photo.dataUrl}" alt="Citizen Lens capture" data-photo-id="${photo.id}">`;
    slot.classList.add('filled');
}

function emptySlot(slot) {
    delete slot.dataset.photoId;
    slot.innerHTML = '';
    slot.classList.remove('filled');
}

// Phase 1: library has < VISIBLE_SLOTS photos. Fill slots sequentially with
// the most recent photos.
function renderInitialGrid() {
    const slots = getSlotEls();
    const recent = [...photoLibrary]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, slots.length);
    slots.forEach((slot, i) => {
        const photo = recent[i];
        if (!photo) {
            emptySlot(slot);
            return;
        }
        if (slot.dataset.photoId !== photo.id) {
            fillSlot(slot, photo);
        }
    });
}

// Phase 2: library is full enough for shuffling. Pick a random slot and
// swap its photo with a random library photo not currently visible.
function flickerTick() {
    if (photoLibrary.length < VISIBLE_SLOTS) return;
    const slots = getSlotEls();
    const slot = slots[Math.floor(Math.random() * slots.length)];

    const visibleIds = new Set(slots.map((s) => s.dataset.photoId).filter(Boolean));
    const candidates = photoLibrary.filter((p) => !visibleIds.has(p.id));
    if (candidates.length === 0) return;
    const newPhoto = candidates[Math.floor(Math.random() * candidates.length)];

    flickerInto(slot, newPhoto);
}

function flickerInto(slot, photo) {
    slot.classList.add('flickering');
    setTimeout(() => {
        fillSlot(slot, photo);
        // remove flicker class after animation duration
        setTimeout(() => slot.classList.remove('flickering'), 250);
    }, FLICKER_FADE_MS);
}

function ensureFlickerRunning() {
    if (flickerTimerId) return;
    flickerTimerId = setInterval(flickerTick, FLICKER_INTERVAL_MS);
}

function stopFlicker() {
    if (flickerTimerId) {
        clearInterval(flickerTimerId);
        flickerTimerId = null;
    }
}

// ---------- Citizen Lens: event handlers ----------

function handleNewPhoto(payload) {
    addPhotoToLibrary(payload);
    renderBest();

    if (photoLibrary.length < VISIBLE_SLOTS) {
        // Phase 1: still seating photos in order.
        renderInitialGrid();
    } else if (photoLibrary.length === VISIBLE_SLOTS) {
        // We just crossed the threshold; place the 8th photo, then
        // start the flicker shuffler.
        renderInitialGrid();
        ensureFlickerRunning();
    } else {
        // Phase 2: flicker the new photo into a random visible slot so
        // users get immediate feedback that a fresh capture arrived.
        const slots = getSlotEls();
        const slot = slots[Math.floor(Math.random() * slots.length)];
        flickerInto(slot, photoLibrary[photoLibrary.length - 1]);
    }
}

function handleVote(photoId) {
    applyVote(photoId);
    renderBest();
}

function handleReset() {
    photoLibrary.length = 0;
    stopFlicker();
    renderBest();
    getSlotEls().forEach(emptySlot);
}

function subscribeToCitizenLens() {
    if (!supabase) return;
    supabase
        .channel(CITIZEN_CHANNEL, { config: { broadcast: { self: false } } })
        .on('broadcast', { event: EVENT_NEW }, (msg) => {
            handleNewPhoto(msg.payload);
            setStatus('CITIZEN LENS LIVE');
        })
        .on('broadcast', { event: EVENT_VOTE }, (msg) => {
            handleVote(msg.payload?.id);
        })
        .on('broadcast', { event: EVENT_RESET }, () => {
            handleReset();
            setStatus('CITIZEN LENS CLEARED');
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('[citizen-lens] subscribed.');
            }
        });
}

// ---------- Everyone Edits side list (unchanged behaviour) ----------

function renderArticles() {
    const articles = Array.from(articlesById.values())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const sideArticles = articles.slice(0, 5);
    if (sideArticles.length === 0) {
        articleList.innerHTML = `
            <article class="sub-article">
                <h4>Newsroom awaiting interviews</h4>
                <p>Completed interviews will appear here as soon as they are filed.</p>
            </article>
        `;
        return;
    }

    articleList.innerHTML = sideArticles.map((article) => `
        <article class="sub-article">
            <h4>${escapeHtml(article.title)}</h4>
            <p class="author">${formatTime(article.created_at)}</p>
            <p>${escapeHtml(article.subtitle || article.body || '')}</p>
        </article>
    `).join('');
}

function addArticle(article) {
    if (!article || !article.id) return;
    articlesById.set(article.id, article);
    renderArticles();
}

async function loadCurrentSession() {
    const urlSessionId = getSessionIdFromUrl();
    if (urlSessionId) {
        currentSessionId = urlSessionId;
        isSessionPinned = true;
        return;
    }

    const { data, error } = await supabase
        .from('sessions')
        .select('id')
        .eq('status', 'active')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        throw new Error(`Could not load active session: ${error.message}`);
    }

    currentSessionId = data?.id || null;
    setSessionStatus();
}

async function loadExistingArticles() {
    if (!currentSessionId) {
        renderArticles();
        setStatus('WAITING FOR ACTIVE SESSION');
        return;
    }

    const { data, error } = await supabase
        .from('frontpage_articles')
        .select('*')
        .eq('session_id', currentSessionId)
        .order('created_at', { ascending: false });

    if (error) {
        throw new Error(`Could not load front page: ${error.message}`);
    }

    articlesById.clear();
    data.forEach(addArticle);
    renderArticles();
}

function subscribeToArticles() {
    const changes = {
        event: 'INSERT',
        schema: 'public',
        table: 'frontpage_articles',
    };

    if (isSessionPinned && currentSessionId) {
        changes.filter = `session_id=eq.${currentSessionId}`;
    }

    supabase
        .channel(isSessionPinned ? `frontpage-articles:${currentSessionId}` : 'frontpage-articles:latest')
        .on('postgres_changes', changes, (payload) => {
            if (isSessionPinned && payload.new.session_id !== currentSessionId) return;
            if (!isSessionPinned && payload.new.session_id !== currentSessionId) {
                currentSessionId = payload.new.session_id;
                articlesById.clear();
                setSessionStatus();
            }
            addArticle(payload.new);
            setStatus('LIVE FROM THE VR NEWSROOM');
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                setStatus('LIVE FROM THE VR NEWSROOM');
            }
        });
}

// ---------- Init ----------

async function init() {
    formatDate();
    renderBest();
    renderInitialGrid();

    if (!isConfigured()) {
        setStatus('SUPABASE CONFIG NEEDED');
        renderArticles();
        return;
    }

    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        await loadCurrentSession();
        setSessionStatus();
        await loadExistingArticles();
        subscribeToArticles();
        subscribeToCitizenLens();
    } catch (error) {
        console.error(error);
        setStatus('NEWSROOM CONNECTION ERROR');
        // Citizen Lens broadcasts are independent of sessions/articles, so
        // keep the photo wall alive even if the article side failed.
        if (supabase) subscribeToCitizenLens();
    }
}

init();