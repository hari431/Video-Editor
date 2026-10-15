# BrowserVideoStudio

A standalone, local-first web app for **video editing** (primary) and **screen
recording** (secondary). It is a focused extraction of a much larger project:
only the editor, the in-browser screen recorder and the EDL evidence panel are
retained.

Files are processed on the machine running the server using a local FFmpeg
install. Uploads are written to a temporary directory, rendered, streamed back
as a fresh download, then deleted. Nothing is sent to a remote service.

## Requirements

- Node.js 22+
- FFmpeg on your `PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH` set)

## Setup

```
copy .env.example .env
npm install
npm start
```

Then open http://localhost:3000 and sign in with the `APP_PASSWORD` you set in
`.env`. If `APP_PASSWORD` is left blank the app runs unprotected (local use
only).

## Using it

- `/` — landing page with the two entry points.
- `/editor` — the video editor: trim, crop, overlay text/images/video, blur,
  zoom, watermark, mix audio tracks, and export an MP4.
- `/recorder` — the screen recorder: capture a screen/window/tab with optional
  microphone audio, then finalize it to MP4 (or send it to the editor).

On a successful export the browser downloads an MP4. The screen recorder can
finalize its capture to `screen-recording.mp4`.

## Configuration

See `.env.example`. The relevant variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 3000) |
| `APP_PASSWORD` | Password for the local sign-in gate |
| `SESSION_SECRET` | Cookie-signing secret |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Absolute paths if FFmpeg is not on `PATH` |
| `VIDEO_EDITOR_FONT` | `.ttf` used for text overlays / watermark |
| `VIDEO_EDITOR_MAX_VIDEO_MB` | Max upload per video (default 2048, max 8192) |
| `VIDEO_EDITOR_ENABLED` | Set `false` to disable export endpoints |

## Tests

```
npm test
```

The retained suites cover the editor project math, spec/FFmpeg-argument
builders, the screen-recorder helpers and EDL evidence validation.

## Project layout

```
src/
  app.js                 Express bootstrap (static, session, routes)
  auth/local.js          Local password gate + in-memory session
  video/routes.js        HTTP routes (editor, recorder, EDL, export)
  video/ffmpeg.js        Local ffmpeg/ffprobe helpers
  library/video-editor.js  Spec validation + FFmpeg argument builders
  library/edl-evidence.js  EDL evidence validation + spec conversion
  public/                Browser assets (editor, recorder, styles)
  views/                 EJS templates (admin-video-editor.ejs, landing.ejs)
tests/                   node:test suites
```
