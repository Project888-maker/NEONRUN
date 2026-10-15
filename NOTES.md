# NEON RUN — development notes

Living document: decisions, known issues, and how to rebuild every asset.

## Stack
- three.js 0.186 (WebGL2) + Vite 8 + TypeScript
- Rapier 0.21 (`@dimforge/rapier3d-compat`, WASM) — custom raycast vehicle on a Rapier rigid body
- `postprocessing` 6 (bloom, ACES tone mapping, chromatic aberration, film grain, vignette, SMAA) + `n8ao` (SSAO, High only)
- Web Audio (custom engine model, HRTF spatial emitters); Howler was not needed
- Blender 5.2 headless via the `bpy` PyPI module (`/opt/bpyenv`)

## Decisions
- **Vehicle physics**: Rapier's built-in `DynamicRayCastVehicleController` uses the Bullet friction model, which is twitchy for drifting. Instead `src/vehicle/vehicle.ts` raycasts 4 wheels against the Rapier world and applies suspension and tire impulses to the Rapier rigid body:
  - Pacejka-style lateral curve, friction circle and RWD power oversteer
  - handbrake rear-grip drop, ABS
  - stability control, drift angle limiter and drift speed keeper (arcade assists)

  Tuned with the headless test `npx tsx tests/physics.test.ts`.
- **Wet road reflections**: a planar reflector (half res, mipmapped HDR target) sampled by the road shader, with roughness-based mip blur and vertical streak taps for the elongated neon reflections, plus Fresnel and puddle masks. SSR was rejected: it is noisier and more expensive, and planar reflection is exact for a flat city.
- **Light pools**: hundreds of neon signs and lamps can't be real lights in forward rendering. Instead:
  - the 40 most relevant light sources are uploaded each few frames as a uniform array the ground shader uses for diffuse pools and wet specular streaks
  - the 2–6 strongest near the car also drive real `PointLight`s, so the car paint picks up the neon
- **Volumetric look**: exponential fog, layered haze sprites, additive light cones under lamps and headlights, fullscreen lens rain/droplets and speed blur effect.
- **City**: procedural (seeded) 16×16 block grid in four districts. Buildings are instanced unit boxes whose shader tiles AI-generated night facade textures in world space and derives lit-window emission from the texture brightness, with per-window on/off variation. Signs, shopfronts and ads use instanced quads over texture atlases (one draw per chunk per atlas). Chunks are 2×2 blocks; small props are culled beyond 190 m and skipped in the reflection pass.
- **Models**: the city kit (props, traffic cars, rail, hero wheel) is built in code with bpy (`blender/citykit.py`). The hero car is image-to-3D (Tripo H3.1) from a generated concept, then cleaned in Blender (`blender/hero_car.py`):
  - re-oriented and scaled to 4.8 m
  - baked wheels cut out and arch liners added
  - emissive light strips placed by ray casting
  - wheel empties exported

  Landmarks are Trellis-2 image-to-3D.
- **Traffic cars** (`blender/process_car.py <id> --length L`): Tripo H3.1 image-to-3D from a gpt-image-2 concept. The script orients the car (front −Y), scales it to a real length, finds the four wheels from the histogram of the lowest vertices, splits each baked wheel into its own object with the origin at the hub, adds arch liners and writes `public/assets/cars/<id>.json` (dims and wheel positions in game space). A `_lod` copy (25 % triangles, 512 px) is used for traffic and police; the full model is used when you drive it. Head, tail and brake lights are an emissive mask computed in the shader from the texture brightness and the position along the car.
- **People** (`blender/build_people.py <id>`): a gpt-image-2 T-pose photo becomes a Meshy v6 model, then `fal-ai/meshy/rigging` gives a 24-joint skeleton plus walk/run clips. Eleven more clips (idle, jump, enter/exit car, talk, wave, flee, phone, shrug, push, fall) are Hunyuan Motion SMPL-H FBX files. They are retargeted onto the Meshy skeleton by world-space rotation transfer, with hips height from the first frame scaled by leg length. Export uses `export_animation_mode='ACTIONS'`: exporting NLA tracks while they were muted produced two-key static clips, which looked like a T-pose in game.
- **On foot**: Rapier kinematic character controller (capsule, autostep, snap to ground); camera-relative movement; enter/exit sequences use the generated clips. Stealing a traffic car swaps its instanced LOD for a full drivable car, ejects a pedestrian driver who falls and runs, and adds wanted stars.
- **Police**: wanted level 0–5, up to four kinematic cruisers routed by A* on the road graph (direct pursuit within 38 m), roadblocks at junctions ahead of the player from three stars. Busted after a few seconds stopped next to a cruiser; stars drop every 12 s spent more than 95 m from all police.
- **Story** (`src/game/campaign.ts`): twelve missions built from reusable steps (go to, stop, on-foot, interact, tail, gates, drift, escape) plus per-mission meters (cargo, comfort, distance, drift). Mission positions snap to the nearest shopfront spot of the seeded city, so they are stable. Lines are in `scripts/story.mjs`, which feeds both the TTS spec and `story.json` (subtitles).
- **Textures**: KTX2 needs the external `toktx` binary, which is not installable here, so textures are WebP (gltf-transform `--texture-compress webp`) and geometry is meshopt-compressed.

