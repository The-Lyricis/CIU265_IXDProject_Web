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
import {
    ABSURD_POLL_TABLE,
    SUPABASE_ANON_KEY,
    SUPABASE_URL,
    TYPEWRITER_POLL_API,
} from './supabase-config.js';

// ---------- DOM ----------

const bestNewsPhoto = document.getElementById('best-news-photo');
const photoGrid = document.getElementById('citizen-photo-grid');
const articleList = document.getElementById('article-list');
const legendsGrid = document.getElementById('legends-grid');
const statusEl = document.getElementById('realtime-status');
const dateEl = document.getElementById('current-date');
const sessionEl = document.getElementById('session-status');
const absurdPollResults = document.getElementById('absurd-poll-results');

const ABSURD_POLL_OPTIONS = [
    'The pigeons are getting fatter and fatter.',
    'All cinnamon rolls served during fika in Sweden are replaced with wasabi-flavored ones.',
    'The government might accidentally fund this installation and ask us to actually build it.',
    'The rain has applied for permanent residency.',
    'The urban sculptures still refuse to talk.',
    "It's not the driver but the tram itself doesn't want to wait for people.",
    "Everyone's camera is proactively choosing dramatic angles on purpose.",
    'Someone might believe this poll is for real.',
];

/** @type {number[]} */
let absurdPollCounts = Array(ABSURD_POLL_OPTIONS.length).fill(0);
let absurdPollPollTimerId = null;

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
const highlightArticleIds = new Set();
let currentSessionId = null;
let supabase = null;
let isSessionPinned = false;

let newsScrollResizeObserver = null;
let newsScrollResizeTimer = null;
/** Pixels per second — drives CSS loop duration (segmentHeight / speed) */
const NEWS_SCROLL_PX_PER_SEC = 10;

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

function isMetadataSubtitle(text) {
    if (!text) return false;
    const t = String(text);
    return /Subject:\s*/i.test(t) && /(Story:|Where:|Time:|Tone:)/i.test(t);
}

function stripArchiveFooter(text) {
    if (!text) return '';
    let body = String(text).trim();
    body = body.replace(/\n\n—\s+[^\n]+$/s, '').trim();
    body = body.replace(/\n—\s+Archive-inspired[\s\S]*$/i, '').trim();
    return body;
}

function getGeneratedDraft(item) {
    return item?.generatedDraft || item?.generated_draft || item?.article?.generatedDraft || null;
}

function getArticleContent(item) {
    const generated = getGeneratedDraft(item);
    const nested = item?.article || {};

    const headline =
        generated?.headline ||
        nested.headline ||
        item.headline ||
        item.title ||
        '';

    let body =
        generated?.body ||
        nested.body ||
        item.body ||
        '';

    body = stripArchiveFooter(body);

    if (!body && item.subtitle && !isMetadataSubtitle(item.subtitle)) {
        body = String(item.subtitle).trim();
    }

    return {
        headline: String(headline || '').trim(),
        body: String(body || '').trim(),
    };
}

function getDispatchMetaLine(item) {
    const timePart = formatTime(item.created_at);
    const generated = getGeneratedDraft(item);
    const label = generated?.label || item.tag;
    if (label && /archive-inspired/i.test(label)) {
        return `${timePart} · Archive-inspired dispatch`;
    }
    if (item.subtitle && !isMetadataSubtitle(item.subtitle)) {
        return `${timePart} · ${String(item.subtitle).trim()}`;
    }
    return `${timePart} · Public dispatch`;
}

function getNewsLoopTrack() {
    return articleList?.querySelector('.visitor-news-track') || null;
}

function getNewsLoopSegmentHeight() {
    const set = articleList?.querySelector('.visitor-news-set');
    return set ? set.offsetHeight : 0;
}

function shouldNewsAutoScroll() {
    if (!articleList) return false;
    const segment = getNewsLoopSegmentHeight();
    return segment > articleList.clientHeight + 1;
}

