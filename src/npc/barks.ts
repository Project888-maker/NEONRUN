// Things people say on their own as the courier passes: reactions to what happens around them.
// Written lines (no model call), spoken in each person's own voice and never repeated back to back.
import * as THREE from 'three';

export type BarkEvent = 'greet' | 'bump' | 'near_miss' | 'carjack' | 'hit' | 'wanted' | 'phone' | 'fight' | 'taunt' | 'beg';

export const BARKS: Record<string, Record<BarkEvent, string[]>> = {
  ped_suit: {
    greet: ['Evening.', "Not now, I'm on a call in five.", 'You look like you work for a living. Respect.'],
    bump: ['Watch it! This coat costs more than your car.', 'Excuse you.', 'Do you mind?'],
    near_miss: ['Are you insane?! I will have your licence!', 'Some of us have board meetings to survive to!', 'Unbelievable. Absolutely unbelievable.'],
    carjack: ["Somebody call security, that man just stole a car!", "I'm not seeing this. I am not a witness."],
    hit: ['Oh God. Someone call an ambulance!', "I didn't see anything, I didn't see anything."],
    wanted: ["Isn't that the courier the police are after?", 'Keep walking, keep walking.'],
    phone: ['No, sell. Sell everything. I said sell!', 'Tell the board I am stuck in traffic. Again.'],
    fight: ["Security! There's a fight out here!", "Animals. Absolute animals."],
    taunt: ["You just assaulted the wrong man. My lawyer will bury you.", "Fine. Let's do this the old way."],
    beg: ["Take my wallet, just take it!", "Please, I have a family!"],
  },
  ped_vendor: {
    greet: ['Hungry? Two credits, best broth on the strip!', 'Ah, a courier. Busy night, eh?', 'Rain is good for business. Come, sit!'],
    bump: ['Hey, careful, careful!', 'Watch the cart, kid!', 'Slow down, the noodles are not going anywhere.'],
    near_miss: ['Hey! My cart! You almost took my cart!', 'Crazy driver! Thirty years on this corner, never seen worse!', 'Aiya! Slow down!'],
    carjack: ['Thief! Somebody stop him!', 'In broad daylight! Well, broad night.'],
    hit: ['Somebody help! Get a doctor!', 'Terrible, terrible driving in this city.'],
    wanted: ['Cops everywhere tonight. Bad for business.', 'You keep moving, kid. Trouble follows you.'],
    phone: ['Two crates of greens, not one. Two!', 'Yes, yes, tell your mother I am coming home early. I am lying.'],
    fight: ["Hey! Hey! Not in front of my stall!", "Somebody break it up!"],
    taunt: ["You want trouble? Thirty years on this corner, I know trouble!", "Come on then, kid!"],
    beg: ["Aiya! Stop, stop! I'm an old man!", "Take the soup, take anything!"],
  },
  ped_punk: {
    greet: ["What're you looking at?", 'Nice ride. Steal it yourself?', 'Sup, courier.'],
    bump: ['Back off!', 'You want a problem?', 'Personal space, delivery boy!'],
    near_miss: ['Whoa! Do that again and I key your car!', "Ha! Nearly! Do it again, I dare you!", 'Learn to drive, idiot!'],
    carjack: ["Ha! That's cold. Respect.", 'Oh, somebody is having a bad night.'],
    hit: ["Oh no. Oh no no no. Someone call it in!", 'Dude, you just hit someone!'],
    wanted: ["Cops are on you, man. Run!", "Don't lead them over here!"],
    phone: ['The gig got cancelled again. Again!', "Tell him I'm not paying for the amp."],
    fight: ["Fight! Fight! Fight!", "Ha! Somebody's getting wrecked!"],
    taunt: ["Oh, you're dead now.", "That all you got, delivery boy?"],
    beg: ["Okay, okay! I'm done, I'm done!", "Get off me, psycho!"],
  },
  ped_worker: {
    greet: ['Evening, pal.', 'Long shift. Too long.', 'Couriers. Always in a hurry.'],
    bump: ['Easy there, pal.', 'Watch where you are going.', 'Hey. Eyes up.'],
    near_miss: ['Slow it down! This is a work zone!', "You'll kill someone driving like that!", 'Idiot! Kids walk here!'],
    carjack: ['Hey! Get out of that car!', "That's not yours, pal!"],
    hit: ['Man down! Somebody call it in!', "Don't move him, don't move him!"],
    wanted: ['Cops are looking for someone like you.', "I didn't see you. Keep going."],
    phone: ["Yeah, I'll do the double shift. What choice do I have?", 'Tell the foreman the crane is jammed again.'],
    fight: ["Hey! Break it up, the both of you!", "Somebody call the cops, there's a fight!"],
    taunt: ["Big mistake, pal. Big mistake.", "Twelve hours on the docks and now this. Come here."],
    beg: ["Enough! I yield, I yield!", "I got kids, man! Stop!"],
  },
  ped_student: {
    greet: ['Oh, hi!', "Wait, aren't you that courier?", 'Sorry, exam tomorrow, can\'t talk!'],
    bump: ['Oh! Sorry! Sorry!', 'Ow. Okay. Fine.', 'Watch it, please!'],
    near_miss: ['Oh my god, I almost died!', 'Are you serious?! Learn to drive!', 'I am so posting this.'],
    carjack: ['Did he just steal that car?!', 'Okay, I am recording this.'],
    hit: ['Oh my god! Somebody help them!', "I'm calling an ambulance, I'm calling!"],
    wanted: ['The police are looking for you, you know.', 'Please do not drag me into this.'],
    phone: ['No, I have not started the essay. Stop asking.', 'Mum, I am fine, it is just raining.'],
    fight: ["Oh my god, they're fighting!", "Somebody film this! No, wait, call someone!"],
    taunt: ["Seriously? Fine. I did two years of kickboxing.", "Back off or I swear I'll hit you."],
    beg: ["Stop! Please! Help!", "Don't hurt me, please!"],
  },
  ped_elder: {
    greet: ['Good evening, young man.', 'Such a polite boy. Off you go now.', 'Wear a coat, you will catch your death.'],
    bump: ['Mind your manners!', 'Young people. Always rushing.', 'Watch the old lady!'],
    near_miss: ['In my day we drove like civilised people!', 'You nearly gave me a heart attack!', 'Slow down, young man!'],
    carjack: ["Shameful! Your mother would be ashamed!", 'Somebody stop that thief!'],
    hit: ['Oh heavens. Someone call a doctor!', 'Terrible. Just terrible.'],
    wanted: ['The police are after you? What have you done now?', 'Behave yourself, young man.'],
    phone: ['No dear, I can read the menu myself. Hello? Hello?', 'Yes, I took my pills. Both of them.'],
    fight: ["Shameful! In my day we settled things with words!", "Someone stop them before somebody gets killed!"],
    taunt: ["I fought in a war, boy. Come on.", "You think I'm afraid of you?"],
    beg: ["Help! He's attacking an old woman!", "Please, have some decency!"],
  },
  ped_techwear: {
    greet: ['Analog courier. Cute.', 'Hey.', 'Your car is leaking data, you know.'],
    bump: ['Collision detected. Rude.', 'Watch the hardware!', 'Personal space, please.'],
    near_miss: ['Whoa. Pedestrian detection is a thing, you know!', 'That was a near miss. Logging it.', 'Nice reflexes. Mine, not yours.'],
    carjack: ['Hot-wire speedrun. Impressive.', 'That car is going to report itself stolen in about ten seconds.'],
    hit: ['Someone call it in, my implant is already pinging emergency!', 'Not good. Not good.'],
    wanted: ['Police drones are tracking you. I can see the pings.', 'Stay off the cameras, man.'],
    phone: ['No, the firmware is fine. The user is the problem.', "Ping me when the drop's ready."],
    fight: ["Fight on the strip. Logging it.", "Somebody's getting their face rebooted."],
    taunt: ["Bad move. Really bad move.", "I've got augments, you've got nothing."],
    beg: ["Okay, stop! System's down, I'm down!", "Not the face! Not the implants!"],
  },
  ped_nurse: {
    greet: ['Evening. Stay safe out there.', 'Twelve hour shift. I just want my bed.', 'Hi there.'],
    bump: ['Careful!', 'Mind where you are going.', 'Excuse me!'],
    near_miss: ["If you crash that thing, I'm the one patching you up!", 'Slow down! I see what that does to people!', 'Really? Really?'],
    carjack: ['Hey! Somebody call the police!', 'Unbelievable.'],
    hit: ['Nobody move them! I am a nurse!', 'Call an ambulance, now!'],
    wanted: ['The cops are on you. Whatever you did, stop.', "I don't want to see you on my table tonight."],
    phone: ['Bed seven needs another bag, I told them that.', "I'll be home by six. Maybe seven."],
    fight: ["Stop it! I'm not stitching either of you up tonight!", "Somebody call it in, there's a fight!"],
    taunt: ["I deal with drunks all night. You don't scare me.", "Touch me again and you'll need a doctor."],
    beg: ["Help! I'm a nurse, please stop!", "Somebody help me!"],
  },
  ped_rider: {
    greet: ['Hey, competition! Good luck tonight!', 'Rain makes the tips better, right?', 'Yo, courier.'],
    bump: ['Easy, easy!', "Whoa, I'm on the clock here!", 'Watch it, bro.'],
    near_miss: ['Hey! Riders have rights too!', 'Woah! Nearly took my mirror!', 'Brake, man, brake!'],
    carjack: ["Damn. That's one way to get a ride.", 'Glad that is not my bike.'],
    hit: ['Call an ambulance! Somebody!', 'Oh man. Oh man.'],
    wanted: ['Cops are all over you! Take the bridge, it is faster!', 'Ditch them in the alleys!'],
    phone: ['Order is late, I know, the rain, I know!', "Five stars, please, I'm begging you."],
    fight: ["Whoa, whoa, fight in the street!", "Somebody's gonna get hurt!"],
    taunt: ["Couriers think they own the street. Not tonight.", "Come on then! I've been waiting all night for this!"],
    beg: ["Okay, okay! Take the bike, just stop!", "I'm out, I'm out!"],
  },
};

