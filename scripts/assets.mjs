// NEON RUN asset specification. Every generated asset is declared here so the
// whole set is reproducible: `NODE_USE_ENV_PROXY=1 node scripts/fal.mjs`.
// Prices are conservative USD estimates (fal does not return cost per request).

const mp = (w, h) => Math.max(1, Math.ceil((w * h) / 1048576));
export const PRICES = {
  'fal-ai/flux-2-pro': (i) => {
    const s = typeof i.image_size === 'object' ? i.image_size : { width: 1024, height: 1024 };
    return 0.03 + 0.015 * (mp(s.width, s.height) - 1);
  },
  'fal-ai/nano-banana-2': 0.08,
  'fal-ai/gpt-image-2': 0.1,
  'fal-ai/recraft/v4/text-to-image': 0.04,
  'tripo3d/h3.1/image-to-3d': 0.6,
  'fal-ai/trellis-2': 0.3,
  'fal-ai/kling-video/v2.5-turbo/pro/text-to-video': (i) => 0.07 * Number(i.duration || 5),
  'fal-ai/kling-video/v2.5-turbo/pro/image-to-video': (i) => 0.07 * Number(i.duration || 5),
  'fal-ai/elevenlabs/music': (i) => 0.8 * (i.music_length_ms / 60000),
  'fal-ai/elevenlabs/sound-effects/v2': 0.03,
  'fal-ai/elevenlabs/tts/eleven-v3': (i) => Math.max(0.01, (i.text.length / 1000) * 0.1),
};

const A = [];
const add = (group, name, model, input) => A.push({ id: `${group}/${name}`, group, name, model, input });

// ---------- 1. Tileable PBR material albedos (normal/roughness derived in scripts/textures.py)
const TEX = 'seamless tileable texture, orthographic top-down view, flat even diffuse lighting, no shadows, no perspective, no vignette, photorealistic PBR albedo, ultra detailed, 4k scan';
const tex = {
  asphalt: 'wet black asphalt road surface at night, small shallow puddles, fine aggregate stones, hairline cracks, subtle oil stains',
  roadlines: 'worn asphalt road with a single straight faded white painted lane stripe running vertically through the center, rain wet, paint chipped',
  concrete: 'weathered grey city concrete sidewalk slab, rain stains, small chips, grime, subtle seams',
  brushed_metal: 'brushed stainless steel panel, fine directional brushing, light scratches, faint fingerprints',
  rusted_metal: 'rusted corrugated steel shipping container wall, peeling paint, orange rust streaks, rain streaks',
  glass_grime: 'dirty window glass surface, dried rain droplets, dust and grime streaks, smudges, translucent grey',
  brick: 'old dark red brick wall, soot stains, moss in mortar lines, rain darkened',
  rubber: 'black rubber tire tread surface, fine grooves, sipes, worn, dusty',
};
for (const [k, p] of Object.entries(tex)) add('tex', k, 'fal-ai/flux-2-pro', { prompt: `${p}. ${TEX}`, image_size: 'square_hd', output_format: 'png', seed: 7 });

// ---------- Building facades (night, lit windows) + ground-floor shopfronts
const FAC = 'perfectly frontal orthographic architectural elevation photo, zero perspective distortion, the facade fills the entire frame edge to edge, no sky, no ground, regular repeating grid, at night in heavy rain, photorealistic, highly detailed';
const facades = {
  apartment: 'dense asian concrete apartment tower facade, many small windows, roughly 35 percent lit with warm tungsten and cold fluorescent light, air conditioning units, laundry, rust stains',
  office_glass: 'modern glass curtain wall office skyscraper facade, dark blue tinted glass panels, a few lit office floors with cool white light, steel mullions',
  tenement: 'old brick tenement building facade, fire escapes, warm lit windows with curtains, pipes, grime',
  industrial: 'industrial warehouse facade, corrugated metal cladding, small high windows with dim sodium light, vents, pipes, rust',
  megablock: 'brutalist megablock residential facade, stacked balconies, colorful lit windows magenta teal amber, satellite dishes, cables',
  tower_lux: 'luxury skyscraper facade, vertical LED light strips in cyan, dark glass, sleek metal fins',
};
for (const [k, p] of Object.entries(facades)) add('facade', k, 'fal-ai/flux-2-pro', { prompt: `${p}. ${FAC}`, image_size: { width: 1024, height: 1536 }, output_format: 'jpeg', seed: 11 });

const SHOP = 'perfectly frontal orthographic photo of a single street level shopfront at night in a rainy cyberpunk asian megacity, zero perspective, fills the frame edge to edge, wet reflections on the floor, photorealistic';
const shops = {
  noodle: 'small ramen noodle bar with warm lit interior, red lanterns, steam, menu boards, sliding door',
  pharmacy: 'bright 24h pharmacy with green cross sign, white fluorescent interior, shelves of products',
  arcade: 'retro video game arcade entrance with glowing cabinets inside, magenta and cyan light',
  shutters: 'closed shop with graffiti covered metal roller shutters, a dim neon sign above, puddles',
  electronics: 'cramped electronics repair shop with screens, cables and circuit boards, cool blue light',
  convenience: 'convenience store with bright interior, drinks fridges, posters on the glass',
  garage: 'auto repair garage bay with open roller door, tools, amber work lights',
  bar: 'dim cocktail bar entrance with purple neon, frosted glass door, bouncer rope',
};
for (const [k, p] of Object.entries(shops)) add('shop', k, 'fal-ai/flux-2-pro', { prompt: `${p}. ${SHOP}`, image_size: { width: 1536, height: 768 }, output_format: 'jpeg', seed: 21 });

// ---------- 2. Neon signs (isolated on black so they can be additively blended)
const SIGN = 'single glowing neon tube sign, photographed straight on, isolated on a pure black background, nothing else in frame, crisp readable lettering, realistic glass tubes with glow and slight bloom, high contrast';
const signsLatin = [
  ['noodle_bar', "text 'NOODLE BAR' in hot pink neon with a steaming bowl icon"],
  ['pharmacy', "text 'PHARMACY 24H' in bright green neon with a cross icon"],
  ['arcade', "text 'ARCADE' in electric cyan and magenta neon with a joystick icon"],
  ['speed_wash', "text 'SPEED WASH' in blue neon with water droplets"],
  ['dental', "text 'DENTAL CLINIC' in white and cyan neon with a tooth icon"],
  ['bank', "text 'KAIROS BANK' in amber gold neon, elegant serif"],
  ['hotel', "vertical text 'HOTEL' in red neon, stacked letters"],
  ['open', "text 'OPEN' in red neon inside a blue neon rectangle"],
  ['karaoke', "text 'KARAOKE' in purple neon with a microphone icon"],
  ['pawn', "text 'PAWN & LOAN' in yellow neon"],
  ['tattoo', "text 'TATTOO' in teal neon with a dagger icon"],
  ['cyberware', "text 'CYBERWARE CLINIC' in cyan neon with a robotic arm icon"],
  ['liquor', "text 'LIQUOR' in orange neon script"],
  ['motel', "text 'NO VACANCY' in pink neon, retro script"],
  ['sushi', "text 'SUSHI' in white neon with a red fish icon"],
  ['bar_cocktail', "a cocktail glass icon in magenta and cyan neon, no text"],
  ['coffee', "text 'NIGHT OWL COFFEE' in warm white neon with an owl icon"],
  ['repair', "text 'AUTO REPAIR' in amber neon with a wrench icon"],
  ['club', "text 'VOLT' in electric blue neon, futuristic lettering, lightning bolt"],
  ['cafe_cat', "a cute cat face icon in pink neon with text 'NEKO CAFE'"],
];
for (const [k, p] of signsLatin) add('sign', k, 'fal-ai/flux-2-pro', { prompt: `${p}. ${SIGN}`, image_size: 'landscape_4_3', output_format: 'jpeg', seed: 31 });

