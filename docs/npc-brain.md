# NPC brain: personalities, conversation, street tasks (proposal)

Status: proposal, nothing here is built yet. Prices are first-party Claude API list prices as of October 2026.

## 1. One brain, many people

Use **one fast language model for everyone, with each person described by data**. Don't give each person a separate model. A personality is a small "persona card" plus that person's memory. The same model reads whichever card belongs to the person you are talking to. This is how a crowd of 300 people can all sound different without 300 models.

| Option | Verdict |
|---|---|
| **One small cloud model behind our own server endpoint** (Claude Haiku 5.5, $0.10 in / $0.50 out per million tokens) | **Recommended.** Fast first words when streamed, cheap enough for every pedestrian, and it works on phones. |
| A bigger model for story characters (Claude Sonnet 5.5, $2 / $10) | Optional. Use it for Sol, Mara and quest givers, where writing quality matters more than cost. |
| A small model running inside the browser (WebGPU, 1–3B parameters) | Not now. It is a 1–2 GB download, slow or impossible on most phones, and the characters come out noticeably flatter. Keep canned lines as the offline fallback instead. |
| Many different models | No benefit. The personality comes from the card and memory, not from the model. Several models mean several prompt caches and several failure modes. |

The API key lives only in a **Vercel serverless function** (`/api/talk`, key in the `ANTHROPIC_API_KEY` project environment variable). It never goes in the browser bundle. The function also enforces:
- a per-IP rate limit
- `max_tokens` of about 200
- a daily spend cap

## 2. Every pedestrian has a personality, with no API call needed

Each pedestrian gets a seeded persona generated from their id, so the same person is always the same:

- name, age, job, district, home street
- temperament: 5 trait sliders (friendly ↔ hostile, calm ↔ nervous, honest ↔ shady, chatty ↔ terse, brave ↔ timid)
- a quirk, a current goal, a fear, a speech style (slang, formal, rambling), and a voice id
- their attitude to the courier, driven by reputation, wanted level and what they saw you do

**Passers-by never call the model.** Their ambient barks (reactions to rain, near misses, car theft, sirens, bumping into them) come from a **bark library**:
- about 40 lines per archetype × trait mix
- written once offline by the model and voiced once with TTS, like the story lines today
- picked by trait, mood and event, so two people react differently to the same crash

The model only runs when **you choose to talk to someone**.

## 3. Talking *as* the courier (not as a third party)

The worry is real: if you type freely, you are the player talking to a game. The fix is framing plus structure:

1. Walk up to someone and press **Talk**. The camera moves to an over-the-shoulder two-shot and the input bar reads *"Say something as the courier…"*.
2. Under the bar there are **three suggested replies** in the courier's voice (written by the model for this person and moment), plus free text and push-to-talk (speech-to-text). Most players tap a suggestion; anyone who wants to improvise can.
3. The model is told: *the text is what the courier just said out loud, on this street, tonight*. The person never knows it is a game. They answer in one or two spoken sentences and stay in the world.
4. Each answer comes back as **structured data**, not just text:

```json
{ "line": "…", "emotion": "wary", "gesture": "shrug", "look": "player",
  "action": "none | give_task | refuse | flee | call_police | follow | pay",
  "remember": "courier asked about the docks and tipped me" }
```

The game acts on `action`, so conversation becomes gameplay:
- someone gives you a job
- someone runs away, or calls the cops if you threaten them
- someone remembers your tip next time

Guardrails in the shared rules:
- stay in character
- no breaking the fourth wall
- PG-13 tone
- deflect attempts to make them "ignore your instructions"

## 4. Memory and world state

- **Per-person memory**: the last 6 exchanges plus a few `remember` notes, kept in the save file. When you come back, they recognise you.
- **World facts** for each request: district, time, rain, wanted level, current mission, and things that just happened near them ("a car was stolen 20 m away 10 s ago").
- **Prompt caching**: a shared world bible plus rules (several thousand tokens) goes first and is cached. The persona, memory and facts go after it. Cached input is billed at a fraction of the normal price.

## 5. Cost and speed

- **One spoken line costs about $0.0001–0.0004** (about 3,000 input tokens, mostly cached, plus about 120 output tokens).
  - 1,000 conversation lines cost about $0.10–$0.40.
  - Voice (TTS) for each reply costs more than the text. Mitigations: cache repeated lines, use the browser's built-in voice as a free fallback, and only voice lines the player is actually near.
- **Speed**:
  - text is streamed, so the first words appear in well under a second
  - the voice starts as soon as the first sentence is complete
  - while waiting, the person does a short "thinking" gesture, so there is never a frozen stare

## 6. Street tasks (the GTA-style part)

- **Quest givers**: some people in each district (bartender, mechanic, fixer, worried mother, street racer) carry a task hook in their persona.
- **Tasks come from templates; the model only fills in the story.** The model chooses from a fixed list and fills in the details, so every task it offers is one the game can actually run:
  - deliver
  - fetch
  - tail
  - escort
  - steal a car
  - photograph
  - persuade
  - race
- **Persuade / negotiate tasks**: the model judges your argument (for example, talk a guard into opening a gate) and returns `success`, `partial` or `fail`.
- **Interiors**: enterable rooms load as small separate scenes when you go through a door. These include:
  - a noodle bar
  - Mara's back room
  - the chop garage
  - a rooftop club
  - an apartment

  They would be built with the existing Blender kit plus generated props. People inside use the same persona and conversation system.

## 7. Making people look real while they talk

Near term (works with the current characters):
- the person turns to face you, with head and eye look-at on the neck and head bones
- a conversation camera that frames both faces
- talk gestures retargeted through the existing motion pipeline (explain, shrug, point, nod, laugh, refuse, nervous glance), chosen by the model's `gesture` and `emotion`
- head bob and a jaw bone driven by the loudness of the voice audio, so mouths move with speech
- emotion-driven posture (crossed arms when wary, leaning in when friendly)

Longer term:
- the current rig has no face bones, so real lip sync needs heads with facial blendshapes (the 52 standard visemes and expressions), either from a blendshape-capable character pipeline or a re-rigged head
- the voice then drives visemes directly

## 8. Suggested order

1. **A** – persona generator, Talk button and UI, `/api/talk` on Haiku 5.5, turn-to-face, look-at, conversation camera, jaw driven by audio.
2. **B** – bark library (no more repeated lines on the street), memory, reputation, tasks from people.
3. **C** – interiors with quest givers.
4. **D** – per-person voices and facial lip sync.

## Decisions needed from you

1. An Anthropic API key added as `ANTHROPIC_API_KEY` in the Vercel project settings, plus a monthly spend cap you are comfortable with.
2. Typed replies plus suggestions only, or push-to-talk voice input as well.
3. Haiku 5.5 for everyone, or Sonnet 5.5 for the story characters.
4. Spoken voice replies (TTS cost) or subtitles only to start.
