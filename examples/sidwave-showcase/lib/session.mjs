// One scripted session of Pulse Guard in headless VICE, shared by verify.mjs and record.mjs.
//
// The script plays through the joystick: title, a first game up to the second wave, then it stops dodging until
// the ship is destroyed, waits on the game-over screen, returns to the title and starts a second game.
import { JOY, STATE, gameReader, pilot } from "./pilot.mjs";
import { startVice } from "./vice.mjs";

export async function playSession(game, { frames, wav, warp = false, titleFrames = 400, carelessAfterWave2 = 500, onFrame, onSfx, logFile }) {
  const vice = await startVice(game.file, { breakAddress: game.labels.irq, wav, warp, logFile });
  const { monitor } = vice;
  const read = gameReader(game.labels);
  const result = { frames: 0, transitions: [], frameGaps: 0, maxScore: 0, maxWave: 0, overruns: 0, playMax: 0, minShield: 5 };
  try {
    if (onSfx) await monitor.breakAt(game.labels.sfx);
    const palette = await monitor.palette();
    let previous;
    let since = 0;
    let wave2 = 0;
    let careless = false;
    for (let frame = 0; frame < frames; ) {
      if (onSfx) {
        const pc = await monitor.register(3);
        if (pc === game.labels.sfx) {
          onSfx(await monitor.register(0), frame);
          await monitor.resume();
          await monitor.waitForStop();
          continue;
        }
      }
      const state = await read(monitor);
      if (previous && ((state.frame - previous.frame) & 255) !== 1) result.frameGaps += 1;
      if (state.state !== previous?.state) {
        since = frame;
        result.transitions.push({ frame, state: state.state, score: state.score, wave: state.wave, shield: state.shield });
      }
      if (state.state === "play" && state.wave === 2) wave2 += 1;
      if (wave2 > carelessAfterWave2) careless = true;
      if (state.state === "over") careless = false, wave2 = -1e9;
      let joystick = 0;
      if (state.state === "title") joystick = frame - since >= titleFrames && frame % 20 < 4 ? JOY.FIRE : 0;
      else if (state.state === "over") joystick = frame - since >= 620 && frame % 20 < 4 ? JOY.FIRE : 0;
      else joystick = pilot(state, { careless });
      await monitor.joystick(joystick);
      if (onFrame) await onFrame({ frame, state, monitor, palette, since });
      result.maxScore = Math.max(result.maxScore, state.score);
      result.maxWave = Math.max(result.maxWave, state.wave);
      if (state.state !== "title") result.minShield = Math.min(result.minShield, state.shield);
      result.overruns = state.overruns;
      result.playMax = state.playMax;
      previous = state;
      frame += 1;
      result.frames = frame;
      await monitor.resume();
      await monitor.waitForStop();
    }
  } finally {
    await vice.stop();
  }
  return result;
}

export { STATE };
