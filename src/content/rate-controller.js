// Preset baseline delays in milliseconds.
const PRESET_BASELINES = Object.freeze({
  fast: 500,
  normal: 1000,
  moderate: 2000,
  slow: 5000,
  stealth: 4500,
});

const MIN_CUSTOM_MS = 100;
const MAX_CUSTOM_MS = 60000;
const ADAPTIVE_STEP = 0.5;
const ADAPTIVE_CAP = 4;

function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function createRateController() {
  let preset = "normal";
  let baselineMs = PRESET_BASELINES.normal;
  let customMs = null;
  let backoffSteps = 0;

  function applyPreset(name) {
    if (name === "custom") {
      preset = "custom";
      if (customMs == null) {
        baselineMs = PRESET_BASELINES.normal;
      } else {
        baselineMs = clampInt(customMs, MIN_CUSTOM_MS, MAX_CUSTOM_MS);
      }
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(PRESET_BASELINES, name)) {
      preset = "normal";
      baselineMs = PRESET_BASELINES.normal;
      return;
    }
    preset = name;
    baselineMs = PRESET_BASELINES[name];
  }

  return {
    setPreset(nextPreset) {
      applyPreset(nextPreset);
    },

    setCustomDelay(ms) {
      customMs = clampInt(ms, MIN_CUSTOM_MS, MAX_CUSTOM_MS);
      if (preset === "custom") {
        baselineMs = customMs;
      }
    },

    getDelay() {
      const multiplier = 1 + backoffSteps * ADAPTIVE_STEP;
      const capped = Math.min(multiplier, ADAPTIVE_CAP);
      return Math.round(baselineMs * capped);
    },

    sleep() {
      const ms = this.getDelay();
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    },

    adaptiveReset() {
      backoffSteps = 0;
    },

    adaptiveBackoff() {
      if (backoffSteps < 6) {
        backoffSteps += 1;
      }
    },

    preset() {
      return preset;
    },

    customMs() {
      return customMs;
    },

    snapshot() {
      const multiplier = 1 + backoffSteps * ADAPTIVE_STEP;
      const capped = Math.min(multiplier, ADAPTIVE_CAP);
      return {
        preset,
        baselineMs,
        multiplier: capped,
        effectiveMs: Math.round(baselineMs * capped),
      };
    },
  };
}
