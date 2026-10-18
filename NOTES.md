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
- **Feedback round (gait, police, startup, touch)**:
  - Walk/run playback rate is derived from each clip's measured ground speed: how fast the foot on the floor moves back relative to the hips (`gaitSpeeds` in `people.ts`). So the planted foot stays put; traces show it holding within 2 cm (walk) and 4–10 cm (run) while down. The hero's run is 4.4 m/s to match the generated jog clip.
  - Foot grounding keeps the lower foot at the bind-pose ankle height (the retargeted clips floated about 8 cm).
  - Characters are lit by the same neon light pools as the street, plus the real point lights, which follow the hero on foot. They also have a contact shadow.
  - Get in / get out is a scripted door↔seat move. The body turn baked into the generated clips is measured per clip (`heading()`) and compensated, so the hero never spins around outside the car.
  - The idle clip was regenerated: the first one swayed about ±14°.
  - Police hold a slot behind the player and never drive into the car; kinematic contact used to launch it. They also no longer orbit junctions: the route used to start at a node already behind the cruiser. `tests/police.test.ts` checks they close to under 12 m on a stopped player but never under 5.5 m, and keep following a moving one. The car also has an anti-rollover assist (`tests/rollover.test.ts`).
  - Startup: shaders are compiled for every character, car and the police before the title, and one full frame is rendered behind the loading screen. Full-detail cars stream in after the title. Every download has a timeout, and a lost WebGL context reloads one quality step lower.
  - The car reflection probe renders one cube face per frame instead of all six every few frames, which removed the periodic hitch.
  - Touch layout: sized in vmin with safe-area insets, separate driving and on-foot button sets, context buttons only when usable, and a rotate prompt for phones held upright. `scripts/shots_mobile.mjs` checks phone and tablet sizes and reports overlapping controls.
- **Feedback round 2 (idle twist, character look, rain)**:
  - The "tilting" on phones was the hero turning toward tiny joystick movements from a resting thumb. Sticks now have a radial dead zone, and the hero only turns for a real input.
  - Retargeting now aligns each limb segment's rest direction before copying rotations. The generated T-pose has legs spread and arms out, while the motion skeleton stands with legs together; without the alignment every clip kept a wide straddle and stiff arms.
  - Character lighting from the neon pools uses a very soft wrap and is half desaturated: the bumpy normals of generated meshes turned a hard N·L into green/red blotches. The hero ships at full geometry with a 2048 texture.
  - Rain was rebuilt (`Rain` in `weather.ts`):
    - the old rain was 1-px lines falling at 26 m/s with 0.75 m streaks and one flat colour, which looked like running water
    - drops are now camera-facing streaks falling at 7–9.5 m/s, as long as the drop travels in a ~1/30 s exposure relative to the viewer: short when standing, long and slanted at speed
    - each drop is lit by the nearby light pools (signs, lamps, headlights), so rain glows near light and fades in the dark
    - the streak quads are double-sided: a falling drop's tail sits above its head, which flips the winding, so with back-face culling nothing was drawn
- **Freeze on Story with a livery** (fixed): starting a mission re-applies the car's customisation. Removing the old livery decal (a group of meshes) called `.geometry.dispose()` on the group, which threw. That left the mission half-started, and every frame then threw too: a frozen picture with only the music playing. The livery removal now disposes each child mesh. A mission start can no longer be left half-done, and the frame loop catches errors, keeps rendering and shows a short on-screen note instead of freezing.
- **Tap lag / "glitch" on Story, Play and garage taps** (fixed; the browser's INP warning blamed 240 ms of input handling): every customisation tap re-projected the livery decals. `DecalGeometry` walks every body triangle three times, which took 170–290 ms on the main thread. The projection now runs once per car model in a Web Worker (`src/vehicle/decalWorker.ts`), and the result is shared by every instance and every tap. The livery material is shared per texture, and its shader (plus the drone's) is compiled during warm-up.
- **Drones** (reworked; the old ones were faster than the car at 44 m/s and homed in forever): `Drone` in `src/world/ambient.ts` is a state machine:
  - **patrol** a post along the route
  - **chase** when the player comes within 60 m, at no more than 19 m/s (68 km/h)
  - **give up** after 3 s more than 110 m away, then fly home
  - **strike** only after holding a lock within 8 m for 0.8 s, shown by a red targeting laser and speeding-up beeps
  - **retreat** for 6 s after a strike

  Free-ride drones start at 4 deliveries (was 2), at most 2 per job (was 3). `tests/drones.test.ts` checks that a car at 108 km/h escapes, a parked car gets the warning first, and strikes are at least 6 s apart.
- **Asset caching**: `vercel.json` used to mark all of `/assets/` as cacheable for a year (`immutable`). That suits Vite's hashed code chunks, but models, sounds and textures in `public/assets` keep fixed names, so players' browsers kept old versions (e.g. the first hero model with the swaying idle) after updates. Now every asset URL carries a content fingerprint (`?v=<md5>`):
  - `vite.config.ts` hashes `public/assets` at build time and versions the references in `index.html`
  - `src/core/version.ts` does the same for runtime loads
  - only `.js`/`.css`/`.wasm` stay immutable; other assets revalidate daily
