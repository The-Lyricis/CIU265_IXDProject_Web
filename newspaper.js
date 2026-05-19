import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './supabase-config.js';

const leadStory = document.getElementById('lead-story');
const leadEmpty = document.getElementById('lead-empty');
const photoGrid = document.getElementById('citizen-photo-grid');
const articleList = document.getElementById('article-list');
const statusEl = document.getElementById('realtime-status');
const dateEl = document.getElementById('current-date');
const sessionEl = document.getElementById('session-status');

const articlesById = new Map();
let currentSessionId = null;
let supabase = null;
let isSessionPinned = false;

// ---------- Citizen Lens live photos (broadcast from capture.html) ----------

const CITIZEN_CHANNEL = 'citizen-lens-photos';
const CITIZEN_EVENT_NEW = 'new-photo';
const CITIZEN_EVENT_RESET = 'reset-photos';
const MAX_PHOTOS = 8;
const photoQueue = []; // FIFO of {id, dataUrl, createdAt}

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
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
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

// ---------- Citizen Lens grid rendering ----------

function renderPhotoGrid() {
    if (!photoGrid || !leadStory) return;

    const slotEls = photoGrid.querySelectorAll('.citizen-slot');
    slotEls.forEach((slotEl, i) => {
        const photo = photoQueue[i];
        if (photo) {
            const existing = slotEl.querySelector('img');
            if (!existing || existing.dataset.photoId !== photo.id) {
                slotEl.innerHTML = '';
                const img = document.createElement('img');
                img.src = photo.dataUrl;
                img.alt = 'Citizen Lens capture';
                img.dataset.photoId = photo.id;
                slotEl.appendChild(img);
            }
            slotEl.classList.add('filled');
        } else {
            slotEl.classList.remove('filled');
            slotEl.innerHTML = '';
        }
    });

    if (photoQueue.length > 0) {
        leadStory.classList.add('has-photos');
    } else {
        leadStory.classList.remove('has-photos');
    }
}

function addPhoto(photo) {
    if (!photo || !photo.dataUrl) return;
    if (photo.id && photoQueue.some((p) => p.id === photo.id)) return; // dedup

    photoQueue.push({
        id: photo.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl: photo.dataUrl,
        createdAt: photo.createdAt || new Date().toISOString(),
    });

    // FIFO: keep only the latest MAX_PHOTOS
    while (photoQueue.length > MAX_PHOTOS) {
        photoQueue.shift();
    }

    renderPhotoGrid();
}

function clearPhotos() {
    photoQueue.length = 0;
    renderPhotoGrid();
}

function subscribeToCitizenLens() {
    if (!supabase) return;
    supabase
        .channel(CITIZEN_CHANNEL, { config: { broadcast: { self: false } } })
        .on('broadcast', { event: CITIZEN_EVENT_NEW }, (msg) => {
            addPhoto(msg.payload);
            setStatus('CITIZEN LENS LIVE');
        })
        .on('broadcast', { event: CITIZEN_EVENT_RESET }, () => {
            clearPhotos();
            setStatus('CITIZEN LENS CLEARED');
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('[citizen-lens] subscribed.');
            }
        });
}

// ---------- Article list (Everyone Edits) ----------
// Lead area is now reserved for live Citizen Lens photos, so all incoming
// articles populate the Everyone Edits side list rather than the lead story.

function renderImage(article) {
    if (!article.image_url) {
        return '<div class="image-placeholder">No interview image yet</div>';
    }
    return `<img src="${article.image_url}" alt="${escapeHtml(article.title)}">`;
}

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
        .on(
            'postgres_changes',
            changes,
            (payload) => {
                if (isSessionPinned && payload.new.session_id !== currentSessionId) {
                    return;
                }

                if (!isSessionPinned && payload.new.session_id !== currentSessionId) {
                    currentSessionId = payload.new.session_id;
                    articlesById.clear();
                    setSessionStatus();
                }

                addArticle(payload.new);
                setStatus('LIVE FROM THE VR NEWSROOM');
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                setStatus('LIVE FROM THE VR NEWSROOM');
            }
        });
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

async function init() {
    formatDate();

    if (!isConfigured()) {
        setStatus('SUPABASE CONFIG NEEDED');
        if (leadEmpty) {
            leadEmpty.textContent = 'Fill supabase-config.js to connect the live newsroom';
        }
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
        if (leadEmpty) {
            leadEmpty.textContent = error.message;
        }
        // Still subscribe to Citizen Lens broadcasts even if article loading
        // failed - the photo wall doesn't depend on sessions/articles.
        if (supabase) subscribeToCitizenLens();
    }
}

init();