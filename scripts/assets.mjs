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

export const ASSETS = A;
