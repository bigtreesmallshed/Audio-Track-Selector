# Audio Track Selector

Audio Track Selector is a desktop media player that can play a video file while mixing multiple embedded audio tracks simultaneously. It is tailored for OBS recordings where game audio, voice chat, and microphone audio are stored as separate tracks.

## Features

- Open local MP4 or MKV files.
- Probe embedded audio streams with metadata (stream index, codec, channels, sample rate, bitrate, tags).
- Enable multiple audio tracks at the same time.
- Per-track volume (0%–200%) and mute controls.
- Video playback via HTML5 `<video>` (always muted).
- Audio extracted to temporary WAV files and mixed via the Web Audio API.
- Play/pause, seek, timecode display, and playback rate controls.
- Drift correction every 250ms to keep audio streams synced to the video clock.
- Detailed log panel for troubleshooting.

## Tech Stack

- Electron + React + TypeScript + Vite
- `ffprobe` for stream metadata
- `ffmpeg` for audio extraction

## Project Structure

```
/main      Electron main process and preload scripts
/renderer  React UI and Web Audio mixer
/shared    Shared TypeScript types
```

## Getting Started

### Install

```bash
npm install
```

### Run in Development

```bash
npm run dev
```

This starts the Vite dev server and Electron shell.

### Build for Production

```bash
npm run build
npm run package
```

The packaged app will be emitted to `dist/` (`zip` portable bundle for Windows, DMG for macOS, AppImage for Linux).

### Build Windows Portable Bundle

```bash
npm run package:win-portable
```

This produces a `dist/*win*.zip` bundle containing a runnable `win-unpacked/` folder instead of an installer.

## Portable Windows Distribution

Portable mode is enabled only when all of these are true:

- running a packaged build on Windows
- and a `.portable` marker file (or `portable-mode.json`) exists next to the app `.exe`
- and the app can create/write `data/config`, `data/logs`, `data/session`, and `data/temp`

You can also force portable mode in development by setting:

```bash
AUDIO_TRACK_SELECTOR_PORTABLE=1
```

### Expected Portable Folder Layout

```text
Audio Track Selector/
└─ win-unpacked/
   ├─ Audio Track Selector.exe
   ├─ .portable                      (create this next to the .exe)
   ├─ bin/                           (optional override location for ffmpeg/ffprobe)
   │  ├─ ffmpeg.exe
   │  └─ ffprobe.exe
   ├─ data/
   │  ├─ config/                     (Electron userData)
   │  ├─ logs/                       (Electron log files)
   │  ├─ session/                    (Chromium session data)
   │  └─ temp/                       (extraction temp directories)
   └─ resources/
      └─ bin/                        (packaged default location for ffmpeg/ffprobe)
         ├─ ffmpeg.exe
         └─ ffprobe.exe
```

Binary resolution order is:
1. `<exe folder>/bin` (portable override),
2. `<exe folder>/resources/bin` (packaged default),
3. `ffmpeg-static` / `ffprobe-static`,
4. system `PATH`.

At startup, the app logs the resolved portable mode state and checks that resolved ffmpeg/ffprobe binaries are readable. If a binary cannot be started, the error now includes every lookup location that was checked.

### Moving Between PCs

- Close the app first.
- Copy the entire `win-unpacked/` folder (including `.portable`, `resources/bin/`, and `data/`) to another Windows PC.
- Launch `Audio Track Selector.exe` from the copied `win-unpacked/` folder.
- Preferred: launch from a local drive folder (for example `C:\Apps\Audio Track Selector\win-unpacked\`).
- Network-share (`\\SERVER\Share\...`) launches may work, but Windows/Electron security policy can still block renderer file loading on some systems. If you hit a renderer load error, copy the portable folder locally and run it there.
- Avoid launching portable mode from protected folders (for example `C:\Program Files`) because Windows may block writes to `data/`.
- If portable mode is requested but `data/*` is not writable, the app logs a warning and falls back to standard (non-portable) Electron data paths.

### Tradeoffs vs Single-EXE Packaging

- Folder-based distribution is easier to inspect and replace binaries (`bin/ffmpeg.exe`, `bin/ffprobe.exe`).
- No installer means no Start Menu shortcuts or automatic uninstaller.
- Portable mode keeps app state with the app folder, which is ideal for move/copy workflows but can grow in size over time.

## Temp Files

Each session creates a temporary directory named:

```
audio-track-selector-<random>
```

Location depends on mode:

- portable mode: `<app folder>/data/temp/`
- non-portable mode: OS temp directory

It is cleaned up when:

- the app closes
- a new file is opened
- the renderer requests cleanup
- stale `audio-track-selector-*` temp directories older than 48 hours are pruned on startup (best effort)

## Troubleshooting

- **ffprobe/ffmpeg not found**: Ensure they are on your `PATH`, or reinstall dependencies so `ffmpeg-static` and `ffprobe-static` can download the binaries.
- **Extraction fails**: Check the Details panel for the exact `ffmpeg` error message.
- **Audio out of sync**: Try pausing and resuming playback; the drift correction loop should realign audio within 250ms.
- **Renderer load failure on network share**: The app now logs the resolved packaged `index.html` path, existence check, and final file URL. If this still fails from `\\SERVER\Share\...`, run the same `win-unpacked/` folder from a local path instead.

## Known Limitations

- Initial extraction may take a few seconds for long files.
- Variable frame rate sources can drift more and may require occasional resync.
- Very long recordings may need manual pause/resume to keep alignment.
- Audio extraction is always 48kHz stereo PCM for simplicity.

## License

MIT
