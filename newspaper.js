// Newspaper / Display client.
//
// Three independent data channels:
//   1. Citizen Lens photos -> Socket.IO to our own server.js (same origin).
//   2. Everyone Edits articles -> Supabase Realtime on `frontpage_articles`,
//      populated by the Typewriter project's publisher.
//   3. Today's Legendary Visitors -> Supabase Realtime on `interviews`,
//      populated by the Unity InteractionReporter when a story ends.
//      The npc_id column matches a `data-subject-id` on a .legend-card and
//      causes that card to flip from locked -> unlocked.
//
// The photo channel maintains a local mirror of the server's photoLibrary
// (cap 100). Top half = BEST NEWS (the photo with the highest vote count,
// >= 1 vote). Bottom half = 4x2 grid that fills sequentially until 8 photos
// have arrived, then switches to a flicker loop that randomly reshuffles
// visible photos from the library every 2.5s.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { io } from 'https://cdn.socket.io/4.7.5/socket.io.esm.min.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './supabase-config.js';

// ---------- DOM ----------

const bestNewsPhoto = document.getElementById('best-news-photo');
const photoGrid = document.getElementById('citizen-photo-grid');
const articleList = document.getElementById('article-list');
const legendsGrid = document.getElementById('legends-grid');
const statusEl = document.getElementById('realtime-status');
const dateEl = document.getElementById('current-date');
const sessionEl = document.getElementById('session-status');

// ---------- Config ----------

const MAX_LIBRARY = 100;
const VISIBLE_SLOTS = 8;
const FLICKER_INTERVAL_MS = 2500;
const FLICKER_FADE_MS = 200;

// ---------- State ----------

const photoLibrary = []; // [{id, dataUrl, votes, createdAt}]
let flickerTimerId = null;

const articlesById = new Map();
const unlockedSubjectIds = new Set();
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

function isSupabaseConfigured() {
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

function applyVote(photoId, votes) {
    const photo = photoLibrary.find((p) => p.id === photoId);
    if (!photo) return;
    photo.votes = typeof votes === 'number' ? votes : photo.votes + 1;
}

function getBestPhoto() {
    if (photoLibrary.length === 0) return null;
    const sorted = [...photoLibrary].sort((a, b) => {
        if (b.votes !== a.votes) return b.votes - a.votes;
        return new Date(b.createdAt) - new Date(a.createdAt);
    });
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
    slot.innerHTML =
        `<img src="${photo.dataUrl}" alt="Citizen Lens capture" data-photo-id="${photo.id}">`;
    slot.classList.add('filled');
}

function emptySlot(slot) {
    delete slot.dataset.photoId;
    slot.innerHTML = '';
    slot.classList.remove('filled');
}

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

// ---------- Citizen Lens: Socket.IO events ----------

const socket = io();

socket.on('connect', () => {
    console.log('[citizen-lens] socket connected:', socket.id);
    setStatus('CITIZEN LENS LIVE');
});

socket.on('disconnect', (reason) => {
    console.log('[citizen-lens] socket disconnected:', reason);
    setStatus('CITIZEN LENS OFFLINE');
});

socket.on('connect_error', (err) => {
    console.error('[citizen-lens] socket connect_error:', err.message);
    setStatus('CITIZEN LENS OFFLINE');
});

// Full snapshot (on connect and after server-side resets).
socket.on('photo:state', ({ library }) => {
    photoLibrary.length = 0;
    if (Array.isArray(library)) library.forEach(addPhotoToLibrary);

    renderBest();
    renderInitialGrid();
    if (photoLibrary.length >= VISIBLE_SLOTS) {
        ensureFlickerRunning();
    } else {
        stopFlicker();
    }
});

// One new photo from a capture client.
socket.on('photo:added', (photo) => {
    if (!photo || !photo.id) return;
    if (photoLibrary.some((p) => p.id === photo.id)) return;

    addPhotoToLibrary(photo);
    renderBest();

    if (photoLibrary.length < VISIBLE_SLOTS) {
        renderInitialGrid();
    } else if (photoLibrary.length === VISIBLE_SLOTS) {
        renderInitialGrid();
        ensureFlickerRunning();
    } else {
        // Already in flicker mode: surface the new photo immediately by
        // flickering it into a random slot.
        const slots = getSlotEls();
        const slot = slots[Math.floor(Math.random() * slots.length)];
        flickerInto(slot, photoLibrary[photoLibrary.length - 1]);
    }
});

// Vote count update from a capture client.
socket.on('photo:voted', ({ id, votes }) => {
    applyVote(id, votes);
    renderBest();
});

// ---------- Everyone Edits side list (Supabase) ----------

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

    if (error) throw new Error(`Could not load active session: ${error.message}`);

    currentSessionId = data?.id || null;
    setSessionStatus();
}

async function loadExistingArticles() {
    if (!currentSessionId) {
        renderArticles();
        return;
    }

    const { data, error } = await supabase
        .from('frontpage_articles')
        .select('*')
        .eq('session_id', currentSessionId)
        .order('created_at', { ascending: false });

    if (error) throw new Error(`Could not load front page: ${error.message}`);

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
        })
        .subscribe();
}

// ---------- Today's Legendary Visitors: unlock from interviews ----------
//
// Each .legend-card carries:
//   data-subject-id  - must match Unity StorySubject.subjectId (== interviews.npc_id)
//   data-name        - real name to reveal
//   data-title       - subtitle (profession / era)
//   data-intro       - short bio paragraph
//   data-photo       - portrait image path (optional)
//
// On page load we query interviews for the current session and unlock any cards
// whose npc_id has already been recorded. After that we subscribe to inserts on
// the interviews table and unlock matching cards live.

