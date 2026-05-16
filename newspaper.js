import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './supabase-config.js';

const leadStory = document.getElementById('lead-story');
const articleList = document.getElementById('article-list');
const statusEl = document.getElementById('realtime-status');
const dateEl = document.getElementById('current-date');
const sessionEl = document.getElementById('session-status');

const articlesById = new Map();
let currentSessionId = null;
let supabase = null;
let isSessionPinned = false;

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

function renderImage(article) {
    if (!article.image_url) {
        return '<div class="image-placeholder">No interview image yet</div>';
    }

    return `<img src="${article.image_url}" alt="${escapeHtml(article.title)}">`;
}

function renderLead(article) {
    if (!article) {
        leadStory.innerHTML = '<div class="empty-slot">Waiting for the first VR interview</div>';
        return;
    }

    leadStory.innerHTML = `
        <figure class="lead-figure">
            ${renderImage(article)}
            <figcaption>${formatTime(article.created_at)}</figcaption>
        </figure>
        <h3>${escapeHtml(article.title)}</h3>
        <p class="lead-subtitle">${escapeHtml(article.subtitle || '')}</p>
        <p>${escapeHtml(article.body || '')}</p>
    `;
}

function renderArticles() {
    const articles = Array.from(articlesById.values())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    renderLead(articles[0]);

    const sideArticles = articles.slice(1, 5);
    if (sideArticles.length === 0) {
        articleList.innerHTML = `
            <article class="sub-article">
                <h4>Newsroom awaiting interviews</h4>
                <p>Completed VR interviews will appear here as soon as they are filed.</p>
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
        leadStory.innerHTML = '<div class="empty-slot">Fill frontend/supabase-config.js to connect the live newsroom</div>';
        renderArticles();
        return;
    }

    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        await loadCurrentSession();
        setSessionStatus();
        await loadExistingArticles();
        subscribeToArticles();
    } catch (error) {
        console.error(error);
        setStatus('NEWSROOM CONNECTION ERROR');
        leadStory.innerHTML = `<div class="empty-slot">${escapeHtml(error.message)}</div>`;
    }
}

init();