export interface BarkHost {
  crowdPeds(): { id: number; type: string; pos: THREE.Vector3; state: string; key?: string }[];
  /** the person's display name for the subtitle and their voice */
  speaker(ped: { id: number; type: string; pos: THREE.Vector3; key?: string }): { name: string; voice: string; speed: number; key: string };
  voice(voice: string, text: string, speed: number): Promise<AudioBuffer | null>;
  play(buf: AudioBuffer, pos: THREE.Vector3): void;
  subtitle(who: string, text: string, dur: number): void;
  voiceOn(): boolean;
  quiet(): boolean; // e.g. in a conversation or menu
}

/** Picks who says what and when, so the street reacts without anyone repeating themselves. */
export class Barks {
  private nextAt = new Map<number, number>(); // per pedestrian
  private used = new Map<string, Set<string>>(); // per person: lines already said
  private globalAt = 0;
  private t = 0;

  constructor(private h: BarkHost) {}

  /** Something happened at `at`: the nearest suitable bystander within `radius` may react. */
  event(ev: BarkEvent, at: THREE.Vector3, radius: number, chance = 1) {
    if (Math.random() > chance) return;
    let best: ReturnType<BarkHost['crowdPeds']>[number] | null = null, bd = radius;
    for (const p of this.h.crowdPeds()) {
      if (p.state === 'down' || p.state === 'talk' || p.state === 'fight' || p.state === 'getup' || (this.nextAt.get(p.id) ?? 0) > this.t) continue;
      const d = p.pos.distanceTo(at);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) this.say(best, ev, ev === 'carjack' || ev === 'hit' || ev === 'fight');
  }

