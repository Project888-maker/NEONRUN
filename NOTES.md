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
```
`assets/manifest.json` records model, prompt, seed and estimated cost for every generated file.

## Testing
- `npx tsx tests/physics.test.ts` — driving model telemetry
- `npx vite preview` then `node scripts/shots.mjs "http://localhost:4173/?debug&q=high&fixed" screenshots` — headless Chromium screenshots + console errors. `?fixed` makes the sim advance 1/30 s per frame so software rendering still produces representative sim time.
- URL flags: `?debug` (fps / draw calls overlay), `?q=low|med|high`, `?touch` (force touch controls), `?fixed`.

## Known issues
- See the final section of the report in the README.