- **Results card on phones**: compact layout for short screens, with buttons always on screen. The phone check finishes mission 1 and taps "Next mission".
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
- `npx tsx tests/rollover.test.ts` — hard knocks must end on the wheels (fails without the anti-rollover assist)
- `npx tsx tests/police.test.ts` — pursuit closes in, boxes the player, never touches the car
- `npx tsx tests/drones.test.ts` — drones can be outrun by car, warn before striking, back off after a hit
- `npx tsx tests/npc.test.ts` — NPC personas, the /api/talk function and the client stream
- `node scripts/shots.mjs <url> <dir> stride` — prints both hero feet per frame while walking and running; a planted foot must hold its position for several frames
- `node scripts/shots.mjs <url> <dir> gait` / `police` — get in/out frames; police pressure (closest cruiser distance, car stays upright)
- `npx vite preview` then `node scripts/shots.mjs "http://localhost:4173/?debug&q=high&fixed" screenshots [scenarios]` — headless Chromium screenshots + console errors. Scenarios include `drive`, `cars`, `foot` (exit, walk, talk, carjack) and `story` (teleports through every mission; `STORY=m1,m4` limits it). `?fixed` makes the sim advance 1/30 s per frame so software rendering still produces representative sim time.
- URL flags: `?debug` (fps / draw calls overlay), `?q=low|med|high`, `?touch` (force touch controls), `?fixed`, `?allmissions` (open every story mission).

## NPC brain
The plan is in `docs/npc-brain.md`. Phase A (talking to anyone) is built; phases B–D (bark library, tasks from people, interiors, lip sync) are not.

**Personas** — `src/npc/persona.ts`
- Every pedestrian gets a seeded card from its spawn id and model type: name, age, job, five temperament sliders, mood, quirk, goal, fear and speech style.
- No model call is needed. The same person always gets the same card.

**Server** — `api/talk.ts`
- Calls Claude Haiku 5.5 with no thinking and low effort, for the fastest first words.
- Uses a cached shared world prompt (`WORLD_RULES` in `src/npc/protocol.ts`) and a structured reply: line, emotion, gesture, action, three suggested courier replies, and a memory note.
- Streams NDJSON events (`TalkEvent`).
- Same-origin only, 40 lines per IP per 5 minutes, and inputs are clipped (`sanitizeRequest`).
- The key comes from `ANTHROPIC_API_KEY` in the Vercel project environment; the SDK also honours `ANTHROPIC_BASE_URL`. Without a key the function answers `no_key` and the game uses the recorded street lines.
- `vite.config.ts` serves the same function from `vite` / `vite preview`, so it works locally with the key exported in the shell.

**Game** — `src/npc/conversation.ts`
- **T** near someone opens the talk panel: three suggested replies (keys 1–3), a text box, hold-to-talk speech input where the browser has it, and **Esc** to leave.
- Camera and bodies: an over-the-shoulder two-shot; both turn to face each other; neck/head look-at (`Person.look`) and head motion while speaking (`Person.speak`); the reply's gesture plays.
- Actions: `end` (walks off), `flee`, `call_police` (one wanted star after 2.5 s).
- What the person is told (`convFacts()`): district, rain, wanted level, the courier's car nearby, and recent events within 70 m and 2 minutes (carjack, hitting a pedestrian).
- Each person remembers the last 16 lines and up to 6 notes for the session.
- Voices: the device's speech voices, with pitch and rate per persona. Settings → "People's voices" switches to subtitles only.

**Limits**
- The character models have no jaw or face bones, so mouths don't move; that is phase D.
- Memory is per spawned pedestrian for the session; recurring characters are phase B.

**Tests**
- `npx tsx tests/npc.test.ts`: persona variety, prompt and limits, the server stream with a fake model client, the 403/400/429/503 paths, client streaming and the offline fallback.
- `node scripts/shots.mjs <url> <dir> converse`: in-game with a stand-in `/api/talk`.

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
- Hazard drones fly over buildings without obstacle avoidance; they cruise at 26 m, above most rooftops, but can clip the towers downtown.
- Traffic uses a fixed population around the player and kinematic bodies: cars stop when hit, but they aren't knocked around.
- Audio was verified to load and decode without errors, but couldn't be listened to here. Engine loop crossfade points are tuned by ear-less heuristics.
- In the artifact build it is unknown whether the sandbox CSP permits WebAssembly compilation (Rapier). If the artifact hangs on "Loading", use `npm run preview` locally or the Vercel route above.
- Rain intensity, fog density and bloom were tuned only on screenshots.
- People are image-to-3D: hands and faces are good at street distance but soft up close. Gait playback matches movement speed, but there is no true foot IK, so a planted foot can still creep a few centimetres per step.
- Pedestrians walk the sidewalk loops around blocks and don't cross roads. Cars knock them down, but there is no ragdoll.
- The tailed van and police cars are kinematic and pass through traffic cars instead of crashing into them; the van stops behind traffic directly ahead.
- Story missions were verified by a teleporting playthrough in headless Chromium, not played end to end at real speed, so timers may need tuning.