function syncNewsAutoScroll() {
    const list = articleList;
    const track = getNewsLoopTrack();
    if (!list || !track) return;

    track.classList.remove('visitor-news-track--animate');
    track.style.removeProperty('--loop-duration');

    const apply = () => {
        if (!articleList) return;
        const currentTrack = getNewsLoopTrack();
        if (!currentTrack) return;

        const segment = getNewsLoopSegmentHeight();
        if (segment > articleList.clientHeight + 1) {
            const durationSec = Math.max(segment / NEWS_SCROLL_PX_PER_SEC, 20);
            currentTrack.style.setProperty('--loop-duration', `${durationSec}s`);
            currentTrack.classList.add('visitor-news-track--animate');
        }
    };

    requestAnimationFrame(() => requestAnimationFrame(apply));
}

function bindNewsListScrollControls() {
    if (!articleList || articleList.dataset.scrollBound) return;
    articleList.dataset.scrollBound = '1';

    if (typeof ResizeObserver !== 'undefined') {
        newsScrollResizeObserver = new ResizeObserver(() => {
            clearTimeout(newsScrollResizeTimer);
            newsScrollResizeTimer = setTimeout(syncNewsAutoScroll, 100);
        });
        newsScrollResizeObserver.observe(articleList);
    }

    window.addEventListener('resize', () => {
        clearTimeout(newsScrollResizeTimer);
        newsScrollResizeTimer = setTimeout(syncNewsAutoScroll, 150);
    });
}

function shouldUseCitizenLensSocket() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('socket') === '1') return true;
    if (params.get('socket') === '0') return false;
    const port = window.location.port;
    if (port === '3000' || port === '5173') return true;
    return false;
}

function initCitizenLensSocket() {
    if (!shouldUseCitizenLensSocket()) {
        console.info(
            '[citizen-lens] Socket.IO skipped on this host (static preview). ' +
                'Add ?socket=1 when a Socket.IO server is running, e.g. on port 3000.'
        );
        return;
    }

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
        console.warn('[citizen-lens] socket connect_error:', err.message);
        setStatus('CITIZEN LENS OFFLINE');
    });

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
            const slots = getSlotEls();
            const slot = slots[Math.floor(Math.random() * slots.length)];
            flickerInto(slot, photoLibrary[photoLibrary.length - 1]);
        }
    });

    socket.on('photo:voted', ({ id, votes }) => {
        applyVote(id, votes);
        renderBest();
    });
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

// ---------- Everyone Edits side list (Supabase) ----------

function buildVisitorNewsItemHtml(article) {
    const { headline, body } = getArticleContent(article);
    const displayHeadline = headline || 'Untitled dispatch';
    const displayBody = body || '';
    const highlightClass = highlightArticleIds.has(article.id) ? ' is-new' : '';
    const safeId = escapeHtml(article.id);

    return `
        <article class="visitor-news-item${highlightClass}" data-article-id="${safeId}">
            <div class="news-meta">${escapeHtml(getDispatchMetaLine(article))}</div>
            <h3 class="news-headline">${escapeHtml(displayHeadline)}</h3>
            <p class="news-body">${escapeHtml(displayBody)}</p>
        </article>
    `;
}

function renderArticles() {
    const articles = Array.from(articlesById.values())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (articles.length === 0) {
        articleList.innerHTML = `
            <article class="visitor-news-item visitor-news-item--empty">
                <h3 class="news-headline">Newsroom awaiting dispatches</h3>
                <p class="news-body">Published typewriter stories will appear here as they are filed to the public feed.</p>
            </article>
        `;
        syncNewsAutoScroll();
        return;
    }

    const itemsHtml = articles.map(buildVisitorNewsItemHtml).join('');
    articleList.innerHTML = `
        <div class="visitor-news-track">
            <div class="visitor-news-set">${itemsHtml}</div>
            <div class="visitor-news-set visitor-news-set--loop" aria-hidden="true">${itemsHtml}</div>
        </div>
    `;

    syncNewsAutoScroll();
    setTimeout(syncNewsAutoScroll, 400);
}

