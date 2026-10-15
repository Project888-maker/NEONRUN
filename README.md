# NEON RUN

A night-time courier driving game in a rain-soaked cyberpunk megacity, in the browser.

Play the **Night Shift** story (12 missions), or free-ride delivery jobs: beat the clock, drift corners, dodge traffic and hazard drones, earn credits, buy and upgrade cars and unlock four districts: **Neon District**, **Backstreets**, **Downtown Towers** and **Industrial Docks**.

Get out of the car any time and walk the streets: talk to the people you meet, or pull a driver out of a traffic car and take it. The police take an interest: wanted stars, pursuit cruisers and, at three stars, roadblocks.

Story missions:

| # | Mission | District | Type |
| --- | --- | --- | --- |
| 1 | First Shift | Neon | Delivery |
| 2 | Last Few Meters | Neon | On foot: walk a package to a contact |
| 3 | Handle With Care | Neon → Backstreets | Fragile cargo (damage meter) |
| 4 | Borrowed Wheels | Backstreets | Steal a specific car |
| 5 | Shadow | Backstreets | Tail a van without being seen |
| 6 | Sideways | Backstreets | Drift score attack |
| 7 | Executive Ride | Downtown | VIP passenger (comfort meter) |
| 8 | Glass Canyon | Downtown | Checkpoint time trial |
| 9 | Hot Package | Downtown | Deliver with the police on you |
| 10 | Fog Run | Docks | Security drones |
| 11 | Clean Getaway | Docks | Escape four stars |
| 12 | Last Run | All | Finale: three stops, police and drones |

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
| E / F | Get out · get in · steal a car |
| T | Talk to someone (on foot) |
| Mouse / Q | Look around on foot (click to capture the mouse) |
| Shift (on foot) | Run · Space jumps |
| Enter / F | On a mission result: next / free ride |
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
- **People**: photoreal T-pose characters (image → Meshy 3D), auto-rigged with Meshy, animated with Meshy walk/run clips plus text-to-motion clips (Hunyuan Motion) retargeted in Blender; voiced street conversations (ElevenLabs).
- **Cars**: eight generated traffic cars (image → Tripo 3D), cleaned and wheel-split in Blender, every one drivable.
- **Assets**: fal.ai for textures, signage, ads, sky, UI, liveries, image-to-3D cars, people and landmarks, video, music, SFX, mission art and all voices. Blender (bpy, headless) for the city kit and hero car cleanup; gltf-transform for compression. See `assets/manifest.json` (prompt, model, seed and cost per file) and `NOTES.md`.
