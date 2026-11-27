// A simple player for Pulse Guard: it reads the game's variables each frame and returns joystick bits.
// verify.mjs and record.mjs use it to play the game through the emulated joystick.
export const STATE = ["title", "play", "warn", "boss", "bossDies", "clear", "dies", "over"];
const OBJS = 5;
const T = { drone: 1, moth: 2, hunter: 3, cell: 4, bomb: 5 };
const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8, FIRE = 16;

export function gameReader(labels) {
  const start = labels.vars;
  const length = labels.vars_end - labels.vars;
  return async (monitor) => {
    const bytes = await monitor.read(start, length);
    const byte = (name, i = 0) => bytes[labels[name] - start + i];
    const bcd = (name, count) => Number([...Array(count)].map((_, i) => byte(name, count - 1 - i).toString(16).padStart(2, "0")).join(""));
    return {
      frame: byte("frame"),
      state: STATE[byte("state")],
      score: bcd("score", 3),
      hiscore: bcd("hiscore", 3),
      wave: byte("wave"),
      shield: byte("shield"),
      px: byte("px"),
      py: byte("py"),
      invulnerable: byte("invuln"),
      spawned: byte("spawned"),
      overruns: byte("overruns"),
      playMax: byte("play_max") + 256 * byte("play_max", 1),
      bossX: byte("boss_x"),
      bossHp: byte("boss_hp"),
      objects: [...Array(OBJS)].map((_, i) => ({ type: byte("otype", i), x: byte("ox", i), y: byte("oy", i) })).filter((o) => o.type !== 0),
    };
  };
}

/** The joystick for one frame. `careless` stops dodging, so the ship is eventually destroyed. */
export function pilot(game, { careless = false } = {}) {
  const { px, py, objects, state } = game;
  const hostile = objects.filter((o) => o.type === T.drone || o.type === T.moth || o.type === T.hunter || o.type === T.bomb);
  if (careless) {
    const nearest = hostile.sort((a, b) => b.y - a.y)[0];
    const goal = nearest ? nearest.x : state === "boss" ? game.bossX + 12 : 84;
    return (goal > px + 1 ? RIGHT : goal < px - 1 ? LEFT : 0) | (py > 190 ? UP : 0);
  }
  let goal = 84;
  const cell = objects.find((o) => o.type === T.cell && o.y > 90 && o.y < py + 8);
  const target = hostile.filter((o) => o.type !== T.bomb && o.y < py - 30).sort((a, b) => b.y - a.y)[0];
  if (state === "boss") goal = game.bossX + 12;
  else if (target) goal = target.x + (target.type === T.moth ? 4 * Math.sign(84 - target.x) : 0);
  if (cell && (game.shield < 5 || !target)) goal = cell.x;
  // Dodge: score every candidate position by the threats close to it, then prefer the one nearest the goal.
  const danger = (x) => hostile.reduce((sum, o) => {
    const ahead = py - o.y;
    const reach = o.type === T.bomb ? 70 : 55;
    return ahead > -18 && ahead < reach && Math.abs(o.x - x) < 13 ? sum + (reach - ahead) : sum;
  }, 0);
  let best = px;
  let bestCost = Infinity;
  for (let x = 16; x <= 154; x += 2) {
    // Positions behind a threat cannot be reached without crossing it.
    const path = Math.abs(x - px) > 10 ? danger(Math.round((x + px) / 2)) : 0;
    const cost = danger(x) * 100 + path * 30 + Math.abs(x - goal) + Math.abs(x - px) * 0.1;
    if (cost < bestCost) [best, bestCost] = [x, cost];
  }
  const vertical = py < 204 ? DOWN : py > 214 ? UP : 0;
  return (best > px + 1 ? RIGHT : best < px - 1 ? LEFT : 0) | vertical | FIRE;
}

export const JOY = { UP, DOWN, LEFT, RIGHT, FIRE };