const signsCJK = [
  ['cjk_ramen', 'vertical neon sign with Japanese katakana and kanji characters for ramen, red and white neon'],
  ['cjk_hotel', 'vertical neon sign with Chinese characters reading hotel, gold and red neon'],
  ['cjk_pharmacy', 'neon sign with Japanese characters for pharmacy and a green cross, green and white neon'],
  ['cjk_massage', 'vertical neon sign with Chinese characters, magenta neon, decorative border'],
  ['cjk_izakaya', 'horizontal neon sign with Japanese kanji for izakaya, warm orange neon with a sake bottle icon'],
  ['cjk_electronics', 'vertical neon sign with Japanese katakana for electronics, cyan neon'],
  ['cjk_dumpling', 'horizontal neon sign with Chinese characters for dumplings and a dumpling icon, yellow and red neon'],
  ['cjk_game', 'vertical neon sign with Japanese katakana for game center, purple and teal neon'],
  ['cjk_bank', 'neon sign with Chinese characters for bank, amber neon, square frame'],
  ['cjk_karaoke', 'vertical neon sign with Japanese katakana for karaoke, pink neon'],
  ['cjk_tea', 'neon sign with Chinese characters for tea house and a teapot icon, green neon'],
  ['cjk_clinic', 'vertical neon sign with Japanese kanji for clinic, white and blue neon'],
];
for (const [k, p] of signsCJK) add('sign', k, 'fal-ai/nano-banana-2', { prompt: `${p}. ${SIGN}`, aspect_ratio: /vertical/.test(p) ? '9:16' : '16:9', resolution: '1K', output_format: 'jpeg' });

// Billboard / ad art (fictional brands only)
const AD = 'full frame advertising billboard artwork, no frame, no wall, fills the image edge to edge, cyberpunk megacity advertising, glossy commercial photography, vivid neon colors, crisp readable brand name';
const ads = [
  ['ad_energy', 'landscape_16_9', "energy drink can for fictional brand 'VOLTA' surrounded by electric cyan lightning on magenta background"],
  ['ad_ramen', 'landscape_16_9', "steaming bowl of ramen, fictional brand 'MOMO RAMEN', warm red and gold"],
  ['ad_implant', 'portrait_16_9', "elegant woman with glowing cyber eye implant, fictional brand 'IRIS OPTICS', teal and purple"],
  ['ad_car', 'landscape_16_9', "sleek original futuristic sports car with light trails, fictional brand 'APEX MOTORS', no real car brand"],
  ['ad_drink', 'portrait_16_9', "glass bottle of soda with condensation, fictional brand 'NOVA COLA', red and white"],
  ['ad_watch', 'landscape_16_9', "holographic smartwatch floating, fictional brand 'CHRONOS', deep blue and cyan"],
  ['ad_airline', 'landscape_16_9', "sleek flying taxi over a neon city, fictional brand 'SKYLANE', sunset magenta"],
  ['ad_umbrella', 'portrait_16_9', "transparent glowing LED umbrella in the rain, fictional brand 'RAINLIGHT', pastel teal and pink"],
  ['ad_game', 'landscape_16_9', "dramatic video game key art of a robot samurai, fictional title 'STEEL RONIN', red and black"],
  ['ad_noodle_cup', 'portrait_16_9', "instant noodle cup with chopsticks, fictional brand 'KAZE NOODLE', orange and yellow"],
];
for (const [k, size, p] of ads) add('ad', k, 'fal-ai/flux-2-pro', { prompt: `${p}. ${AD}`, image_size: size, output_format: 'jpeg', seed: 41 });

// ---------- 3. Sky panorama
add('sky', 'night_pano', 'fal-ai/flux-2-pro', {
  prompt: 'wide seamless 360 degree panoramic photograph of a vast cyberpunk megacity skyline at night seen from street level far away, endless distant skyscrapers silhouettes with tiny lit windows, heavy light pollution glowing purple and teal haze, low clouds lit from below in magenta and cyan, rain atmosphere, distant flying vehicle lights, horizon in the lower third, photorealistic, cinematic',
  image_size: { width: 2048, height: 768 }, output_format: 'png', seed: 51,
});
add('sky', 'clouds', 'fal-ai/flux-2-pro', {
  prompt: 'seamless tileable texture of dense stormy night clouds seen from below, lit by city light pollution in purple and teal, soft, dark, no ground, no buildings, photorealistic',
  image_size: 'square_hd', output_format: 'jpeg', seed: 52,
});

// ---------- 4. UI art
add('ui', 'logo', 'fal-ai/gpt-image-2', {
  prompt: "Game logo for 'NEON RUN'. Bold italic futuristic speed lettering, chrome and glowing neon tube outline in cyan and magenta, motion speed lines, on a pure solid black background, centered, no other text",
  image_size: 'landscape_16_9', quality: 'high',
});
add('ui', 'loading', 'fal-ai/flux-2-pro', {
  prompt: 'cinematic wide shot of a sleek dark muscle sports car with glowing cyan underglow speeding through a rain soaked neon cyberpunk street at night, wet road reflecting magenta and teal signs, light trails, volumetric fog, low angle, photorealistic, movie still, no logos',
  image_size: { width: 1920, height: 1088 }, output_format: 'jpeg', seed: 61,
});
const cards = {
  card_neon: 'Neon District: dense market street packed with glowing neon signs in magenta and cyan, crowds with umbrellas, steam, rain',
  card_docks: 'Industrial Docks: stacked shipping containers, giant cranes, thick fog, sodium orange lights, wet concrete, rain',
  card_downtown: 'Downtown Towers: canyon of tall glass skyscrapers, elevated monorail train passing overhead, holographic ads, teal light',
  card_backstreets: 'Backstreets: narrow alley with steam vents, puddles, tangled cables, small neon signs, fire escapes, dim amber light',
};
for (const [k, p] of Object.entries(cards)) add('ui', k, 'fal-ai/flux-2-pro', { prompt: `${p}. Cinematic night photograph of a cyberpunk megacity district, photorealistic, moody, deep blue-black shadows`, image_size: 'landscape_16_9', output_format: 'jpeg', seed: 62 });