## Rebuilding assets
```
npm run gen:fal        # fal.ai generation (skips anything already in assets/manifest.json); needs FAL_KEY or the proxy
npm run gen:textures   # process raw images -> public/assets (seamless PBR, facades, atlases, UI)
node scripts/icons.mjs # recraft SVG icons -> PNG
./scripts/media.sh     # ffmpeg: music/sfx/voice loudness + mp3, videos -> H.264 720p/480p
/opt/bpyenv/bin/python blender/citykit.py   # city kit GLB
/opt/bpyenv/bin/python blender/hero_car.py  # hero car cleanup
./scripts/optimize_models.sh                # gltf-transform meshopt + webp
/opt/bpyenv/bin/python blender/process_car.py car_taxi --length 4.7   # one per car (lengths in the script header)
/opt/bpyenv/bin/python blender/build_people.py hero                    # one per character
node scripts/story_json.mjs                 # campaign subtitles
```
`assets/manifest.json` records model, prompt, seed and estimated cost for every generated file.

## Testing
- `npx tsx tests/physics.test.ts` — driving model telemetry
- `npx vite preview` then `node scripts/shots.mjs "http://localhost:4173/?debug&q=high&fixed" screenshots [scenarios]` — headless Chromium screenshots + console errors. Scenarios include `drive`, `cars`, `foot` (exit, walk, talk, carjack) and `story` (teleports through every mission; `STORY=m1,m4` limits it). `?fixed` makes the sim advance 1/30 s per frame so software rendering still produces representative sim time.
- URL flags: `?debug` (fps / draw calls overlay), `?q=low|med|high`, `?touch` (force touch controls), `?fixed`, `?allmissions` (open every story mission).

## Deployment
- GitHub: branch `claude/keen-thompson-j8ie3f` of Project888-maker/NEONRUN.
- **Vercel**: https://neonrun-nine.vercel.app/ (the owner imported the repo in the dashboard; pushes to the branch redeploy). The connector itself still has no project-creation rights.
- **Fallback**: a private playable build is published as a claude.ai artifact (`node scripts/artifact.mjs` builds `dist/artifact.html`). Artifacts don't serve `.glb`, so models ship as base64 JSON and the loader falls back to it.

## fal.ai spend
About **$40.74** of the $55 budget ($25 at launch plus a ~$30 top-up), estimated from the per-model prices in `scripts/assets.mjs`. fal returns billable units but not a dollar cost. There are 349 manifest entries. Stage 1 cost about $15.67; cars, people, motion, voices, mission art and new music cost the rest.

Requests that failed or were replaced:
- `ad_pills` was blocked by the content filter and replaced with `ad_umbrella`.
- Three SFX failed the 0.5 s minimum duration and were regenerated longer.
- Two car concepts were too close to real production cars. They were regenerated as original designs; the first images are kept as `_rejected` and not used.

## Known issues
- FPS on real GPUs is unmeasured. The container only has SwiftShader (CPU WebGL), which runs at 0.3–1.5 fps here.

  Scene cost per frame:

  | View | Draw calls | Triangles |
  | --- | --- | --- |
  | Street level | 300–700 (+ reflection pass) | 0.25–0.75M |
  | Long avenue on High | up to ~1,500 | ~1.9M |

  Adaptive quality drops High → Med → Low below 38 fps. If a mid laptop struggles, the first levers are `reflectionEvery` and `viewDistance` in `src/core/quality.ts`.
- The hero car is image-to-3D. Its underside has some generated "fins" behind the rear wheels, and its texture is baked, so paint colours are tints over the baked gunmetal.
- The physics wheels use the same positions as the model, but tire grip is arcade-tuned, not simulation.
- Hazard drones are simple pursuers (no obstacle avoidance) and can clip through buildings.
- Traffic uses a fixed population around the player and kinematic bodies: cars stop when hit, but they aren't knocked around.
- Audio was verified to load and decode without errors, but couldn't be listened to here. Engine loop crossfade points are tuned by ear-less heuristics.
- In the artifact build it is unknown whether the sandbox CSP permits WebAssembly compilation (Rapier). If the artifact hangs on "Loading", use `npm run preview` locally or the Vercel route above.
- Rain intensity, fog density and bloom were tuned only on screenshots.
- People are image-to-3D: hands and faces are good at street distance but soft up close. Retargeted motion has no foot locking, so feet can slide slightly at some walk speeds.
- Pedestrians walk the sidewalk loops around blocks and don't cross roads. Cars knock them down, but there is no ragdoll.
- The tailed van and police cars are kinematic and pass through traffic cars instead of crashing into them; the van stops behind traffic directly ahead.
- Story missions were verified by a teleporting playthrough in headless Chromium, not played end to end at real speed, so timers may need tuning.