  /** Per frame: greetings, bumps, wanted-courier remarks and phone chatter near the courier. */
  update(dt: number, player: THREE.Vector3, onFoot: boolean, speed: number, wanted: boolean) {
    this.t += dt;
    if (this.h.quiet()) return;
    for (const p of this.h.crowdPeds()) {
      if (p.state === 'down' || p.state === 'talk' || p.state === 'flee' || p.state === 'fight' || p.state === 'getup') continue; // nobody says good evening mid-brawl
      if ((this.nextAt.get(p.id) ?? 0) > this.t) continue;
      const d = p.pos.distanceTo(player);
      if (onFoot && d < 0.95 && speed > 2.5) { this.say(p, 'bump', true); continue; }
      if (d > 7) { if (p.state === 'phone' && d < 11 && Math.random() < dt * 0.15) this.say(p, 'phone'); continue; }
      if (wanted && Math.random() < dt * 0.25) { this.say(p, 'wanted'); continue; }
      if (onFoot && d < 3.2 && speed < 2.5 && Math.random() < dt * 0.35) this.say(p, 'greet');
    }
  }

  /** A specific person speaks right now (a victim begging, a fighter squaring up). */
  sayAs(p: ReturnType<BarkHost['crowdPeds']>[number], ev: BarkEvent) {
    if ((this.nextAt.get(p.id) ?? 0) > this.t + 20) return; // spoke very recently
    this.nextAt.delete(p.id);
    void this.say(p, ev, true);
  }

  private async say(p: ReturnType<BarkHost['crowdPeds']>[number], ev: BarkEvent, urgent = false) {
    if (!urgent && this.globalAt > this.t) return;
    const lines = BARKS[p.type]?.[ev];
    if (!lines?.length) return;
    const who = this.h.speaker(p);
    let used = this.used.get(who.key);
    if (!used) { used = new Set(); this.used.set(who.key, used); }
    let fresh = lines.filter((l) => !used!.has(l));
    if (!fresh.length) { for (const l of lines) used.delete(l); fresh = lines; }
    const line = fresh[Math.floor(Math.random() * fresh.length)];
    used.add(line);
    const dur = Math.min(5, 0.9 + line.split(/\s+/).length * 0.3);
    this.nextAt.set(p.id, this.t + 25 + Math.random() * 20);
    this.globalAt = this.t + dur + 2.5;
    const pos = p.pos.clone().setY(1.6);
    this.h.subtitle(who.name, line, dur + 0.4);
    if (!this.h.voiceOn()) return;
    const buf = await this.h.voice(who.voice, line, who.speed);
    if (buf && !this.h.quiet()) this.h.play(buf, pos);
  }
}