function addArticle(article) {
    if (!article || !article.id) return;
    const isNew = !articlesById.has(article.id);
    articlesById.set(article.id, article);
    if (isNew) highlightArticleIds.add(article.id);
    renderArticles();
    if (isNew) {
        setTimeout(() => {
            highlightArticleIds.delete(article.id);
            const el = articleList?.querySelector(`[data-article-id="${CSS.escape(article.id)}"]`);
            el?.classList.remove('is-new');
        }, 2600);
    }
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

// ---------- Absurd voting (terminal poll) ----------

function getTypewriterPollApiBase() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('poll_api');
    if (fromQuery) return fromQuery.replace(/\/$/, '');
    if (TYPEWRITER_POLL_API) return String(TYPEWRITER_POLL_API).replace(/\/$/, '');

    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
        return 'http://localhost:3000';
    }
    return '';
}

function normalizeAbsurdPollCounts(raw) {
    const next = Array(ABSURD_POLL_OPTIONS.length).fill(0);
    if (Array.isArray(raw)) {
        for (let i = 0; i < ABSURD_POLL_OPTIONS.length; i += 1) {
            const n = Number(raw[i]);
            next[i] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
        }
        return next;
    }
    if (raw?.options && Array.isArray(raw.options)) {
        raw.options.forEach((opt) => {
            const id = Number(opt.id);
            const votes = Number(opt.votes);
            if (id >= 0 && id < next.length && Number.isFinite(votes) && votes >= 0) {
                next[id] = Math.floor(votes);
            }
        });
        return next;
    }
    return next;
}

function applyAbsurdPollState(state) {
    absurdPollCounts = normalizeAbsurdPollCounts(state?.counts || state);
    renderAbsurdPoll();
}

function renderAbsurdPoll() {
    if (!absurdPollResults) return;

    const total = absurdPollCounts.reduce((sum, n) => sum + n, 0);
    if (total === 0) {
        absurdPollResults.innerHTML =
            '<p class="absurd-poll-empty">Awaiting absurd votes from the editor desk…</p>';
        return;
    }

    const percentages = ABSURD_POLL_OPTIONS.map((_, index) => {
        const votes = absurdPollCounts[index] || 0;
        return total > 0 ? Math.round((votes / total) * 100) : 0;
    });
    const maxPct = Math.max(...percentages, 0);

    absurdPollResults.innerHTML = ABSURD_POLL_OPTIONS.map((text, index) => {
        const pct = percentages[index];
        const barWidth = maxPct > 0 && pct > 0 ? Math.round((pct / maxPct) * 100) : 0;
        return `
            <div class="absurd-poll-row">
                <div class="absurd-poll-row__label">
                    <span class="absurd-poll-row__text">${escapeHtml(text)}</span>
                    <span class="absurd-poll-row__meta">${pct}%</span>
                </div>
                <div class="absurd-poll-row__bar" style="width:${barWidth}%" aria-hidden="true"></div>
            </div>
        `;
    }).join('');
}

async function loadAbsurdPollFromApi() {
    const base = getTypewriterPollApiBase();
    if (!base) return false;
    try {
        const res = await fetch(`${base}/api/absurd-poll`, { cache: 'no-store' });
        if (!res.ok) return false;
        const data = await res.json();
        applyAbsurdPollState(data);
        return true;
    } catch (err) {
        console.warn('[absurd-poll] API fetch failed:', err.message, `(base: ${base})`);
        return false;
    }
}

function startAbsurdPollApiPolling() {
    const base = getTypewriterPollApiBase();
    if (!base) return;
    if (absurdPollPollTimerId) clearInterval(absurdPollPollTimerId);
    loadAbsurdPollFromApi();
    absurdPollPollTimerId = setInterval(loadAbsurdPollFromApi, 2000);
}

