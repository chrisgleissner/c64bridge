import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SIDWAVE_EXAMPLES_URI = "c64://sound/examples";

export const SIDWAVE_EXAMPLES = [
  { name: "chiptune_drive", title: "Neon Run", style: "Chip arpeggios, gliding pulse lead and drum break" },
  { name: "ambient_filter", title: "Blue Current", style: "Slow pads, filtered bass and ring modulated bells" },
  { name: "funk_bass", title: "Copper Steps", style: "Syncopated filter bass, chord chops and sync accents" },
  { name: "acid_line", title: "Pressure Glass", style: "Acid bass, resonance accents and slides over a four-on-the-floor kick" },
  { name: "arp_ballad", title: "A Window in Rain", style: "Minor ballad with chord arpeggios and a connected PWM lead" },
  { name: "drum_and_bass", title: "Switchyard", style: "Breakbeats and a pair of detuned Reese bass oscillators" },
  { name: "digi_groove", title: "Paper Circuit", style: "CIA2 volume digis with syncopated synth bass and arpeggios" },
  { name: "metal_sync", title: "Iron Weather", style: "Hard sync, ring modulation, double kick and power chords" },
  { name: "stereo_echo", title: "Parallax Letters", style: "Two SIDs with stereo echo, ping-pong arpeggios and unison pads" },
  { name: "chamber_waltz", title: "Gilt Footsteps", style: "Three independent voices in 3/4 with no percussion" },
  { name: "title_fanfare", title: "The Gate Opens", style: "Short filtered brass fanfare with timpani and a held cadence" },
  { name: "ultisid_orchestra", title: "An Atlas of Wind", style: "Eight SIDs with divided strings, twin echo leads, arps and a drum kit" },
  { name: "wall_of_sid", title: "Twenty-Seven Lanterns", style: "Nine SIDs and a gradual build to a 27-voice finale" },
] as const;

export type SidwaveExampleName = typeof SIDWAVE_EXAMPLES[number]["name"];

export function sidwaveExamplePath(name: SidwaveExampleName): string {
  return `data/sound/examples/${name}.yaml`;
}

export function readSidwaveExample(name: SidwaveExampleName): string {
  return readFileSync(join(fileURLToPath(new URL("../", import.meta.url)), sidwaveExamplePath(name)), "utf8");
}
