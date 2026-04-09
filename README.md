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

You can also force portable mode in development by setting:

```bash
AUDIO_TRACK_SELECTOR_PORTABLE=1
```

### Expected Portable Folder Layout

```text
Audio Track Selector/
├─ Audio Track Selector.exe
├─ .portable
├─ bin/
│  ├─ ffmpeg.exe
│  └─ ffprobe.exe
└─ data/
   ├─ config/      (Electron userData)
   ├─ logs/        (Electron log files)
   ├─ session/     (Chromium session data)
   └─ temp/        (extraction temp directories)
```

### Moving Between PCs

- Close the app first.
- Copy the entire app folder (including `.portable`, `bin/`, and `data/`) to another Windows PC.
- Launch `Audio Track Selector.exe` from that copied folder.

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

## Troubleshooting

- **ffprobe/ffmpeg not found**: Ensure they are on your `PATH`, or reinstall dependencies so `ffmpeg-static` and `ffprobe-static` can download the binaries.
- **Extraction fails**: Check the Details panel for the exact `ffmpeg` error message.
- **Audio out of sync**: Try pausing and resuming playback; the drift correction loop should realign audio within 250ms.

## Known Limitations

- Initial extraction may take a few seconds for long files.
- Variable frame rate sources can drift more and may require occasional resync.
- Very long recordings may need manual pause/resume to keep alignment.
- Audio extraction is always 48kHz stereo PCM for simplicity.

## License

MIT