const ICON = 'single minimal flat game HUD icon, thick clean white line art, centered, on a pure solid black background, no text, high contrast, vector style';
const icons = ['package delivery box', 'map pin location marker', 'stopwatch timer', 'lightning bolt boost', 'car steering wheel', 'tire grip', 'speedometer gauge', 'coin credits', 'warning triangle', 'drone', 'trophy', 'wrench upgrade', 'lock', 'checkmark in circle', 'cross in circle', 'flag finish', 'compass north arrow', 'radio signal antenna', 'rain cloud', 'gear settings'];
icons.forEach((p, i) => add('icon', `i${String(i).padStart(2, '0')}_${p.split(' ')[0]}`, 'fal-ai/recraft/v4/text-to-image', { prompt: `${p}. ${ICON}`, image_size: 'square', style: 'vector_illustration' }));

// ---------- 5. Car liveries (decal graphics)
const LIV = 'car livery decal graphic design, flat vector vinyl wrap artwork, isolated on a pure solid black background, horizontal composition, no car, no text';
const liveries = {
  liv_stripes: 'twin racing stripes with chevrons in cyan',
  liv_tiger: 'aggressive tiger stripe slashes in hot magenta',
  liv_circuit: 'glowing circuit board traces in teal',
  liv_kanji: 'brush stroke splash with abstract calligraphy shapes in red and white',
  liv_flames: 'stylized flames in amber and orange',
  liv_geo: 'sharp geometric triangles and hexagons in purple and cyan',
};
for (const [k, p] of Object.entries(liveries)) add('livery', k, 'fal-ai/flux-2-pro', { prompt: `${p}. ${LIV}`, image_size: 'landscape_16_9', output_format: 'png', seed: 71 });

// ---------- 6. Hero car + landmark concepts (then image-to-3D, see stage 2 below)
const OBJ = 'single object product render, three quarter view from slightly above, centered, fully visible with margin, plain pure white studio background, soft even lighting, no shadow clutter, highly detailed, realistic materials';
add('concept', 'car', 'fal-ai/flux-2-pro', {
  prompt: `original design aggressive modern muscle sports coupe, long hood, wide rear haunches, matte dark gunmetal paint, black tinted windows, thin LED headlight strip, black multi-spoke wheels with low profile tires, no logos, no badges, no text. ${OBJ}`,
  image_size: 'landscape_4_3', output_format: 'png', seed: 81,
});
const landmarks = {
  lm_pagoda: 'futuristic neon pagoda tower top with five stacked curved roofs edged with magenta neon strips, antennas',
  lm_watertower: 'old rooftop water tower on steel legs with a big circular neon ring sign',
  lm_crane: 'giant harbor gantry container crane, red and white steel truss, warning lights',
  lm_gate: 'monumental cyberpunk district gate archway, concrete pillars with vertical neon signs and a big holographic crossbar',
  lm_statue: 'large stylized cat statue (maneki neko) made of chrome and glowing cyan panels on a pedestal',
};
for (const [k, p] of Object.entries(landmarks)) add('concept', k, 'fal-ai/flux-2-pro', { prompt: `${p}, no text. ${OBJ}`, image_size: 'square_hd', output_format: 'png', seed: 82 });

// Stage 2 (requires concepts): '@file:' inputs are resolved to data URIs by the runner.
add('model3d', 'car', 'tripo3d/h3.1/image-to-3d', { image_url: '@file:assets/generated/concept/car.png', texture: true, pbr: true, texture_quality: 'detailed', geometry_quality: 'detailed', face_limit: 60000 });
for (const k of Object.keys(landmarks)) add('model3d', k, 'fal-ai/trellis-2', { image_url: `@file:assets/generated/concept/${k}.png`, resolution: 1024, texture_size: 2048, decimation_target: 40000 });

