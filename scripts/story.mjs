// Campaign ("Night Shift") voice lines. Shared by the fal asset spec (TTS generation) and
// scripts/story_json.mjs, which writes public/assets/audio/talk/story.json for in-game subtitles.
// Speakers: dispatch = Sol, the courier dispatcher; mara = the night-market contact; vip = the executive passenger.
export const STORY_VOICES = { dispatch: 'Brian', mara: 'Aria', vip: 'Roger', crew: 'Charlie' };
export const STORY_NAMES = { dispatch: 'Sol · Dispatch', mara: 'Mara', vip: 'Mr. Ashgrove', crew: 'Street crew' };

export const STORY_LINES = {
  // 1 First Shift
  m1_brief: ['dispatch', "Welcome to the night shift. Simple job: grab the parcel on the strip, drop it across the district. Don't break anything. Including yourself."],
  m1_win: ['dispatch', 'Not bad for a first night. Stick around, courier.'],
  // 2 Last Few Meters (on foot)
  m2_brief: ['dispatch', "Client won't let cars near her stall. Park up at the market, walk the package in, and hand it to Mara. Personally."],
  m2_park: ['dispatch', 'This is as far as the car goes. Get out and walk it in.'],
  m2_mara: ['mara', "You're the new runner? Good. Tell Sol the rain came early this year. He'll know what it means."],
  m2_win: ['dispatch', "Mara likes you. That's rare. Don't let it go to your head."],
  // 3 Handle With Care (fragile)
  m3_brief: ['dispatch', 'Crate of antique glass lenses for the Backstreets. Every bump costs us. Smash it, and you are paying for it.'],
  m3_half: ['dispatch', "That one hurt. Half the crate's rattling. Easy now."],
  m3_win: ['dispatch', 'Not a single crack. The collector is impressed. So am I.'],
  m3_fail: ['dispatch', "I heard that from here. That's a crate of very expensive sand now."],
  // 4 Borrowed Wheels (steal a car)
  m4_brief: ['dispatch', 'Someone owes us a car. Orange muscle coupe, parked in the Backstreets. Take it to the chop garage. The owner may object.'],
  m4_got: ['dispatch', "That's the one. Now get it to the garage before the cops get curious."],
  m4_win: ['dispatch', 'Clean lift. The garage says thanks. Debt settled.'],
  // 5 Shadow (tail)
  m5_brief: ['dispatch', "A rival crew's been stealing our clients. Their van just pulled out. Follow it, stay out of sight, and find their drop."],
  m5_close: ['dispatch', "Too close. Back off, or they'll make you."],
  m5_far: ['dispatch', "You're losing them. Close the gap."],
  m5_win: ['dispatch', 'Got their drop point. Now we know where they nest.'],
  m5_fail: ['dispatch', "They're gone. Or they saw you. Either way, the trail's cold."],
  // 6 Sideways (drift)
  m6_brief: ['dispatch', 'The street crew is betting on you. Twenty-five hundred drift points before the clock dies. Make it loud.'],
  m6_cheer: ['crew', 'Yeah! Keep it sideways!'],
  m6_win: ['dispatch', 'The crew paid out. You just made us some friends.'],
  // 7 Executive Ride (VIP)
  m7_brief: ['dispatch', 'High paying executive needs a ride across downtown. Smooth driving only. He tips in comfort.'],
  m7_vip_in: ['vip', "Drive. And if you scratch this suit, you'll never work in this city again."],
  m7_vip_hit: ['vip', 'Do you mind? I am trying to read.'],
  m7_vip_out: ['vip', 'Adequate. You may keep the change.'],
  m7_win: ['dispatch', 'He tipped. He never tips.'],
  // 8 Glass Canyon (time trial)
  m8_brief: ['dispatch', 'Corporate racers set a record through the towers. Eight gates, one clock. Beat it.'],
  m8_win: ['dispatch', 'New record. Their boardroom is going to be very quiet tomorrow.'],
  // 9 Hot Package (police from the start)
  m9_brief: ['dispatch', "This parcel's flagged. The cops are already looking for it. Deliver it, and don't get boxed in."],
  m9_win: ['dispatch', 'Delivered under their noses. Beautiful.'],
  // 10 Fog Run (drones)
  m10_brief: ['dispatch', "Docks drop. Security drones patrol the yard. Keep moving and they can't lock on."],
  m10_win: ['dispatch', 'Through the fog and out. The docks are ours now.'],
  // 11 Clean Getaway (escape)
  m11_brief: ['dispatch', "Someone tipped off the cops. They're on you, right now. Lose every last star."],
  m11_win: ['dispatch', "Clean. They're chasing ghosts. Somebody sold us out, and I'm going to find out who."],
  // 12 Last Run (finale)
  m12_brief: ['dispatch', 'This is the big one. The core goes through three hands tonight. Three stops, three districts. After this, we stop hiding.'],
  m12_leg2: ['dispatch', "Core's moving. Downtown next. And yes, those are sirens."],
  m12_leg3: ['dispatch', 'Last leg. The docks. Drones in the air. Bring it home.'],
  m12_win: ['dispatch', 'You did it. The core is out, and the city is yours, courier. Take the rest of the night off.'],
  // shared
  gen_fail_time: ['dispatch', "Clock's dead. Come back and try it again."],
  gen_fail_busted: ['dispatch', 'Busted. I am not paying your bail twice.'],
  gen_go: ['dispatch', 'Go, go, go.'],
};
