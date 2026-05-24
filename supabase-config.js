// Fill these two values from Supabase Dashboard -> Project Settings -> API.
// The anon public key is safe for browser use when RLS is enabled.
export const SUPABASE_URL = 'https://uhcgprnorihyvhrkxmpm.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_9ht5mlr0XOi3UefgMdbU4Q_-d5xzRcZ';

/** Supabase table for live poll counts (session_id + option_id). */
export const ABSURD_POLL_TABLE = 'absurd_poll_counts';

/**
 * Optional fallback when Supabase poll table is unavailable.
 * Example: 'http://192.168.1.10:3000' (Typewriter server on the LAN).
 */
/** Local dev default; newspaper.js also auto-uses http://localhost:3000 on localhost. */
export const TYPEWRITER_POLL_API = 'http://localhost:3000';
