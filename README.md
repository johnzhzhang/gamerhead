# GamerHeads — AI Gaming-Streamer Video Generation

**GamerHeads** turns a gameplay recording into a promo video fronted by an AI gaming streamer. You give it a game title, a store link and a call to action; it writes the script, generates the streamer's avatar, renders talking-head clips with Veo, and composites them over your gameplay footage — all inside your own Google Cloud project.

Every AI call runs server-side through Vertex AI with Application Default Credentials. **No API keys anywhere.**

---

## Table of contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Authentication modes](#authentication-modes)
- [Environment variables](#environment-variables)
- [The deploy script](#the-deploy-script)
- [Video generation models](#video-generation-models)
- [Autopilot: batch production](#autopilot-batch-production)
- [User workflow](#user-workflow)
- [Project history](#project-history)
- [Exports and previews](#exports-and-previews)
- [Admin dashboard](#admin-dashboard)
- [Data model](#data-model)
- [HTTP API reference](#http-api-reference)
- [Local development](#local-development)
- [Project layout](#project-layout)
- [Cost notes](#cost-notes)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

---

## What it does

| Capability | Detail |
|---|---|
| **Script generation** | `gemini-3.7-flash` reads your gameplay video plus the project details and returns a timed shot list (start/end, duration, streamer action, dialogue) as structured JSON. Optional Google Search grounding pulls in real facts about the game. |
| **Avatar generation** | `gemini-3.1-flash-image` renders the streamer at the exact aspect ratio the layout needs. You can supply a reference image to lock the character's look and only describe the pose. Every generated avatar is persisted to `gs://<bucket>/avatars/` and listed in the Avatar Lab so it can be reused without paying for a new generation. |
| **Clip generation** | `gemini-omni-1.1-flash-preview` animates the avatar per shot, with speech. The model is not user-selectable: the server transparently falls back to `gemini-omni-flash-preview` (on quota) and to Veo 3.1 (on quota exhaustion or a content-safety block). Generate one take or two in parallel and pick the better one. Clips can chain from the previous clip's last frame for continuity. |
| **Composition** | FFmpeg concatenates the clips server-side; the browser then composites the streamer over your gameplay as picture-in-picture, stacked, or streamer-only, with an audio mix slider. |
| **Burned-in subtitles** | Optional. Built from the script dialogue, rendered as ASS with size pinned to the real video dimensions, burned by FFmpeg onto the full frame (not the tiny PiP window). |
| **Preview before download** | Every export can be played inline in the browser before you keep it. |
| **Durable output** | Clips land in `gs://<bucket>/videos/`, finished renders in `gs://<bucket>/exports/YYYY/MM/`. |
| **Project history** | The whole working set — including the avatar image and every generated clip — is autosaved server-side per user, so a reload or a lost session does not mean re-typing and re-generating. |
| **Admin dashboard** | Usage scorecards, per-model trend chart, activity log with CSV export and authenticated file download. Restricted to `ADMIN_USERS`. |
| **Autopilot** | Optional. One form, one confirmation of the streamer image, then up to 10 finished videos produced unattended and delivered as download links. Off by default. |
| **Three auth modes** | Cloud Run native IAP, Google Sign-In via GIS, or fixed username/password. |

---

## How it works

```
Browser (React 19 + Vite)
   │
   │  same-origin /api/*  — never talks to Google AI directly
   ▼
Cloud Run (Node 20 + Express + FFmpeg)
   ├─ Vertex AI  ──►  Gemini (script, avatar) · Veo (clips)
   ├─ Cloud Storage ─►  gs://<bucket>/videos/ · gs://<bucket>/exports/YYYY/MM/
   └─ Firestore in Datastore mode ─►  GenerationLog · Project
```

Two deliberate architectural choices:

**All AI traffic is server-side.** The browser only ever calls `/api/*` on the same origin. The container authenticates to Vertex AI with the Compute Service Account via ADC, so there is no key to leak and nothing to rotate.

**Video work is split.** Concatenation and subtitle burn-in run in FFmpeg inside the container (deterministic, fast). The picture-in-picture composite runs in the browser via Canvas `captureStream` + `MediaRecorder`, because it needs the user's original high-quality gameplay file without uploading hundreds of megabytes. That is why the UI warns you to keep the tab active during a Full Mix export, and why the browser-made render is uploaded back to the server afterwards to be persisted.

---

## Quick start

### Prerequisites

1. **gcloud CLI**, installed and authenticated:
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```
2. **A GCP project with billing enabled** — Cloud Run requires it.
3. **Permissions** for the account running the script. Owner is simplest; the minimum set is listed in [DEPLOYMENT.md](DEPLOYMENT.md#二执行部署所需的操作者权限).
4. **Network access to Google Cloud APIs** from wherever you run the script.

### Deploy

```bash
chmod +x deploy.sh
./deploy.sh
```

Pick **1) 全新部署 / Fresh deployment**, accept the defaults, and choose auth option **3 (Cloud Run native IAP)** unless you have a reason not to. Roughly 5 minutes, most of it Cloud Build.

The script creates the Firestore database and the GCS bucket, binds every IAM role the runtime needs, builds from source, and prints the service URL.

---

## Authentication modes

| | **3. Cloud Run IAP** (recommended) | **1. Google Sign-In (GIS)** | **2. Fixed username/password** |
|---|---|---|---|
| Login experience | Redirect to `accounts.google.com` before the app loads | In-app Google button | Browser Basic-Auth dialog |
| Manual setup | None | **OAuth Client ID must be created by hand in the Console** | None |
| Access control | IAM role `roles/iap.httpsResourceAccessor` | `AUTHORIZED_USERS` env var | `BASIC_AUTH_USERS` env var |
| Cloud Run flags | `--iap`, no `--allow-unauthenticated` | `--allow-unauthenticated` | `--allow-unauthenticated` |
| Identity seen by the app | `x-goog-authenticated-user-email` header | Verified Google ID token | The login name |
| Supports groups / domains | Yes (`group:`, `domain:`) | No (email list only) | No |

**Why IAP is the default.** A Web OAuth 2.0 Client ID for GIS can only be created in the Cloud Console — there is no API for it. The IAP OAuth Admin API was shut down on 2026-03-19, and the clients it produced had no authorized JavaScript origins, so GIS could not use them anyway. IAP needs none of that: `gcloud run deploy --iap` plus an IAM binding and you are done.

> ⚠️ **Never re-run Mode 1 with option 1 or 2 on a service that is already behind IAP.** Those paths pass `--allow-unauthenticated`, which grants `run.invoker` to `allUsers` and lets traffic reach the container without passing IAP. To ship code changes use Mode 2, which never touches the auth configuration.

### Granting access under IAP

```bash
./deploy.sh   # → 3 → 1) users allowed to sign in
```

or directly:

```bash
gcloud beta iap web add-iam-policy-binding \
  --resource-type=cloud-run --service=gamerheads --region=us-central1 \
  --member="user:someone@example.com" \
  --role="roles/iap.httpsResourceAccessor"
```

`user:` / `group:` / `domain:` / `serviceAccount:` prefixes all work; a bare email is treated as `user:`. Changes take effect within about a minute.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | yes | GCP project ID. `GCLOUD_PROJECT` and `GCP_PROJECT_ID` are accepted as fallbacks. |
| `GCP_LOCATION` | yes | Vertex AI region. Defaults to `us-central1`; Veo is only available there. |
| `DATASTORE_DATABASE` | yes | Firestore-in-Datastore-mode database ID. Defaults to `gamerhead`. |
| `GCS_BUCKET_NAME` | yes | Bucket for clips and exports. Without it clips are returned inline as base64 and nothing is persisted. |
| `ADMIN_USERS` | no | Comma-separated allowlist for the Admin dashboard. Falls back to `AUTHORIZED_USERS`; **if both are empty `/api/admin/*` is disabled for everyone.** |
| `GOOGLE_CLIENT_ID` | conditional | Setting it switches the app into GIS mode. |
| `AUTHORIZED_USERS` | no | GIS mode email allowlist. Empty means anyone who clears the consent screen gets in. |
| `AUTHORIZED_DOMAIN` | no | GIS mode single-domain restriction, e.g. `example.com`. |
| `BASIC_AUTH_USERS` | conditional | `user:pass,user2:pass2`. Setting it switches the app into Basic-Auth mode. |
| `SCRIPT_MODEL` | no | Overrides the script / shot-list model. Defaults to `gemini-3.7-flash` (GA). Must support system instructions, structured output, Google Search grounding and video input on the `global` endpoint. |
| `VIDEO_MODEL` | no | Primary clip-generation model. Defaults to `gemini-omni-1.1-flash-preview`. Any id starting with `veo-` routes to the Veo API instead of the Interactions API. |
| `VIDEO_MODEL_FALLBACK` | no | Omni model used when the primary is out of quota. Defaults to `gemini-omni-flash-preview` (720p only). |
| `VIDEO_MODEL_LAST_RESORT` | no | Model used when every Omni candidate is unavailable or the output is safety-blocked. Defaults to `veo-3.1-fast-generate-001`; set to empty to disable the net. |
| `VIDEO_BLOCK_RETRIES` | no | How many times to retry Omni on a `content_blocked` result before falling through to Veo. Defaults to `1`. |
| `VIDEO_RESOLUTION` | no | Gemini Omni output resolution: `360p` / `720p` / `1080p` / `4k`. Defaults to `720p`. |
| `AUTOPILOT_ENABLED` | no | Set to `1` to expose Autopilot. Unset means every `/api/autopilot/*` route returns 404 and the tab is hidden. |
| `AUTOPILOT_MAX_BATCH` | no | Videos per batch. Defaults to `10`. |
| `AUTOPILOT_CONCURRENCY` | no | Clips generated in parallel. Defaults to `4`; bounded by the Omni per-minute quota. |
| `AUTOPILOT_COMPOSE_CONCURRENCY` | no | Parallel ffmpeg composites. Defaults to `2`; bounded by container CPU. |
| `AUTOPILOT_MAX_CLIPS_PER_JOB` | no | Cost breaker: refuses a job that would need more clips than this. Defaults to `60`. |
| `AUTOPILOT_VEO_CLIP_BUDGET` | no | How many clips of one batch may fall through to pay-as-you-go Veo. Defaults to 25% of the batch, minimum 4. |
| `AUTOPILOT_UPLOAD_MAX_BYTES` | no | Gameplay upload ceiling. Defaults to 250 MB. |

Image uploads have their own fixed ceiling of 12 MB (PNG / JPEG / WebP).
| `PORT` | no | Defaults to `8080`. |
| `NODE_ENV` | no | Anything other than `development` means production (static `dist/`). `development` mounts Vite middleware. |

Auth mode is decided by precedence: `BASIC_AUTH_USERS` → `GOOGLE_CLIENT_ID` → IAP headers → no protection.

### Editing variables on a live service

`--env-vars-file` **removes every existing variable** before writing the file's contents. Anything not in the file is silently lost — this is exactly how an earlier version of `deploy.sh` dropped `ADMIN_USERS` and quietly downgraded admin access to "everyone who can sign in". Always update one key at a time:

```bash
# ^#^ switches the list delimiter from ',' to '#' so commas inside the value survive
gcloud run services update gamerheads --region=us-central1 \
  --update-env-vars="^#^AUTHORIZED_USERS=a@x.com,b@y.com"

gcloud run services update gamerheads --region=us-central1 \
  --remove-env-vars=ADMIN_USERS
```

---

## The deploy script

`deploy.sh` is bilingual (Chinese/English) and has three modes.

### Mode 1 — Fresh deployment

1. Verifies billing is enabled.
2. Enables Cloud Build, Cloud Run, Artifact Registry, Firestore, Vertex AI, Cloud Storage — plus IAP if you pick that auth mode.
3. Creates the Firestore database in **Datastore mode** if missing. (The `@google-cloud/datastore` client cannot talk to a Native-mode database, so this must not be a Native DB.)
4. Creates the GCS bucket if missing.
5. Asks for the auth mode and, for IAP/GIS, the list of people allowed in.
6. Asks for `ADMIN_USERS`.
7. Binds IAM roles — see below.
8. Builds from source with Cloud Build and deploys, with `--iap` or `--allow-unauthenticated` depending on the auth mode.
9. For IAP, binds `roles/iap.httpsResourceAccessor` to each address you listed.

Roles granted to the **Compute Service Account** (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`):

| Role | Why |
|---|---|
| `roles/aiplatform.user` | Call Gemini and Veo |
| `roles/datastore.user` | Read/write activity logs and project history |
| `roles/storage.objectAdmin` (project + bucket) | Read/write clips and exports |
| `roles/iam.serviceAccountTokenCreator` | Sign GCS URLs for downloads and previews |
| `roles/logging.logWriter`, `roles/monitoring.metricWriter`, `roles/cloudtrace.agent` | Observability |
| `roles/cloudtranslate.user` | Reserved for translation features |

The **Cloud Build Service Account** gets `roles/artifactregistry.writer`.

### Mode 2 — Update code

Rebuilds and redeploys from local source. Touches nothing else: environment variables, IAM, and the IAP setting all carry over (the script deliberately passes neither `--iap` nor `--no-iap`). The confirmation screen shows the current IAP state so you can see what is being preserved.

### Mode 3 — Manage users and admins

Detects the service's auth mode and adapts. Two things to manage:

| Choice | Effect |
|---|---|
| **1) Users allowed to sign in** | IAP → IAM bindings · GIS → `AUTHORIZED_USERS` · Basic → prints the manual command · unprotected → warns you |
| **2) Admins** | `ADMIN_USERS`, identical in every mode |

Only ever uses `--update-env-vars` / `--remove-env-vars`, so unrelated variables are left alone.

### Mode 4 — Configure Autopilot

Enables or disables batch production on an existing service. Enabling:

- writes `AUTOPILOT_ENABLED` and the batch limits
- sets `--min-instances=1 --no-cpu-throttling` so a batch continues after the
  user closes the tab (this is what makes an idle service cost money; option 2
  reverses it)
- configures the bucket **CORS** rule needed for direct uploads, covering both
  Cloud Run host forms, and reads it back to confirm
- optionally creates a Cloud Scheduler job that calls `/api/autopilot/resume`
  every five minutes to pick up batches stalled by a recycled instance

Disabling removes the variables and returns `min-instances` to 0. Existing jobs
and videos are left in place.

Mode 4 changes configuration only. If the tab does not appear afterwards, the
running image predates the feature — run mode 2 first.

Mode 1 also offers Autopilot as a single optional question, defaulting to **no**,
so pressing Enter yields exactly the pre-Autopilot deployment.

### Running it non-interactively

Every non-interactive `gcloud`/`gsutil` call is invoked with `</dev/null`, because `gcloud` will otherwise consume the piped stdin and the following `read` hits EOF (which, under `set -e`, kills the script). So feeding answers from a file works:

```bash
# --lang skips the language question entirely, so the input is just the answers
./deploy.sh --lang=zh <<< $'2\ny\ngamerheads\nus-central1\ny\n'
```

The language is asked once and then remembered in `.deploy-lang` (gitignored), so
it does not reappear on later runs. `--lang=zh|en` or `GH_DEPLOY_LANG` override it
and are the right choice for automation. Without either, a piped run still consumes
one line for the language, which keeps older pipelines working.

---

## Video generation models

Clip generation defaults to **`gemini-omni-flash-preview`**
([model docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/omni-flash-preview)).
`gemini-omni-1.1-flash-preview`
([docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/omni-1-1-flash))
is also selectable. Both are served by the Interactions API — not a drop-in swap
for Veo:

| | **Gemini Omni Flash** (default) / **Omni 1.1** | **Veo 3.1** (fallback) |
|---|---|---|
| API | Interactions API: `POST .../locations/global/interactions` | `predictLongRunning` + `fetchPredictOperation` |
| Region | `global` only — there is no regional host | `us-central1` only |
| Start frame | Cloud Storage `uri` (the app stages it under `frames/`) | inline base64 |
| Duration | string `"3s"`–`"10s"` | integer 4 / 6 / 8 |
| Resolution | `720p` (Omni Flash) · `360p`–`4k` (Omni 1.1) | `720p` / `1080p` |
| System instructions | **not supported** | supported |
| Output location | `steps[]` → `model_output` step → `video` content item | `response.videos[]` |
| Handle returned to the client | interaction id | long-running-operation name |
| Consumption | Preview, fixed quota. Omni Flash has quota by default; **Omni 1.1 must be granted quota per project** | pay-as-you-go |

`/api/gemini/video-operation` tells the two apart by whether the handle contains
`/operations/`, so both paths coexist behind one opaque handle.

### Model chain

The model is **not a user-facing choice** — the Studio shows which one is in use
and nothing more. Every fallback happens server-side, so the whole chain is
invisible to the user. The server walks it per request:

1. `VIDEO_MODEL` (default `gemini-omni-1.1-flash-preview`) — primary
2. `VIDEO_MODEL_FALLBACK` (default `gemini-omni-flash-preview`) — used when the
   primary returns a persistent quota 429. 720p only
3. `VIDEO_MODEL_LAST_RESORT` (default `veo-3.1-fast-generate-001`) — used when
   every Omni candidate is out of quota. Veo is pay-as-you-go so it is always
   available. Set the variable to an empty string to disable the net.

The response reports which model actually ran (`model`) and whether the Veo net
fired (`fallback: true`); the client does not need to care, because the polling
endpoint routes on the handle shape.

### Content-safety blocks

Gemini Omni applies a Responsible AI filter to its *output*, and rejects
photorealistic people non-deterministically — a real hazard for an app whose
premise is a photorealistic streamer. Because the block only surfaces at poll
time (when the request no longer holds the prompt or start frame), the
generation context is persisted to a Datastore `VideoJob` entity keyed by the
handle. On a `content_blocked` result the poll endpoint resubmits automatically:
retry Omni up to `VIDEO_BLOCK_RETRIES` times (the filter is non-deterministic, so
a plain retry often passes), then fall through to `VIDEO_MODEL_LAST_RESORT`
(Veo, which honours `personGeneration: allow_adult`). It hands the client a new
handle to poll, so the whole recovery is invisible. Omni itself cannot relax the
filter — its Interactions API returns `Omni does not support safety settings`.

The retry uses Datastore because Cloud Run is multi-instance and a poll may land
on a different instance than the one that started the job.

### Two gotchas found against the live API

**`background` goes at the top level.** The documentation shows it inside
`input[0]`; the API rejects that:

```
400 invalid_request: Unknown parameter 'background' at 'input[0]'
```

**Retrieval is a GET, not a POST.** The docs show `POST .../interactions/{id}`
to fetch a finished interaction; that returns 404. `GET` returns it.

**Omni 1.1 needs quota.** `gemini-omni-flash-preview` has fixed quota by default,
but `gemini-omni-1.1-flash-preview` returns a persistent (not transient) 429
until quota is granted for the base model:

```
429 too_many_requests: Quota exceeded for
aiplatform.googleapis.com/global_generate_content_requests_per_minute_per_project_per_base_model
with base model: gemini-omni-1.1-flash-preview
```

The server turns that into an actionable message and points at the Veo fallback
rather than surfacing a raw quota error.

---

## Autopilot: batch production

Optional and off by default. The three-step wizard is unchanged; Autopilot is a
separate tab that only appears when the server has `AUTOPILOT_ENABLED` set.

Where the wizard asks for a decision at every step, Autopilot asks once:

```
fill one form → ⏸ confirm the streamer image → N finished videos, as download links
```

Script, shot list, clips, concatenation, subtitles and compositing all run
server-side without further input.

### The one place a human is required

The streamer image is confirmed before anything else runs. That is not merely a
preview:

| Why | Detail |
|---|---|
| **Cost** | The streamer appears in every video in the batch. A wrong image wastes the whole run — roughly 40 clip generations for 10 videos. Crossing the gate is what authorises that spend, so the console states the clip count on the confirm button. |
| **Not reproducible** | Image generation is non-deterministic; regenerating never returns the same person (the same reason the Studio keeps an avatar history). Settling it first is the only reliable order. |
| **Amortised** | One confirmation unlocks the whole batch. |

At the gate you can regenerate (with an edited description or a reference image),
upload your own streamer image, or cancel. Regenerating is cheap and unlimited —
only images have been produced at that point.

### Where the streamer comes from

Three routes, and **all images are uploaded** — the API never asks anyone to
supply a `gs://` URI by hand:

| Route | How | When it helps |
|---|---|---|
| **Describe it** | `avatarPrompt` | The default. Nothing to prepare |
| **Describe it, with a reference image** | Upload via `POST /api/autopilot/image-upload-url` (`kind: reference`) | Pins a face or character so generation follows it instead of inventing someone. Since the streamer appears in every video of the batch and regeneration never returns the same person, this is the reliable way to hit a specific look |
| **Supply a finished streamer** | Upload with `kind: streamer` | You already have a mascot or a person. Generation is skipped entirely |

A supplied streamer image **still goes to the confirmation gate**: confirming is
what authorises the expensive half of the run, so it is never skipped just because
no generation happened.

Image uploads are capped at 12 MB and limited to PNG / JPEG / WebP, separately
from the 250 MB gameplay ceiling.

The gate is enforced server-side, not just in the UI: the job sits in
`awaiting_avatar` and **no automatic mechanism advances it**. The in-process
worker, the poll-driven `tick` and the `resume` sweep all consult one function
that yields "wait" in that state, so a front-end bug cannot trigger the expensive
half of the run.

### Variants

A batch is one brief rendered several ways. Each variant gets its own script with
a different opening angle (the temperature climbs with the index); all variants
share the confirmed streamer and the single uploaded gameplay file.

### Getting back to a batch

A batch outlives the page, so the console has to offer a way back — otherwise the
invitation to walk away is empty. Two mechanisms:

- **The batch list.** `Your batches` lists everything this account has run, newest
  first, with title, status and progress. Opening one shows live progress, and for
  a finished batch it re-signs the download links (they expire after an hour).

Each finished video comes back with **two** signed URLs: a plain one for the inline
player and one carrying `Content-Disposition: attachment` for the download link.
One URL cannot do both — the HTML `download` attribute is ignored for cross-origin
URLs, and a Cloud Storage URL is always cross-origin here, so a single link would
simply play the video. Verified in Chrome: the plain URL navigates and plays, the
attachment URL fires a download with the intended filename.
- **Automatic reopen.** The last batch opened in that browser is remembered in
  `localStorage`; on load the console reopens it. Failing that it reopens the
  newest batch still running, so an interrupted run is never stranded — and on a
  different machine, where there is no local memory, the list still finds it.

### Grounding the script in real facts

Optional, off by default, and requires the store page URL: with it on, the script
model searches for the game and works verifiable details into the dialogue instead
of writing plausible-sounding filler. That matters more here than in the wizard,
because ten variants would otherwise repeat the same guesses.

Verified against the live API: with the flag on, the response carries
`groundingMetadata` and a real search query; with it off, neither appears. Note the
returned citation list comes back empty on 3.5 and 3.7 alike — a pre-existing
platform quirk, not specific to Autopilot. The flag is dropped rather than silently
honoured if no store URL was given.

### Durability

Everything is checkpointed to a Datastore `AutopilotJob` after each step, so:

- closing the tab does not stop the batch (given a warm instance — see below)
- an instance being recycled mid-batch costs at most one clip; the replacement
  resumes from the checkpoint rather than starting over
- **partial delivery is intentional**: if 8 of 10 succeed you get 8 links plus the
  reasons for the other 2, rather than losing the batch

Several workers progress one batch at a time. Checkpoints are written in a
transaction, because a plain read-modify-write loses updates when workers overlap —
in testing that showed up as the clip count going backwards and a failed variant
reverting to running.

### Two things Autopilot needs that the wizard does not

**Gameplay is uploaded straight to Cloud Storage.** Cloud Run caps an HTTP/1
request body at 32 MiB and the limit cannot be raised, while the UI accepts up to
250 MB, so the browser PUTs the file to a v4 signed URL and the app never sees the
bytes. This requires a **CORS rule on the bucket** — `deploy.sh` mode 4 configures
it and reads it back, because a missing rule fails uploads with an opaque browser
error and no server-side trace.

**Compositing happens in ffmpeg, not the browser.** The Studio composites
picture-in-picture with Canvas and `MediaRecorder`, which cannot work with no tab
open. `lib/compose.js` is a port of that geometry: same canvas sizes, the same
cover-fit crop, a picture-in-picture box at 10% of the frame area with 2% padding,
20 px rounded corners and a 6 px white stroke, the 30% / 35% stacked splits, and
the same rule that output length follows the gameplay while the streamer's slot
turns black once it ends. The only omission is the drop shadow behind the PiP box.

### Costs

A batch is the most expensive thing this app does. Three guards, in order of
effectiveness:

1. **The confirmation gate** — before it, one image has been generated; after it,
   tens of videos
2. **`AUTOPILOT_VEO_CLIP_BUDGET`** — Veo stays available as the rescue for a
   safety-blocked clip (it honours `personGeneration: allow_adult`), but it is
   pay-as-you-go, so only a fraction of a batch may fall through to it. Without
   this, "Omni is out of quota" would quietly become a whole batch of Veo renders
3. **`AUTOPILOT_MAX_CLIPS_PER_JOB`** — refuses an oversized job up front, and again
   once the real shot count is known from the first script

## User workflow

The UI is a three-step wizard followed by two working tabs.

**Project Details** — Step 1 picks the aspect ratio (16:9 landscape or 9:16 portrait). Step 2 picks the layout (classic PiP, stacked, streamer-only) and its placement. Step 3 collects the game title, optional store URL, gaming device, dialogue pacing, call to action, free-form instructions, and the gameplay video (≤ 250 MB).

Changing any of these invalidates the script and shot list, because they all feed the prompt.

**Avatar** — Describe the streamer's appearance and background, or upload a reference image and describe only the pose. The required aspect ratio is derived from the layout: stacked needs the avatar in the opposite orientation to the final video, so the app forces it and tells you when a layout change invalidates an existing avatar.

Every generated avatar is uploaded to the bucket and appears in an **Avatars in this project** strip under the Generate button. Clicking one puts it back into use without a new generation charge, which matters because avatar generation is not deterministic — regenerating never gives you the same streamer back.

**Studio** — Unlocks once the form is valid and an avatar exists. Generate clips per shot, one take or two in parallel. The video model is chosen server-side (see [Video generation models](#video-generation-models)); the Studio only shows which one ran. Chain from the previous clip's last frame for continuity, or restart from the avatar. Then open the final page to preview or export.

Text inputs use IME-safe wrappers (`components/TextInput.tsx`): while a composition is in progress the DOM node owns its text and the parent is not notified until `compositionend`, so re-renders cannot interrupt Chinese/Japanese/Korean input.

---

## Project history

Everything except the uploaded gameplay file is mirrored server-side under a `Project` entity, autosaved 1.5 s after any change. The header shows `Saving… / Saved HH:MM:SS / Save failed` (hover for the reason).

Saved: game title, store URL, CTA, gaming device, dialogue pacing, extra instructions, aspect ratio, layout and placement, avatar settings, **the generated avatar image**, every avatar generated for the project, full script text, the shot list including each clip's `gs://` URI, and the list of exports.

Not saved: the gameplay video. A `File` cannot be serialised, so it always has to be re-attached.

### Re-attaching the gameplay video

Picking a gameplay video normally invalidates the script and every generated clip, because the script was written from that footage. That rule would make restoring pointless — the one thing you *must* do after opening a project is re-attach the video.

So the project remembers the file's name, size and modification time. Re-attaching the same file is treated as a re-attach and keeps the script and clips; picking a different video invalidates them exactly as before. The restore banner names the file it is expecting.

Images and videos both come back through the authenticated same-origin proxy and are re-wrapped as local URLs, so a restored clip behaves exactly like a freshly generated one: playable, stitchable, and safe to draw on a canvas for last-frame extraction.

Open **History** in the header to list your projects newest-first with title, store URL, aspect ratio, clip count, export count and last-modified time. Opening one refills the form, restores the script and shot list, and turns each stored `gs://` URI back into a playable signed URL.

History is scoped by identity: `ownerEmail` comes from the IAP header, the verified ID token, or the Basic-Auth username. A request for someone else's project id returns 404, not 403 — the app does not confirm that the id exists. Deployments with no auth at all fall back to a per-browser id sent in `X-Gh-User-Id`.

---

## Exports and previews

Two export shapes, each available as **preview** or **download**. The render pipeline is identical; only delivery differs.

| | Rendering | Persisted by |
|---|---|---|
| **Streamer Only** | FFmpeg concat in the container, plus optional subtitle burn | The server, straight from its temp file (`saveToGcs` → `X-Gcs-Uri` response header) |
| **Full Mix** | FFmpeg concat, then browser Canvas/MediaRecorder composite over your gameplay, then optional server-side subtitle burn | The subtitle pass if enabled, otherwise the browser uploads the render to `POST /api/gemini/save-export` |

Preview plays the finished file inline and offers a download button; download hands you the file and shows the same preview panel. Either way the render is uploaded to `gs://<bucket>/exports/YYYY/MM/<label>-<epoch>-<uuid8>.<ext>` and recorded in project history, and the `export` activity-log row carries the `gs://` URI so the Admin dashboard can link to the file.

Persistence is best-effort by design: if the upload fails you still get your file, with a warning that it was not saved to cloud storage. Output container follows what the browser's `MediaRecorder` supports — MP4 where available, WebM/VP9 otherwise.

---

## Admin dashboard

Reachable at the **Admin** link in the footer, which only renders for admins.

- Scorecards: total generations, scripts, avatars, clips, exports, and the horizontal-to-vertical ratio
- Activity trend line chart, per model per day
- Model usage bar chart
- Sortable activity log with CSV export and per-file download

### Access control

`ADMIN_USERS` is the allowlist. Unset → falls back to `AUTHORIZED_USERS`. Both unset → `/api/admin/*` returns 403 to everyone rather than being left open:

```json
{"error":"Admin access required."}
{"error":"Admin access is disabled. Set ADMIN_USERS to enable the dashboard."}
```

The frontend learns its own status from `GET /api/me`, but the gate is enforced server-side on every `/api/admin/*` request — hiding the button is cosmetic only.

### File downloads

Clicking a file calls `/api/admin/signed-url`, which returns a 15-minute signed GCS URL. Each click mints a fresh one, so stale links are never a problem, and the bucket stays private.

Signing is restricted to `GCS_BUCKET_NAME`. A `gs://` URI pointing anywhere else is rejected, so the endpoint cannot be used to mint shareable links for arbitrary objects the service account happens to be able to read.

### Signed URL or streaming proxy?

Both exist, for different jobs, and the split is not arbitrary:

| Need | Mechanism | Why |
|---|---|---|
| Play a stored render in a `<video>` | Signed URL (`/api/media/export-url`) | Supports range requests, so the browser can seek and stream without downloading the whole file |
| Restore a clip so it can be re-exported | Streaming proxy (`/api/media/object`) → `blob:` URL | The bucket has no CORS configuration, so a cross-origin `fetch()` of a signed URL is blocked and `<video crossOrigin="anonymous">` refuses to load at all. A restored project would be watchable but impossible to stitch or to chain from a last frame |
| Show an avatar thumbnail | Streaming proxy → `blob:` URL | Same-origin, and `<img>` needs no range requests |

### Model name display

Only the first hyphen is replaced, so the vendor prefix survives: `veo-3.1-fast-generate-001` → `veo 3.1-fast-generate-001`.

---

## Data model

### Firestore in Datastore mode

**`GenerationLog`** — one row per AI call or export.

```
userId      browser-generated UUID (localStorage)
userEmail   resolved server-side from the auth mode
type        'script' | 'image' | 'video' | 'export'
model       e.g. 'gemini-3.7-flash', 'veo-3.1-generate-001', 'composite'
status      'success' | 'failed'
timestamp, _serverTime
meta        { duration?, gcsUri?, aspectRatio?, layout?, subtitles?, error? }
```

**`Project`** — one row per saved project. Indexed summary fields plus one unindexed JSON blob:

```
indexed:    ownerEmail, name, gameTitle, gameUrl, targetAspectRatio,
            layoutType, segmentCount, exportCount, hasScript,
            createdAt, updatedAt
indexed:    hasAvatar, avatarImageGcsUri
unindexed:  payload  → JSON { gameInfo, avatarConfig, scriptText, segments,
                              exports, avatarImageGcsUri, avatarHistory,
                              gameplayFileMeta }
```

The blob shape exists because Datastore caps indexed properties at 1500 bytes and `excludeFromIndexes` only accepts explicit leaf paths — naming a parent object does **not** cover its children. A base64 `avatarConfig.referenceImage` therefore failed every save with `INVALID_ARGUMENT: The value of property "referenceImage" is longer than 1500 bytes`. Keeping the working set in a single unindexed string sidesteps the whole class of problem; base64 blobs and `blob:` URLs are stripped before saving, and payloads over 900 KB are rejected with 413 (the hard entity limit is ~1 MiB).

Queries filter on `ownerEmail` only and sort in memory, so no composite index is needed. `firestore.indexes.json` in the repo is a leftover from a Native-mode design and is not deployed by anything.

**`AutopilotJob`** — one row per batch. Same indexed-summary plus unindexed-JSON
shape as `Project`, for the same reason.

```
indexed:    ownerEmail, status, variantCount, doneCount, failedCount,
            createdAt, updatedAt, veoBudget
unindexed:  spec      → JSON { brief, layout, ratio, subtitles, variantMode,
                               gameplayGcsUri, avatarPrompt, volumes }
unindexed:  avatar    → JSON { candidates[], approvedIdx[], approvedAt,
                               regenCount, source }
unindexed:  variants  → JSON [ { idx, stage, scriptSegments, clipUris[],
                                 finalUri, error, veoClips } ]
unindexed:  counters  → JSON { veoUsed }
```

Status moves `created` → `awaiting_avatar` → `running` → `completed` /
`partially_completed` / `failed`, or `cancelled` from anywhere. `awaiting_avatar`
has no timeout: it costs one Datastore row and a couple of images, and the user
may come back the next day.

### Cloud Storage

```
gs://<bucket>/videos/<epoch>-<rand6>.mp4                         generated clips
gs://<bucket>/frames/<YYYY>/<MM>/startframe-<epoch>-<uuid8>.png  clip start frames
gs://<bucket>/avatars/<YYYY>/<MM>/avatar-<epoch>-<uuid8>.png     generated avatars
gs://<bucket>/avatars/<YYYY>/<MM>/avatar-ref-<epoch>-<uuid8>.*   uploaded reference images
gs://<bucket>/exports/<YYYY>/<MM>/<label>-<epoch>-<uuid8>.<ext>  finished renders
gs://<bucket>/autopilot/uploads/<uuid>/gameplay.<ext>            Autopilot source footage
gs://<bucket>/autopilot/uploads/<uuid>/reference.<ext>           reference image for the streamer
gs://<bucket>/autopilot/uploads/<uuid>/streamer.<ext>            user-supplied streamer image
gs://<bucket>/autopilot/<jobId>/avatar-*.png                     streamer candidates
```

The bucket is private. Access is always mediated by the server: a streaming proxy, or a short-lived signed URL.

---

## HTTP API reference

Everything under `/api` except the three public endpoints requires authentication. In GIS mode that is a `Bearer` ID token; under IAP the IAP cookie or an OIDC/JWT credential; in Basic-Auth mode the standard header.

### Public

| Method | Path | Notes |
|---|---|---|
| `GET` | `/healthz` | Plain `OK`, for load balancers |
| `GET` | `/api/health` | `{status, database, env, timestamp}` |
| `GET` | `/api/config` | `{googleClientId}` — non-secret bootstrap config |
| `POST` | `/api/auth/verify` | GIS only. Body `{idToken}` → `{email, name, picture}`, or 403 if not allowlisted |

### Identity and history

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/me` | `{email, isAdmin, adminEnabled}` |
| `GET` | `/api/projects` | Caller's projects, newest first, summaries only, capped at 100 |
| `GET` | `/api/projects/:id` | Full payload. 404 if not yours |
| `POST` | `/api/projects` | Upsert; omit `id` to create. 413 if over 900 KB |
| `DELETE` | `/api/projects/:id` | 404 if not yours |
| `POST` | `/api/log` | Append a `GenerationLog` row |

### Generation

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/gemini/generate-script` | `{prompt, inlineData?, searchGrounding?}` → `{fullText, segments, groundingUrls}`. Durations are snapped to 4/6/8 s |
| `POST` | `/api/gemini/analyze-script` | `{prompt}` → re-derived shot list from an edited script |
| `POST` | `/api/gemini/generate-avatar` | `{prompt, aspectRatio, referenceImageData?, referenceImageMime?, model?}` → `{imageData, gcsUri}`. The image is uploaded to the bucket in the same request |
| `POST` | `/api/gemini/generate-video` | `{prompt, imageBase64, aspectRatio, durationSeconds, model?, resolution?}` → `{operationName, api}` |
| `GET` | `/api/gemini/video-operation?name=` | Reads a Gemini Omni interaction by id, or polls Veo via `fetchPredictOperation`. Returns `{done, videoUri}`, `{done, videoBase64}` when no bucket is configured, or a clear message when a safety filter blocked it |
| `GET` | `/api/gemini/download-video?uri=` | Streams a `gs://` or legacy HTTPS Veo URI through the server |

### Composition and delivery

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/gemini/stitch-clips` | multipart `clips[]`, `subtitleSrt?`, `saveToGcs?` → MP4 stream, `X-Gcs-Uri` header when persisted |
| `POST` | `/api/gemini/burn-subtitles` | multipart `video`, `srt`, `saveToGcs?` → MP4 stream, `X-Gcs-Uri` header |
| `POST` | `/api/gemini/save-export` | multipart `video`, `label?` → `{gcsUri}`. For renders the server never saw |
| `GET` | `/api/media/export-url?uri=&download=1` | 1-hour signed URL, own bucket only. Used by `<video>`, which cannot send an `Authorization` header. `download=1` adds `Content-Disposition: attachment` |
| `POST` | `/api/media/save-image` | `{dataUrl, label?}` → `{gcsUri}`. For images the server did not produce — the avatar reference image |
| `GET` | `/api/media/object?uri=` | Streams an object from the own bucket, same-origin and authenticated. See the note below on why this is not a signed URL |

### Autopilot — only when `AUTOPILOT_ENABLED` is set (404 otherwise)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/autopilot/config` | Limits for the UI to validate against before uploading |
| `POST` | `/api/autopilot/upload-url` | v4 signed PUT URL for the gameplay file, bound to its content type |
| `POST` | `/api/autopilot/image-upload-url` | v4 signed PUT URL for a reference or streamer image. Not scoped to a job, because the reference is chosen while the brief is being filled in |
| `POST` | `/api/autopilot/jobs` | Validate the brief, create the job, render the first streamer candidate |
| `GET` | `/api/autopilot/jobs` | Caller's batches, newest first — what the console's batch list reads |
| `GET` | `/api/autopilot/jobs/:id` | Progress, signed URLs for candidates and finished videos. Also advances the pipeline one step |
| `POST` | `/api/autopilot/jobs/:id/avatar/regenerate` | New candidate, optionally with an edited description |
| `POST` | `/api/autopilot/jobs/:id/avatar/upload-url` | Signed PUT URL for your own streamer image |
| `POST` | `/api/autopilot/jobs/:id/avatar/use-uploaded` | Adopt an uploaded image as the candidate |
| `POST` | `/api/autopilot/jobs/:id/avatar/approve` | **The only way out of the gate** |
| `POST` | `/api/autopilot/jobs/:id/tick` | Idempotent single-step advance; returns without working at the gate |
| `POST` | `/api/autopilot/jobs/:id/cancel` | Stop the batch |
| `POST` | `/api/autopilot/resume` | Sweep for stalled jobs. Skips anything at the gate |

### Admin — requires `ADMIN_USERS` membership

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/stats?from=&to=` | Activity log for the window, 120 days max |
| `GET` | `/api/admin/signed-url?uri=&download=1` | 15-minute signed URL, own bucket only. `download=1` forces a save rather than playback |

---

## Local development

```bash
npm install
```

Create a `.env` (gitignored, and excluded from both Docker and Cloud Build uploads):

```env
NODE_ENV=production
PORT=8080
GOOGLE_CLOUD_PROJECT=your-project-id
GCP_LOCATION=us-central1
DATASTORE_DATABASE=gamerhead
GCS_BUCKET_NAME=your-bucket
BASIC_AUTH_USERS=dev:devpass
ADMIN_USERS=dev
```

Authenticate ADC so the server can reach Vertex AI, Datastore and GCS:

```bash
gcloud auth application-default login
```

Then either

```bash
npm run build && npm start      # production mode: Express serves dist/
NODE_ENV=development npm run dev # Vite middleware with HMR
```

FFmpeg must be on `PATH` for stitching and subtitles (the container image installs it).

Type-check without emitting:

```bash
npx tsc --noEmit
```

Run the test suite (no extra dependencies — Node's built-in runner):

```bash
npm test
```

The compositor tests render synthetic footage and then sample the output pixels,
so they verify that things land where the geometry says rather than merely that
the code ran. ffmpeg must be on `PATH`.

### Container

```bash
docker build -t gamerheads .
docker run -p 8080:8080 --env-file .env \
  -v ~/.config/gcloud:/root/.config/gcloud gamerheads
```

`.github/workflows/docker-publish.yml` publishes an image to GHCR on pushes to `main` and on `v*.*.*` tags.

---

## Project layout

```
server.js                  Express app: auth, projects, Vertex AI proxy, FFmpeg, GCS   (~1600 lines)
index.tsx / index.html     Frontend entry
App.tsx                    Shell: auth state, autosave, history, session overlay
types.ts                   Shared types

components/
  ProjectForm.tsx          Three-step wizard
  AvatarGenerator.tsx      Avatar prompt, reference image, ratio enforcement
  Studio.tsx               Clip generation, final page, export + preview
  Autopilot.tsx            Single-page batch console (brief → confirm → results)
  ProjectHistory.tsx       History modal
  AdminDashboard.tsx       Charts, activity log, CSV, file links
  TextInput.tsx            IME-safe text field / textarea
  NeonButton.tsx           Button

services/
  auth.ts                  Token storage, refresh, session-expired event, apiFetch
  projects.ts              Project history client
  gemini.ts                Typed wrappers over /api/gemini/*
  autopilot.ts             Typed wrappers over /api/autopilot/* + direct upload
  prompts.ts               Prompt construction
  logging.ts               Fire-and-forget activity logging

utils/
  videoUtils.ts            Canvas/MediaRecorder composite, compression, frame extraction
  subtitles.ts             Shot list → SRT

lib/
  compose.js               Server-side ffmpeg compositor (port of the browser one)
  autopilot.js             Upload validation, Veo budget, bucket scoping
  autopilot-job.js         Job state machine (pure; includes the approval gate)

test/                      node:test suites; run with `npm test`

deploy.sh                  Interactive deployment / user management  (~1150 lines)
Dockerfile                 node:20-slim + FFmpeg
DEPLOYMENT.md              Deployment guide (Chinese, more operational detail)
```

---

## Cost notes

Cloud Run scales to zero (`min-instances=0`), so an idle service costs nothing. Default sizing: 2 vCPU, 2 GiB, 3600 s timeout, `max-instances=10`.

The real cost is Vertex AI. Veo is billed per generated video and dominates everything else — a single clip costs far more than a day of Cloud Run idle time, and "2 Options (Parallel)" doubles it. Gemini script and image calls are comparatively negligible. See [Vertex AI pricing](https://cloud.google.com/vertex-ai/pricing); for forecasts use the [Google Cloud Pricing Calculator](https://cloud.google.com/products/calculator).

Storage grows with every clip and export and is never pruned automatically. A lifecycle rule on the bucket is worth considering.

---

## Troubleshooting

**Cloud Build fails.** `gcloud builds list --limit=5` then `gcloud builds log BUILD_ID`. Usually the operator account is missing `roles/cloudbuild.builds.editor` or `roles/artifactregistry.writer`, or the source has a type error — run `npx tsc --noEmit` first.

**Container will not start.** `gcloud run services logs tail gamerheads --region=us-central1`. Look for a missing `GCS_BUCKET_NAME`, or `dist/index.html not found` (the build step did not run — `vite` must stay in `dependencies`, not `devDependencies`).

**`database: "disconnected"` on `/api/health`.** Confirm the database exists **in Datastore mode** (`gcloud firestore databases list`) and that the Compute SA has `roles/datastore.user`. A Native-mode database will not work with the Datastore client.

**Admin dashboard returns 403.** You are not in `ADMIN_USERS`. If the message is `Admin access is disabled`, both `ADMIN_USERS` and `AUTHORIZED_USERS` are empty — set one.

**IAP says Access denied.** You have a valid Google session but no IAM binding. List current members with `gcloud beta iap web get-iam-policy --resource-type=cloud-run --service=gamerheads --region=us-central1`. `INVALID_ARGUMENT: User xxx does not exist` when adding means the address is not a Google identity; use `domain:` for a whole domain.

**Save failed in the header.** Hover for the reason and check `gcloud run services logs read gamerheads --region=us-central1 --limit=50 | grep Projects`. A 413 means the project exceeded 900 KB — trim the script or the number of clips.

**Signed-URL request returns `URI is outside the configured application bucket`.** Intentional: signing is limited to `GCS_BUCKET_NAME`.

**Session keeps expiring.** ID tokens last about an hour and GIS silent refresh is unreliable under FedCM, so the app raises a `gh:session-expired` overlay instead of unmounting — sign in again and your work is still there. Under IAP, re-authentication needs a full page load, which the overlay offers. To lengthen IAP sessions, configure `gcloud iap settings set` with reauth settings.

**"Keep this tab active" during a Full Mix export.** Unavoidable today: the composite is produced by `MediaRecorder` in the tab, and background tabs get throttled. Backgrounding it can drop frames or stall the render.

---

## Security notes

- The GCS bucket is private. Every read goes through the server, either as a stream or as a short-lived signed URL.
- Signed-URL endpoints are hard-limited to `GCS_BUCKET_NAME`, so they cannot be turned into a generic exfiltration path for anything the service account can read.
- `/api/admin/*` is gated server-side and fails closed when no admin allowlist can be determined.
- Project reads, writes and deletes verify `ownerEmail` and answer 404 — never 403 — for other people's ids, so the endpoint does not leak which ids exist.
- Base64 images and `blob:` URLs are stripped before anything is written to Datastore.
- Under IAP, `run.invoker` is granted only to the IAP service agent. If you ever see `allUsers` in `gcloud run services get-iam-policy`, IAP is being bypassed — something re-deployed the service with `--allow-unauthenticated`.
- No API keys exist anywhere in the system. All Google AI access is ADC-based and scoped to the runtime service account.
