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
```

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