function findLegendCard(subjectId) {
    if (!subjectId || !legendsGrid) return null;
    // Escape the attribute value defensively in case ids ever contain quotes.
    const safe = String(subjectId).replace(/["\\]/g, '\\$&');
    return legendsGrid.querySelector(`.legend-card[data-subject-id="${safe}"]`);
}

function unlockLegend(subjectId) {
    if (!subjectId) return;
    if (unlockedSubjectIds.has(subjectId)) return;

    const card = findLegendCard(subjectId);
    if (!card) {
        // No matching card on this page: cache the id anyway so we don't
        // keep retrying on every realtime echo.
        unlockedSubjectIds.add(subjectId);
        console.warn(`[legends] No card found for subject_id="${subjectId}"`);
        return;
    }

    unlockedSubjectIds.add(subjectId);

    const name  = card.dataset.name  || '';
    const title = card.dataset.title || '';
    const intro = card.dataset.intro || '';
    const photo = card.dataset.photo || '';

    const nameEl  = card.querySelector('.legend-name');
    const titleEl = card.querySelector('.legend-title');
    const introEl = card.querySelector('.legend-intro');
    const photoEl = card.querySelector('.legend-photo');

    if (nameEl  && name)  nameEl.innerHTML  = name;   // innerHTML so &middot; etc. render
    if (titleEl && title) titleEl.innerHTML = title;
    if (introEl && intro) introEl.textContent = intro;

    if (photoEl) {
        if (photo) {
            photoEl.innerHTML =
                `<img src="${escapeHtml(photo)}" alt="${escapeHtml(name)}">`;
        } else {
            photoEl.innerHTML =
                `<div class="legend-photo-placeholder">No portrait on file</div>`;
        }
    }

    // Brief flicker so newly unlocked cards visually announce themselves,
    // then switch the persistent state class.
    card.classList.add('flickering');
    setTimeout(() => {
        card.classList.remove('locked', 'flickering');
        card.classList.add('unlocked');
    }, 450);
}

async function loadUnlockedLegends() {
    if (!supabase || !currentSessionId) return;

    const { data, error } = await supabase
        .from('interviews')
        .select('npc_id')
        .eq('session_id', currentSessionId);

    if (error) {
        console.warn('[legends] Could not load existing interviews:', error.message);
        return;
    }

    const seen = new Set();
    (data || []).forEach((row) => {
        if (row.npc_id && !seen.has(row.npc_id)) {
            seen.add(row.npc_id);
            // Skip the announce-flicker for historical rows: reveal immediately.
            instantUnlock(row.npc_id);
        }
    });
}

function instantUnlock(subjectId) {
    const card = findLegendCard(subjectId);
    if (!card || unlockedSubjectIds.has(subjectId)) return;
    unlockedSubjectIds.add(subjectId);

    const name  = card.dataset.name  || '';
    const title = card.dataset.title || '';
    const intro = card.dataset.intro || '';
    const photo = card.dataset.photo || '';

    const nameEl  = card.querySelector('.legend-name');
    const titleEl = card.querySelector('.legend-title');
    const introEl = card.querySelector('.legend-intro');
    const photoEl = card.querySelector('.legend-photo');

    if (nameEl  && name)  nameEl.innerHTML  = name;
    if (titleEl && title) titleEl.innerHTML = title;
    if (introEl && intro) introEl.textContent = intro;
    if (photoEl) {
        if (photo) {
            photoEl.innerHTML =
                `<img src="${escapeHtml(photo)}" alt="${escapeHtml(name)}">`;
        } else {
            photoEl.innerHTML =
                `<div class="legend-photo-placeholder">No portrait on file</div>`;
        }
    }
    card.classList.remove('locked');
    card.classList.add('unlocked');
}

function subscribeToInterviews() {
    if (!supabase) return;

    const changes = {
        event: 'INSERT',
        schema: 'public',
        table: 'interviews',
    };
    if (isSessionPinned && currentSessionId) {
        changes.filter = `session_id=eq.${currentSessionId}`;
    }

    supabase
        .channel(isSessionPinned ? `interviews:${currentSessionId}` : 'interviews:latest')
        .on('postgres_changes', changes, (payload) => {
            const row = payload.new;
            if (!row || !row.npc_id) return;

            // Same session-tracking behaviour as the article feed: if we
            // aren't pinned, latch on to the session of the first row we see.
            if (!isSessionPinned && row.session_id !== currentSessionId) {
                currentSessionId = row.session_id;
                setSessionStatus();
            }
            if (isSessionPinned && row.session_id !== currentSessionId) return;

            unlockLegend(row.npc_id);
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('[legends] subscribed to interviews realtime');
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                console.warn(`[legends] interviews subscription status: ${status}. ` +
                    `Make sure Realtime is enabled for the "interviews" table in Supabase.`);
            }
        });
}

// ---------- Supabase init ----------

async function initSupabaseSide() {
    if (!isSupabaseConfigured()) {
        console.warn('[supabase] supabase-config.js not filled in; supabase channels disabled.');
        renderArticles();
        return;
    }
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        await loadCurrentSession();
        setSessionStatus();
        await loadExistingArticles();
        await loadUnlockedLegends();
        subscribeToArticles();
        subscribeToInterviews();
    } catch (err) {
        console.error('[supabase]', err);
        renderArticles();
    }
}

// ---------- Init ----------

function init() {
    formatDate();
    renderBest();
    renderInitialGrid();
    initSupabaseSide(); // citizen-lens side bootstraps itself via socket.io events
}

init();