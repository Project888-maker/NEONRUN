// Writes public/assets/audio/talk/story.json (campaign subtitles) from scripts/story.mjs.
import fs from 'node:fs';
import { STORY_LINES, STORY_NAMES } from './story.mjs';
fs.writeFileSync(new URL('../public/assets/audio/talk/story.json', import.meta.url), JSON.stringify({ names: STORY_NAMES, lines: STORY_LINES }));
console.log('story.json', Object.keys(STORY_LINES).length, 'lines');