// ---------- Video (Kling 2.5 Turbo Pro)
const VID = 'photorealistic cinematic, anamorphic, rain, wet reflections, neon magenta and teal against deep blue-black, no text, no logos';
add('video', 'intro', 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video', { prompt: `slow aerial drone shot descending through low clouds into a vast rain soaked cyberpunk megacity at night, towering skyscrapers with neon signs, elevated train passing, then following a lone dark sports car with cyan underglow speeding down a wet avenue. ${VID}`, duration: '10', aspect_ratio: '16:9', negative_prompt: 'blur, distort, low quality, text, watermark', cfg_scale: 0.5 });
add('video', 'stinger', 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video', { prompt: `dark sports car drifts to a stop in front of a glowing neon doorway in the rain, sparks of light, camera orbits fast, triumphant. ${VID}`, duration: '5', aspect_ratio: '16:9', negative_prompt: 'blur, distort, low quality, text, watermark', cfg_scale: 0.5 });
add('video', 'loading_loop', 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video', { prompt: `locked off static camera, rain falling past a flickering neon sign reflected in a puddle on a dark street at night, subtle looping motion. ${VID}`, duration: '5', aspect_ratio: '16:9', negative_prompt: 'camera movement, text, watermark', cfg_scale: 0.5 });
const bb = {
  bb_koi: 'holographic advertisement: glowing koi fish swimming in a loop through neon water ripples, magenta and cyan, abstract commercial',
  bb_drink: 'commercial: a glossy energy drink can rotating slowly with electric lightning arcs around it, cyan on magenta, product shot',
  bb_ramen: 'food commercial: steaming bowl of ramen with chopsticks lifting noodles, warm light, slow motion, steam',
  bb_eye: 'beauty tech commercial: close up of a woman opening her eye revealing a glowing cyber iris implant, teal purple light',
};
for (const [k, p] of Object.entries(bb)) add('video', k, 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video', { prompt: `${p}, photorealistic, vivid, no text`, duration: '5', aspect_ratio: k === 'bb_eye' ? '9:16' : '16:9', negative_prompt: 'text, watermark, blur', cfg_scale: 0.5 });

// ---------- Music (instrumental)
const music = {
  drive: [110000, 'Dark synthwave cyberpunk driving theme, 128 BPM, pulsing analog bass, gated drums, fast arpeggiated synths, rising tension, night city, seamless loop, instrumental only'],
  chill: [95000, 'Ambient lo-fi synth for rainy night free roam, 80 BPM, warm pads, soft vinyl crackle, mellow electric piano, rain mood, seamless loop, instrumental only'],
  urgent: [90000, 'Aggressive high energy cyberpunk chase music, 145 BPM, distorted bass, pounding drums, alarm-like synth stabs, urgent countdown tension, seamless loop, instrumental only'],
  menu: [100000, 'Cinematic dark ambient title theme, slow build, deep drones, distant synth choir, sparse piano, rain, gradual swell, seamless loop, instrumental only'],
};
for (const [k, [ms, p]] of Object.entries(music)) add('music', k, 'fal-ai/elevenlabs/music', { prompt: p, music_length_ms: ms, force_instrumental: true, output_format: 'mp3_44100_128' });

// ---------- SFX
const sfx = {
  engine_idle: [4, true, 'deep V8 muscle car engine idling, steady rumble, close mic, no other sounds'],
  engine_low: [4, true, 'V8 muscle car engine at steady low-mid RPM cruising, constant pitch, close mic, no other sounds'],
  engine_high: [4, true, 'V8 muscle car engine at steady high RPM roaring, constant pitch, close mic, no other sounds'],
  boost: [2.5, false, 'turbo nitrous boost whoosh with rising jet roar'],
  tire_squeal: [3, true, 'continuous car tire squeal while drifting on asphalt'],
  drift_wet: [3, true, 'car tires sliding sideways on wet asphalt, hissing water spray and squeal'],
  gear_shift: [0.8, false, 'quick mechanical gear shift clunk with blow off valve pssh'],
  horn: [1.2, false, 'loud car horn honk, single'],
  hit_light: [1, false, 'light car bump into plastic barrier, thud'],
  hit_heavy: [1.5, false, 'heavy car crash impact, crunching metal'],
  hit_metal: [1.2, false, 'car scraping hitting a metal pole, clang'],
  hit_glass: [1.5, false, 'glass shattering from car impact'],
  suspension: [0.6, false, 'car suspension thump landing over a bump'],
  rain_light: [6, true, 'light rain falling on a city street at night, steady'],
  rain_heavy: [6, true, 'heavy rain downpour on city street, steady, dense'],
  rain_roof: [5, true, 'rain drumming on a car metal roof from inside the car'],
  tire_hiss: [4, true, 'car tires rolling fast on a wet road, continuous water hiss'],
  sirens: [6, true, 'distant police sirens echoing in a city at night'],
  city_hum: [6, true, 'distant futuristic city ambience hum, traffic, faint voices, night'],
  neon_buzz: [3, true, 'electric neon sign buzzing hum'],
  steam_vent: [3, true, 'steam hissing from a street vent'],
  ui_click: [0.5, false, 'clean futuristic UI click'],
  ui_hover: [0.5, false, 'soft subtle futuristic UI hover tick'],
  ui_confirm: [0.8, false, 'futuristic UI confirm chime, positive'],
  ui_error: [0.7, false, 'futuristic UI error buzz, negative'],
  mission_start: [1.8, false, 'cyberpunk mission start stinger, synth rise with impact'],
  mission_complete: [2.5, false, 'mission complete success fanfare, synth, triumphant short'],
  timer_tick: [0.5, false, 'digital clock tick'],
  timer_warning: [1.2, false, 'urgent digital countdown warning beeps'],
  pickup: [1, false, 'package pickup confirmation, magnetic clunk and digital chime'],
  drone_hum: [4, true, 'hovering drone propeller hum, electric whine'],
  crowd: [6, true, 'crowd murmur at a busy night market, indistinct chatter'],
  train: [6, false, 'elevated metro train passing overhead on rails, rumble and clatter'],
  near_miss: [1, false, 'fast car whooshing past very close, doppler'],
  cash: [0.8, false, 'digital credits payment received sound'],
};
for (const [k, [d, loop, p]] of Object.entries(sfx)) add('sfx', k, 'fal-ai/elevenlabs/sound-effects/v2', { text: p, duration_seconds: d, loop, prompt_influence: 0.6, output_format: 'mp3_44100_128' });

// ---------- Dispatcher voice
const lines = {
  brief_1: 'Package is hot. Get it to the drop-off before the clock runs out.',
  brief_2: 'New job. Pick up the parcel, mind the drones.',
  brief_3: "Client's waiting. Don't make them wait long.",
  brief_neon: "Neon District. Crowded, loud, and nobody's watching. Perfect.",
  brief_docks: 'The Docks. Fog rolls in thick. Trust your lights.',
  brief_downtown: 'Downtown. Glass towers and corporate eyes. Keep it clean.',
  brief_back: "Backstreets. Tight corners. Don't scratch the paint.",
  pickup: 'Package secured. Now move.',
  ten_left: 'Ten seconds left.',
  twenty_left: 'Twenty seconds. Pick it up.',
  success_1: 'Delivered. Credits are in your account.',
  success_2: 'Clean run. I knew you had it.',
  fail_1: "Too late. Client walked. We'll talk about this.",
  fail_2: 'Package is dead. Head back, courier.',
  near_miss_1: 'That was close.',
  near_miss_2: 'Easy. The car is worth more than you are.',
  drone: 'Drones on your tail. Lose them.',
  upgrade: 'Nice upgrade. She purrs now.',
  unlock: 'New district unlocked. The city just got bigger.',
};
for (const [k, t] of Object.entries(lines)) add('voice', k, 'fal-ai/elevenlabs/tts/eleven-v3', { text: t, voice: 'Brian', stability: 0.5 });

// ================= Phase 1 (Oct 15): realistic traffic cars, all drivable =================
PRICES['tripo3d/h3.1/image-to-3d'] = 0.6;
const CAR = 'single car, three quarter front view from slightly above, the whole car fully visible and centered with margin, all four wheels clearly visible, pure white seamless studio background, soft even studio lighting, realistic proportions, photorealistic product photograph, no text, no logos, no badges, no license plate';
const cars = {
  car_taxi: 'modern compact city taxi sedan, yellow paint with a black checker stripe along the doors, small taxi light box on the roof, black wheels',
  car_police: 'futuristic police interceptor sedan, black and white two-tone paint, red and blue roof light bar, front push bumper, dark tinted windows',
  car_van: 'boxy electric delivery van, white body with an orange stripe, tall roof, sliding side door, steel wheels',
  car_hatch: 'original design boxy retro-futuristic city hatchback with square headlights and a flat roof, not resembling any real production car, faded teal paint with scratches and rust spots, silver wheels',
  car_lux: 'long luxury executive sedan, glossy black paint, chrome window trim, large chrome wheels',
  car_pickup: 'rugged pickup truck, matte olive green, black roll bar with off-road lights, chunky all-terrain tires',
  car_super: 'original concept hypercar with smooth rounded teardrop body, glass canopy cockpit and a single continuous light bar at front, not resembling any real production car or brand, metallic violet paint, black wheels',
  car_classic: 'battered 1970s american muscle coupe, faded burnt orange paint, black hood stripe, chrome bumpers',
};
for (const [k, p] of Object.entries(cars)) add('concept', k, 'fal-ai/gpt-image-2', { prompt: `${p}. ${CAR}`, image_size: 'landscape_4_3', quality: 'high' });
for (const k of Object.keys(cars)) add('model3d', k, 'tripo3d/h3.1/image-to-3d', { image_url: `@file:assets/generated/concept/${k}.png`, texture: true, pbr: true, texture_quality: 'detailed', geometry_quality: 'detailed', face_limit: 30000 });

// ================= Phase 2/3: realistic people (rigged) =================
PRICES['fal-ai/meshy/v6/image-to-3d'] = 0.8; // estimate
PRICES['fal-ai/meshy/rigging'] = 0.3; // estimate
PRICES['fal-ai/hunyuan-motion'] = 0.2; // estimate
const PERSON = 'full body photograph of one adult person standing in a strict T-pose, arms straight out horizontally to the sides at shoulder height, palms down, legs slightly apart, feet flat, facing the camera, neutral expression, head to toe fully visible with margin, plain pure white seamless studio background, soft even studio lighting, sharp focus, photorealistic, realistic skin and fabric, no props, no bag, nothing in the hands';
export const PEOPLE = {
  hero: 'athletic courier man in his early thirties, short dark undercut hair, light stubble, black waterproof techwear jacket with subtle cyan piping, dark cargo trousers, black high-top sneakers, fingerless gloves',
  ped_suit: 'middle aged office man, grey suit, open beige trench coat, black leather shoes, short grey hair',
  ped_vendor: 'older east asian street food vendor man, white apron over a blue work shirt, rolled sleeves, black trousers, rubber boots',
  ped_punk: 'young punk woman, bleached short hair with pink tips, black leather jacket, ripped dark jeans, combat boots',
  ped_worker: 'dock worker man, orange high visibility jacket with reflective stripes, dark work trousers, work boots, beanie hat',
  ped_student: 'young student woman, oversized grey hoodie, black leggings, white sneakers, hair in a bun',
  ped_elder: 'elderly woman, purple cardigan over a long skirt, flat shoes, grey hair in a bun, glasses',
  ped_techwear: 'young man in futuristic techwear, black hooded jacket with straps, tactical trousers, glowing teal LED strip on the collar',
  ped_nurse: 'nurse woman in her forties, light blue scrubs under a transparent raincoat, white clogs',
  ped_rider: 'delivery rider man, red waterproof jacket, black rain trousers, motorcycle boots, short curly hair',
};
for (const [k, p] of Object.entries(PEOPLE)) {
  add('person', k, 'fal-ai/gpt-image-2', { prompt: `${p}. ${PERSON}`, image_size: 'portrait_16_9', quality: 'high' });
  add('person3d', k, 'fal-ai/meshy/v6/image-to-3d', { image_url: `@file:assets/generated/person/${k}.png`, topology: 'triangle', target_polycount: 30000, should_remesh: true, enable_pbr: true, symmetry_mode: 'auto', is_a_t_pose: true, should_texture: true });
}

const HEIGHTS = { hero: 1.82, ped_suit: 1.78, ped_vendor: 1.68, ped_punk: 1.68, ped_worker: 1.84, ped_student: 1.64, ped_elder: 1.58, ped_techwear: 1.8, ped_nurse: 1.66, ped_rider: 1.76 };
for (const k of Object.keys(PEOPLE)) add('rig', k, 'fal-ai/meshy/rigging', { model_url: `@file:assets/build/people/${k}_rigin.glb`, height_meters: HEIGHTS[k] });

// text-to-motion clips (retargeted onto the Meshy skeleton in blender/retarget.py)
export const MOTIONS = {
  idle: 'a person stands still relaxed, breathing, shifting weight slightly, looking around',
  jump: 'a person jumps up in place with both feet and lands',
  enter_car: 'a person reaches out to open a car door, then bends down and sits into the car seat',
  exit_car: 'a person climbs out of a car seat, stands up and closes the car door behind them',
  talk: 'a person stands and talks with gestures of both hands, friendly conversation',
  wave: 'a person waves hello with the right hand',
  flee: 'a person gets scared, flinches and runs away quickly',
  phone: 'a person stands looking down at a phone held in the right hand',
  shrug: 'a person shrugs with both shoulders and raises palms',
  push: 'a person pulls someone out of a car with both arms and throws them aside',
  fall: 'a person stumbles backwards and falls onto the ground',
};
for (const [k, p] of Object.entries(MOTIONS)) add('motion', k, 'fal-ai/hunyuan-motion', { prompt: p, duration: k === 'idle' ? 4 : 3, output_format: 'fbx' });

// ---------- street conversations (hero <-> pedestrians), carjack victims, police megaphone
export const VOICES = { hero: 'Liam', ped_suit: 'George', ped_vendor: 'Bill', ped_punk: 'Jessica', ped_worker: 'Callum', ped_student: 'Lily', ped_elder: 'Matilda', ped_techwear: 'Will', ped_nurse: 'Sarah', ped_rider: 'Chris', police: 'Daniel' };
export const LINES = {
  hero: [
    'Evening. Seen any drones around here?', 'Rough night, huh?', 'You know a shortcut to the docks?', 'Hey. Stay dry out there.',
    'Busy street tonight.', 'Got a light? Never mind.', "Don't mind me, just passing through.", 'Need anything delivered? I\'m fast.',
  ],
  ped_suit: ["I don't talk to couriers. Move along.", 'Do you know what this coat cost? Back off.', "Make it quick, I'm late for a board call."],
  ped_vendor: ['Hot noodles, best in the district! Two credits!', 'Rain is good for business. Everybody wants soup.', 'You look hungry, friend. Come back later.'],
  ped_punk: ['Nice jacket. Did you steal it?', 'Drones? They never come down this street. We make sure of that.', 'Get lost, delivery boy.'],
  ped_worker: ['Docks are closed after midnight, pal.', 'Twelve hour shift. Talk to me tomorrow.', 'Watch the cranes, they swing low in the fog.'],
  ped_student: ['Sorry, I have an exam in the morning!', 'Is it always this loud at night?', "Oh hi! Wait, aren't you that courier?"],
  ped_elder: ['In my day it only rained on weekdays.', 'Young man, slow down when you drive past here!', 'Such a polite boy. Off you go now.'],
  ped_techwear: ['You still drive a car with wheels? Cute.', 'Shh. I am listening to the city.', 'Respect. You move fast for an analog.'],
  ped_nurse: ['Twelve hour shift, I just want to get home.', 'If you crash that thing, I will be the one patching you up.', 'Stay safe out there, okay?'],
  ped_rider: ['Hey, competition! Good luck tonight.', 'Same route every night. The bridge is the fastest.', 'Rain makes the tips better, right?'],
  victim: ['Hey! That is my car!', 'No no no, not again!', 'Somebody call the police!', 'Take it, just take it!'],
  police: ['This is the police. Pull over now!', 'Stop the vehicle! Hands where we can see them!', 'All units, suspect is heading downtown.', 'You are under arrest. Stay where you are.'],
};
let li = 0;
for (const [who, list] of Object.entries(LINES)) list.forEach((t, i) => {
  const voice = who === 'victim' ? ['Bill', 'Jessica', 'George', 'Sarah'][i % 4] : VOICES[who];
  add('talk', `${who}_${i}`, 'fal-ai/elevenlabs/tts/eleven-v3', { text: t, voice, stability: 0.45 });
  li++;
});

const sfx2 = {
  footstep_wet: [0.6, false, 'single footstep on a wet concrete sidewalk, sneaker, close'],
  footsteps_run: [2, true, 'running footsteps on wet pavement, steady pace, close'],
  door_open: [1, false, 'car door handle pull and door opening, close'],
  door_close: [1, false, 'car door slamming shut, solid thud, close'],
  carjack: [1.5, false, 'struggle, grab and shove, cloth rustle, person grunts'],
  body_hit: [1, false, 'car bumper hits a person, dull thud'],
  scream: [1.5, false, 'person screams in panic, short'],
  siren_close: [4, true, 'police car siren wailing very close, american style'],
  jump_land: [0.6, false, 'person lands from a jump on wet ground, soft thud and splash'],
  crowd_panic: [3, false, 'crowd of people screaming and scattering'],
  radio_squelch: [0.6, false, 'police radio squelch beep'],
};
for (const [k, [d, loop, p]] of Object.entries(sfx2)) add('sfx', k, 'fal-ai/elevenlabs/sound-effects/v2', { text: p, duration_seconds: d, loop, prompt_influence: 0.6, output_format: 'mp3_44100_128' });

export const ASSETS = A;

// ---------- Phase 4: campaign ("Night Shift") — dispatcher/contact lines, mission cards, chase + finale music, new sfx
import { STORY_LINES, STORY_VOICES } from './story.mjs';
for (const [k, [who, t]] of Object.entries(STORY_LINES)) add('talk', `story_${k}`, 'fal-ai/elevenlabs/tts/eleven-v3', { text: t, voice: STORY_VOICES[who], stability: 0.5 });

const CARD = 'cinematic photorealistic film still, rainy night in a dense futuristic asian megacity, wet reflective streets, neon light, anamorphic lens, shallow depth of field, moody color grade, no text, no logos, no brand names, no watermark';
const missionCards = {
  m1: 'a dark muscle coupe parked at a glowing neon street food strip, a courier in a black jacket holding a small parcel walks toward it',
  m2: 'a crowded covered night market alley with lanterns and food stalls, a woman in a raincoat waits behind a stall, a courier walks in carrying a parcel',
  m3: 'close up of a wooden crate of antique glass lenses with straw packing in the back seat of a car, rain streaked windows, neon bokeh outside',
  m4: 'a battered orange 1970s muscle coupe parked alone in a narrow rain soaked back alley, steam rising from a vent, a single flickering lamp',
  m5: 'view through a rain covered windshield following a white delivery van at a distance down a neon street, taillights glowing',
  m6: 'a car drifting sideways through a wet intersection throwing spray, a crowd of street racers cheering on the sidewalk, motion blur',
  m7: 'an executive in a long dark coat waiting under the canopy of a glass corporate skyscraper lobby, black luxury sedan pulling up',
  m8: 'low angle of a car speeding between glass skyscrapers on a wide downtown avenue, light trails, glowing checkpoint arches',
  m9: 'police cruisers with red and blue lights blocking a downtown street at night, a car speeding past them in the rain',
  m10: 'industrial harbor container yard in thick fog, stacked shipping containers, gantry cranes, small security drones with spotlights',
  m11: 'aerial view of a car chased by three police cruisers across a rain soaked bridge with flashing lights',
  m12: 'a courier standing next to a dark muscle coupe at the edge of a harbor at dawn, the neon city skyline behind, rain ending',
};
for (const [k, p] of Object.entries(missionCards)) add('mission', k, 'fal-ai/gpt-image-2', { prompt: `${p}. ${CARD}`, image_size: 'landscape_16_9', quality: 'high' });

const music2 = {
  chase: [90000, 'Intense cyberpunk police pursuit music, 150 BPM, driving breakbeat drums, siren-like synth leads, heavy sub bass, relentless momentum, seamless loop, instrumental only'],
  finale: [100000, 'Epic cinematic synthwave finale, 132 BPM, soaring analog leads over driving drums and big pads, heroic and emotional, night city climax, seamless loop, instrumental only'],
};
for (const [k, [ms, p]] of Object.entries(music2)) add('music', k, 'fal-ai/elevenlabs/music', { prompt: p, music_length_ms: ms, force_instrumental: true, output_format: 'mp3_44100_128' });

const sfx3 = {
  checkpoint: [1, false, 'futuristic race checkpoint pass chime, bright synth ding with whoosh'],
  glass_rattle: [1.2, false, 'crate of glass bottles rattling and clinking from a bump'],
  cheer: [2.5, false, 'small crowd of street racers cheering and whistling outdoors at night'],
  objective: [1.2, false, 'new objective notification, futuristic two tone synth ping'],
  camera_flash: [0.8, false, 'surveillance camera shutter click with electronic beep'],
};
for (const [k, [d, loop, p]] of Object.entries(sfx3)) add('sfx', k, 'fal-ai/elevenlabs/sound-effects/v2', { text: p, duration_seconds: d, loop, prompt_influence: 0.6, output_format: 'mp3_44100_128' });

// ---------- feedback round: calmer idle (the first one swayed side to side)
add('motion', 'idle_calm', 'fal-ai/hunyuan-motion', { prompt: 'a person stands completely still in a neutral relaxed pose, arms hanging at the sides, feet planted shoulder width apart, only slow subtle breathing, no swaying, no weight shifting', duration: 4, output_format: 'fbx' });

// ---------- Phase C: shop interiors. Frontal wall "elevations" used as photo-textured walls behind real 3D
// counters and props (2.5D set dressing). Back walls are unique per place, side walls / windows per room type.
const WALL = 'perfectly frontal straight-on photograph of one interior wall, zero perspective distortion, the wall fills the entire frame edge to edge, no floor and no ceiling visible, no people, no readable brand logos, practical warm and neon lighting, lived-in details, photorealistic, highly detailed, cyberpunk asian megacity at night';
const backWalls = {
  noodle_row: 'the back wall of a tiny noodle bar: steel kitchen with big steaming broth pots, ladles hanging on hooks, handwritten paper menu strips, red paper lanterns, steam',
  arcade: 'the back wall of a neon arcade: a row of glowing retro arcade cabinets and claw machines, purple and teal light, posters, prize shelves',
  clinic: 'the back wall of a small all-night clinic reception: frosted glass partition, medicine cabinets, a glowing cross sign, clipboards, plastic chairs against the wall, cold fluorescent light',
  night_market: 'the back wall of a covered night market stall: hanging produce, crates of fruit and dried goods stacked to the ceiling, string lights, tarps, hand painted price boards',
  laundromat: 'the back wall of a laundromat: two stacked rows of front loading washing machines and dryers with round glass doors, a few spinning, fluorescent light, folding notices',
  tattoo: 'the back wall of a tattoo parlor: framed tattoo flash art covering the wall, a cabinet of inks, a neon hand sign, a reclining tattoo chair, moody red light',
  tower: 'the back wall of a luxury corporate tower lobby: polished black marble wall with a backlit abstract steel sculpture, a slim reception desk wall panel, cool white light',
  hotel: 'the back wall of a grand old hotel lobby: carved wooden reception wall with brass key boxes, a big vintage clock, warm chandeliers glow, velvet drapes',
  courthouse: 'the back wall of an old courthouse hall: tall wooden panelling, a faded coat of arms, notice boards with pinned papers, brass lamps, worn stone',
  pier9: 'the back wall of a container yard site office: corrugated metal wall with shift rosters, safety posters, a radio set, keys on hooks, a window onto cranes in fog',
  union_hall: 'the back wall of a dock workers union hall: brick wall with union banners and strike posters, a chalkboard with vote counts, folding chairs stacked',
  fish_market: 'the back wall of an indoor fish market: tiled wall with ice displays of fish and crabs, hanging scales, hoses, blue fluorescent light, wet surfaces',
};
for (const [k, p] of Object.entries(backWalls)) add('interior', `${k}_back`, 'fal-ai/flux-2-pro', { prompt: `${p}. ${WALL}`, image_size: { width: 2048, height: 1024 }, output_format: 'jpeg', seed: 91 });
const roomTypes = {
  food: ['a noodle bar side wall: wooden booth backs, small framed photos, a wall mounted fan, tiled lower wall, warm light', 'rain streaked shop window from inside looking out onto a neon lit street at night, condensation, a sticker on the glass'],
  market: ['a covered market side wall: shelves of jars and sacks, hanging baskets, tarps, string lights', 'an open market entrance seen from inside, plastic strip curtain, the rainy neon street beyond'],
  shop: ['a small shop side wall: shelving with boxes and odds and ends, a poster wall, a vending machine, neon strip light', 'a shop window from inside with neon window signs reversed, rain on the glass, the street outside at night'],
  clinic: ['a clinic waiting room side wall: rows of plastic seats, health posters, a water cooler, a wall TV, fluorescent light', 'a frosted glass clinic entrance from inside, automatic sliding doors, rain and neon outside'],
  lobby: ['a lobby side wall: tall panelled wall with uplights, a large potted plant, a bench, art in a frame', 'a tall glass lobby entrance from inside, revolving door, rainy neon city street outside'],
  depot: ['a warehouse office side wall: metal shelving with parcels and crates, a forklift charger, hazard stripes, work lights', 'a roller shutter door half open from inside, rain falling outside, sodium lights of a container yard'],
};
for (const [k, [side, win]] of Object.entries(roomTypes)) {
  add('interior', `${k}_side`, 'fal-ai/flux-2-pro', { prompt: `${side}. ${WALL}`, image_size: { width: 1536, height: 1024 }, output_format: 'jpeg', seed: 92 });
  add('interior', `${k}_window`, 'fal-ai/flux-2-pro', { prompt: `${win}. perfectly frontal straight-on photograph, zero perspective, fills the frame edge to edge, photorealistic`, image_size: { width: 1536, height: 1024 }, output_format: 'jpeg', seed: 93 });
}

// ---------- Phase C: each named place gets its own storefront on the street instead of a random atlas shop
// (the door used to be a glowing frame on whatever shopfront happened to be there). The entrance is part
// of the photo, dead centre, with a plain dark sign band above it for the in-game name sign.
const FRONT = 'perfectly frontal orthographic photograph of one single street level building entrance at night in a rainy cyberpunk asian megacity, zero perspective distortion, the facade fills the frame edge to edge, the open lit doorway exactly in the centre of the image, a plain dark empty sign band running across the top above the doorway with nothing written on it, wet pavement reflections along the bottom edge, no people, no readable text, no brand logos, photorealistic, highly detailed';
const fronts = {
  noodle_row: 'a tiny noodle bar: open sliding wooden door with short split fabric curtains, a steamy window counter on each side with big broth pots, red paper lanterns hanging, warm orange light spilling out',
  arcade: 'a neon arcade entrance: wide open doorway glowing purple and teal, rows of arcade cabinets and claw machines visible through glass on both sides, flickering tube lights around the frame',
  clinic: 'an all night clinic: frosted glass automatic sliding doors, a glowing green cross lightbox beside the entrance, white tiled facade, cold fluorescent light from inside, a wheelchair ramp with a railing',
  night_market: 'a covered night market entrance: wide opening under plastic tarps, string lights, crates of fruit and vegetables stacked on both sides, hanging lamps, plastic strip curtains',
  laundromat: 'a laundromat: big glass windows on both sides showing rows of front loading washing machines, a glass door in the middle, bright white fluorescent light, a bench outside',
  tattoo: 'a tattoo parlor: black painted shopfront, a narrow glass door, a window on each side with tattoo flash art pinned up and a neon hand outline sign, moody red light from inside',
  tower: 'a luxury corporate tower lobby entrance: tall black glass curtain wall, a brightly lit revolving door in the centre, polished stone steps, cool white uplights, a small canopy',
  hotel: 'a grand old hotel entrance: carved stone columns, brass framed double glass doors in the centre, warm chandelier glow inside, a red carpet on the steps, two potted shrubs and brass lamps',
  courthouse: 'an old courthouse entrance: heavy stone facade, wide stone steps up to tall open wooden double doors in the centre, two old iron lanterns, weathered columns, notice boards',
  pier9: 'a container yard site office: corrugated steel wall with hazard stripes, a half open roller shutter door in the centre lit from inside, sodium work lights, stacked pallets, a small office window',
  union_hall: 'a dock workers union hall: old red brick facade, worn wooden double doors open in the centre, faded banners and posters on the brick, an iron lamp above, puddles',
  fish_market: 'an indoor fish market entrance: a wide open roller door in the centre, blue white fluorescent light inside, ice displays of fish and crabs on both sides, hoses, wet tiled floor, hanging scales',
};
for (const [k, p] of Object.entries(fronts)) add('storefront', k, 'fal-ai/flux-2-pro', { prompt: `${p}. ${FRONT}`, image_size: { width: 1536, height: 912 }, output_format: 'jpeg', seed: 101 });

// ================= Oct 18: the courier's own car, realistic (the old hero car was a rough half-shell) =================
add('concept', 'car_courier', 'fal-ai/gpt-image-2', { prompt: `modern four door sports sedan, original design not resembling any real production car or brand, low and wide, dark graphite metallic paint, dark tinted windows, slim LED headlights, black multi-spoke wheels with low profile tires, clean and realistic. ${CAR}`, image_size: 'landscape_4_3', quality: 'high' });
add('model3d', 'car_courier', 'tripo3d/h3.1/image-to-3d', { image_url: '@file:assets/generated/concept/car_courier.png', texture: true, pbr: true, texture_quality: 'detailed', geometry_quality: 'detailed', face_limit: 40000 });

// ---------- fighting (Oct 18): impacts, swings, pain
const sfxFight = {
  punch_hit: [0.6, false, 'single hard punch landing on a body, fleshy thud with a slap, close up, no voice'],
  kick_hit: [0.7, false, 'heavy kick landing on a torso, deep body thud, close up, no voice'],
  whoosh: [0.5, false, 'fast fist swinging through the air, short whoosh'],
  bottle_smash: [1.0, false, 'glass bottle smashing over a head, glass shards scattering on wet pavement'],
  pipe_hit: [0.7, false, 'metal pipe striking a body, dull clang with a thud'],
  grunt_m: [0.6, false, 'adult man grunting in pain after being punched, short, no words'],
  grunt_f: [0.6, false, 'adult woman gasping in pain after being hit, short, no words'],
};
for (const [k, [d, loop, p]] of Object.entries(sfxFight)) add('sfx', k, 'fal-ai/elevenlabs/sound-effects/v2', { text: p, duration_seconds: d, loop, prompt_influence: 0.7, output_format: 'mp3_44100_128' });

// ---------- fighting moves, same generator as the other clips (Oct 19): retargeted motion capture made
// people look twisted on these rigs, so the street clips went back to the native / generated ones
const FIGHT_MOTIONS = {
  fight_idle: 'a street fighter standing ready, fists clenched and held low in front of the chest, elbows bent down at the sides, knees slightly bent, shifting weight gently from foot to foot in place, facing forward',
  punch: 'a person with fists held low at the chest throws one straight right punch forward at chest height, fully extending the right arm horizontally, then pulls it back to the chest, feet stay in place',
  jab: 'a person with fists held low at the chest throws one quick left punch straight forward at chest height, extending the left arm horizontally, then pulls it back, feet stay in place',
  kick: 'a person lifts the right knee and does one front push kick forward at waist height, then puts the foot back down and returns to a fighting stance',
  get_up: 'a person lying face down on the ground pushes up with both hands, gets onto one knee and stands up, ending standing upright',
};
for (const [k, p] of Object.entries(FIGHT_MOTIONS)) add('motion', k, 'fal-ai/hunyuan-motion', { prompt: p, duration: k === 'get_up' ? 4 : k === 'fight_idle' ? 3 : 2, output_format: 'fbx' });
// the full move set: a four-punch combo (jab, cross, hook, uppercut), three kicks, block, dodge, and being hit
const FIGHT_MOVES = {
  cross: 'a boxer in a fighting stance throws one fast straight right punch, turning the right hip and shoulder forward and extending the right arm fully straight out in front at chin height, then snaps it back to the guard, feet stay planted',
  hook: 'a boxer in a fighting stance throws one left hook, the left elbow bent at ninety degrees and raised to shoulder height, swinging the left fist around horizontally from the side across to the front at head height while pivoting the left foot, then returns to guard',
  uppercut: 'a boxer in a fighting stance dips the knees slightly and throws one right uppercut, driving the right fist upward from the waist to chin height in front of the body with the elbow bent, then returns to guard, feet stay planted',
  roundhouse: 'a martial artist in a fighting stance does one right roundhouse kick, pivoting on the left foot and swinging the right leg around horizontally at waist height in front, then puts the right foot back down behind and returns to stance',
  low_kick: 'a fighter in a stance throws one right low kick, swinging the right shin around into the outside of the opponent\'s thigh at knee height, then puts the foot back down and returns to stance',
  block: 'a boxer raises both forearms tight in front of the face to block, elbows in, chin tucked, holding the high guard firmly in place',
  dodge: 'a boxer quickly leans and steps back to dodge a punch, ducking the head down and to the side, then comes back up into a fighting stance',
  hit_head: 'a person standing gets punched in the face, the head snaps back and to the side, they stumble one step backward and recover their balance',
  hit_body: 'a person standing gets punched in the stomach, doubles over forward holding the belly, then straightens back up',
};
for (const [k, p] of Object.entries(FIGHT_MOVES)) add('motion', k, 'fal-ai/hunyuan-motion', { prompt: p, duration: k === 'block' ? 3 : 2, output_format: 'fbx' });
// second takes where the first came out wrong (the cross went overhead, the hook spun all the way round,
// the uppercut raised both arms); build_people.py picks the take per move (MOTION_TAKE)
const FIGHT_RETAKES = {
  cross_b: 'a person punches straight forward with the right fist into the face of someone standing in front of them, the right arm extends fully straight forward at shoulder height, the left hand stays up by the chin, then pulls back, feet stay in place',
  hook_b: 'a boxer throws a left hook punch: the left arm stays bent like a hook at shoulder height and swings in a short horizontal arc from the left side to in front of the face, the torso twists slightly to the right, feet stay planted, the right hand stays at the chin, then returns to guard',
  hook_c: 'a person punches with a short sideways left hook to the jaw of someone standing in front of them, the left arm bent, the body turning a little, feet in place',
  uppercut_b: 'a boxer throws a short right uppercut: the right fist dips to the waist then drives straight up in front of the chest to chin height with the elbow bent, the left hand stays up guarding the face, feet stay planted',
  uppercut_c: 'a person punches upward with the right fist into the chin of someone standing close in front of them, an uppercut with the elbow bent, the left hand stays at the face, feet in place',
  low_kick_b: 'a fighter kicks low with the right leg, swinging the right shin sideways into the knee of someone standing in front, the kick stays below the waist, then steps back into a fighting stance',
};
for (const [k, p] of Object.entries(FIGHT_RETAKES)) add('motion', k, 'fal-ai/hunyuan-motion', { prompt: p, duration: 2, output_format: 'fbx' });
