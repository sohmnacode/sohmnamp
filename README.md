# SOHMNA — Cosmic Audio Visualizer

## Building the macOS .dmg

### Prerequisites

1. **Node.js** (v18 or later): https://nodejs.org
2. **macOS** (required for .dmg builds)

### Quick Build (3 commands)

```bash
# 1. Install dependencies
npm install

# 2. Build the .dmg
npm run build:mac:dmg

# 3. Find your .dmg
open dist/
```

Your `SOHMNA-4.0.0.dmg` will be in the `dist/` folder. Double-click to mount, drag SOHMNA to Applications, done.

---

### Build Options

| Command                    | Output                              |
|----------------------------|-------------------------------------|
| `npm run build:mac:dmg`    | macOS .dmg (universal)              |
| `npm run build:mac:arm`    | Apple Silicon (M1/M2/M3/M4) only   |
| `npm run build:mac:intel`  | Intel Mac only                      |
| `npm run build:mac:universal` | Fat binary (both architectures)  |
| `npm run build:win`        | Windows installer (.exe)            |
| `npm run build:linux`      | Linux AppImage + .deb               |

### Development

```bash
# Run the app without building
npm start

# Run with DevTools logging
npm run dev
```

---

### App Icon (Optional)

The build will work without a custom icon (it'll use the Electron default). To add your own:

1. Create an `assets/` folder in the project root
2. Add your icon files:
   - `icon.icns` — macOS (1024x1024, use `iconutil` to generate)
   - `icon.ico` — Windows
   - `icon.png` — Linux (512x512)
3. Optionally add `dmg-background.png` (660x440) for a custom installer background

**Quick icon generation on macOS:**

```bash
mkdir assets
mkdir icon.iconset
sips -z 1024 1024 your-image.png --out icon.iconset/icon_512x512@2x.png
sips -z 512 512 your-image.png --out icon.iconset/icon_512x512.png
sips -z 256 256 your-image.png --out icon.iconset/icon_256x256.png
sips -z 128 128 your-image.png --out icon.iconset/icon_128x128.png
iconutil -c icns icon.iconset -o assets/icon.icns
cp your-image.png assets/icon.png
rm -rf icon.iconset
```

---

### Keyboard Shortcuts

| Key         | Action                    |
|-------------|---------------------------|
| Space       | Play / Pause              |
| ←  →        | Previous / Next track     |
| V           | Cycle visualization mode  |
| F           | Toggle fullscreen         |
| Escape      | Exit fullscreen           |

### Visualization Modes

Nebula · Galaxy · Supernova · Cosmos · Stardust · Crystal · Aurora · Stars · Wave

All render at native resolution (up to 4K+) with real-time audio reactivity.

---

### Tech Stack

- **Electron** — Native desktop shell
- **Three.js** (r128) — 3D WebGL rendering
- **Web Audio API** — Real-time frequency analysis
- **Custom GLSL shaders** — All particle systems and geometry

### Troubleshooting

**"App is damaged" on macOS:**
```bash
xattr -cr /Applications/SOHMNA.app
```

**No audio on first play:**
macOS requires a user gesture before allowing AudioContext. Click play — it will work.

**Build fails on Apple Silicon:**
Make sure you have Rosetta installed: `softwareupdate --install-rosetta`
Or just use `npm run build:mac:arm` for a native ARM build.