async function loadAbsurdPollFromSupabase() {
    if (!supabase || !currentSessionId) {
        renderAbsurdPoll();
        return;
    }

    const { data, error } = await supabase
        .from(ABSURD_POLL_TABLE)
        .select('option_id, vote_count')
        .eq('session_id', currentSessionId);

    if (error) {
        console.warn('[absurd-poll] Supabase load failed:', error.message);
        renderAbsurdPoll();
        return;
    }

    const next = Array(ABSURD_POLL_OPTIONS.length).fill(0);
    (data || []).forEach((row) => {
        const id = Number(row.option_id);
        const votes = Number(row.vote_count);
        if (id >= 0 && id < next.length && Number.isFinite(votes) && votes >= 0) {
            next[id] = Math.floor(votes);
        }
    });
    absurdPollCounts = next;
    renderAbsurdPoll();
}

function subscribeToAbsurdPoll() {
    if (!supabase) return;

    const changes = {
        event: '*',
        schema: 'public',
        table: ABSURD_POLL_TABLE,
    };
    if (isSessionPinned && currentSessionId) {
        changes.filter = `session_id=eq.${currentSessionId}`;
    }

    supabase
        .channel(isSessionPinned ? `absurd-poll:${currentSessionId}` : 'absurd-poll:latest')
        .on('postgres_changes', changes, (payload) => {
            const row = payload.new || payload.old;
            if (!row) return;

            if (!isSessionPinned && row.session_id && row.session_id !== currentSessionId) {
                currentSessionId = row.session_id;
                setSessionStatus();
                loadAbsurdPollFromSupabase();
                return;
            }
            if (isSessionPinned && row.session_id !== currentSessionId) return;

            const id = Number(row.option_id);
            const votes = Number(row.vote_count);
            if (id >= 0 && id < absurdPollCounts.length && Number.isFinite(votes)) {
                absurdPollCounts[id] = Math.max(0, Math.floor(votes));
                renderAbsurdPoll();
            } else {
                loadAbsurdPollFromSupabase();
            }
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('[absurd-poll] subscribed to realtime');
            }
        });
}

function initAbsurdPollSocket() {
    const base = getTypewriterPollApiBase();
    if (!base || typeof io === 'undefined') return;

    try {
        const pollSocket = io(base, { transports: ['websocket', 'polling'] });
        pollSocket.on('poll:update', (state) => {
            applyAbsurdPollState(state);
        });
        pollSocket.on('connect', () => {
            console.log('[absurd-poll] live sync via Typewriter at', base);
            loadAbsurdPollFromApi();
        });
        pollSocket.on('connect_error', (err) => {
            console.warn('[absurd-poll] socket connect_error:', err.message, '— is npm start running on', base, '?');
        });
    } catch (err) {
        console.warn('[absurd-poll] socket failed:', err.message);
    }
}

// ---------- Supabase init ----------

async function initAbsurdPollChannels() {
    renderAbsurdPoll();
    startAbsurdPollApiPolling();
    initAbsurdPollSocket();
}

async function initSupabaseSide() {
    if (!isSupabaseConfigured()) {
        console.warn('[supabase] supabase-config.js not filled in; supabase channels disabled.');
        renderArticles();
        await initAbsurdPollChannels();
        return;
    }
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        await loadCurrentSession();
        setSessionStatus();
        await loadExistingArticles();
        await loadUnlockedLegends();
        await loadAbsurdPollFromSupabase();
        subscribeToArticles();
        subscribeToInterviews();
        subscribeToAbsurdPoll();
        setStatus('NEWSROOM LIVE');
    } catch (err) {
        console.error('[supabase]', err);
        renderArticles();
        setStatus('NEWSROOM OFFLINE');
    }

    await initAbsurdPollChannels();
}

// ---------- Init ----------

function init() {
    formatDate();
    renderBest();
    renderInitialGrid();
    renderAbsurdPoll();
    bindNewsListScrollControls();
    initCitizenLensSocket();
    initSupabaseSide();
}

init();