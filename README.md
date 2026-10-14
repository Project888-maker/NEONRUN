# NEON RUN

A night-time courier driving game in a rain-soaked cyberpunk megacity, in the browser.

Take delivery jobs, beat the clock, drift corners, dodge traffic and hazard drones, earn credits, upgrade the car and unlock four districts: **Neon District**, **Backstreets**, **Downtown Towers** and **Industrial Docks**.

Everything is original: the city, brands, signage and the car are generated or modelled for this project. No real manufacturers or franchises appear.

## Play
```
npm ci
npm run dev        # http://localhost:5173
npm run build && npm run preview
```

| Key | Action |
| --- | --- |
| W / ↑ | Throttle |
| S / ↓ | Brake / reverse |
| A D / ← → | Steer |
| Space | Handbrake (drift) |
| Shift / N | Boost |
| C | Camera (chase / far / hood) |
| R | Reset car |
| M | Big map |
| Esc / P | Pause |

Gamepads and touch (on phones and tablets) are supported.

URL flags:
- `?q=low|med|high` forces graphics quality (otherwise auto-detect plus adaptive downgrade).
- `?debug` shows fps and draw calls.
- `?touch` forces touch controls.

## How it's built
- **Engine**: three.js (WebGL2) + Vite + TypeScript.
- **Physics**: Rapier WASM rigid body driven by a custom 4-wheel raycast vehicle (suspension, slip-angle tires, friction circle, RWD, handbrake, ABS, drift assists).
- **Rendering**:
  - planar wet-road reflections with roughness blur and streaks
  - neon light pools in the ground shader
  - instanced procedural city with AI-generated night facades and signage atlases
  - live cube-map reflections on the car paint
  - bloom, SSAO, ACES, film grain, chromatic aberration, vignette, SMAA
  - lens rain and speed blur
  - GPU rain, splashes and particles
- **Assets**: fal.ai for textures, signage, ads, sky, UI, liveries, image-to-3D car and landmarks, video, music, SFX and dispatcher voice. Blender (bpy, headless) for the city kit and hero car cleanup; gltf-transform for compression. See `assets/manifest.json` (prompt, model, seed and cost per file) and `NOTES.md`.
