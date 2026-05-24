# CIU265 IXD Project Web

Live newspaper display for the CIU265 interaction design project.

The page listens to Supabase Realtime and updates when the Unity VR experience submits a completed interview.

## Flow

```text
Unity VR interview
  -> Supabase Edge Function submit-interview
  -> interviews row
  -> frontpage_articles row
  -> this web page updates in realtime
```

## Files

```text
index.html
  Main newspaper page.

newspaper.css
  Newspaper layout and print-style visual treatment.

newspaper.js
  Supabase client, active-session loading, and Realtime subscription.

supabase-config.js
  Public Supabase browser configuration.
```

## Local Preview

Run a static server from the repository root:

```powershell
python -m http.server 5500
```

Open:

```text
http://localhost:5500/
```

Do not open `index.html` directly with `file://`, because browser module imports may fail.

## Supabase

`supabase-config.js` should contain:

```js
export const SUPABASE_URL = 'your project url';
export const SUPABASE_ANON_KEY = 'your anon public key';
```

This page only reads public data:

```text
sessions
frontpage_articles
interviews
absurd_poll_counts
```

### Absurd voting

The bottom-right panel shows live results for **Absurd voting**. Votes are submitted from the Typewriter editor (`/editor` → **Absurd voting** tab) and synced via Supabase Realtime.

Create the tables using `Typewriter/scripts/supabase-absurd-poll.sql` (creates `sessions` + `absurd_poll_counts` if missing), then confirm Realtime is enabled for `absurd_poll_counts`.

If SQL fails with `relation "public.sessions" does not exist`, you are on an old copy of the script — use the updated file that creates `sessions` first.

For local testing without Supabase, point the page at the Typewriter server:

```text
http://localhost:5500/?poll_api=http://localhost:3000
```

Or set `TYPEWRITER_POLL_API` in `supabase-config.js`.

Unity writes data through the protected Supabase Edge Function:

```text
submit-interview
x-unity-secret: <UNITY_SHARED_SECRET>
```

Do not put the real Unity secret or Supabase service role key in this repository.

## Vercel

Deploy as a static project:

```text
Framework Preset: Other
Build Command: empty
Output Directory: empty
Root Directory: repository root
```

Vercel will serve `index.html` at the project root.
