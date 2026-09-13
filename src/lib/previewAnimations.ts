import type { Clip } from "./ghoul2";
import type { SaberMode } from "./sabers";

/** Stable actions keep the user's selection when the saber shape changes. */
const actions = {
  walk: { single: "BOTH_WALK2", staff: "BOTH_WALK_STAFF", duals: "BOTH_WALK_DUAL" },
  stand: { single: "BOTH_STAND2", staff: "BOTH_SABERSTAFF_STANCE", duals: "BOTH_SABERDUAL_STANCE" },
  crouch: "BOTH_CROUCH1IDLE",
  sit: "BOTH_SIT2",
  meditate: "BOTH_MEDITATE",
  bow: "BOTH_BOW",
  taunt: "BOTH_ENGAGETAUNT",
  flourish: { single: "BOTH_SHOWOFF_MEDIUM", staff: "BOTH_SHOWOFF_STAFF", duals: "BOTH_SHOWOFF_DUAL" },
  victory: { single: "BOTH_VICTORY_MEDIUM", staff: "BOTH_VICTORY_STAFF", duals: "BOTH_VICTORY_DUAL" },
  kataFast: { single: "BOTH_A1_SPECIAL" },
  kataMedium: { single: "BOTH_A2_SPECIAL" },
  kataStrong: { single: "BOTH_A3_SPECIAL" },
  kata: { staff: "BOTH_A7_SOULCAL", duals: "BOTH_A6_SABERPROTECT" },
} as const;
export type PreviewAction = keyof typeof actions;
export const animationLabels = {
  walk: "modelPreview.actions.walk", stand: "modelPreview.actions.stand",
  crouch: "modelPreview.actions.crouch", sit: "modelPreview.actions.sit",
  meditate: "modelPreview.actions.meditate", bow: "modelPreview.actions.bow",
  taunt: "modelPreview.actions.taunt", flourish: "modelPreview.actions.flourish",
  victory: "modelPreview.actions.victory", kataFast: "modelPreview.actions.kataFast",
  kataMedium: "modelPreview.actions.kataMedium", kataStrong: "modelPreview.actions.kataStrong",
  kata: "modelPreview.actions.kata",
} as const;

export function previewAnimations(clips: Clip[], mode: SaberMode, weaponPose?: string) {
  return (Object.keys(actions) as PreviewAction[]).flatMap(id => {
    const action = actions[id];
    if (weaponPose && id !== "stand") return [];
    const name = weaponPose ?? (typeof action === "string" ? action : (action as Partial<Record<SaberMode, string>>)[mode]);
    const clip = clips.find(c => c.name === name)
      ?? (id === "walk" ? clips.find(c => c.name === "BOTH_WALK1") : undefined)
      ?? (id === "stand" ? clips.find(c => c.name === "BOTH_STAND1") : undefined);
    return clip ? [{ id, clip }] : [];
  });
}

/** Seated poses hold; gestures and katas repeat with a short final-frame pause. */
export function previewFrame(clip: Clip, seconds: number, action: PreviewAction): number {
  const duration = clip.count / Math.abs(clip.fps);
  const hold = ["sit", "crouch", "meditate", "stand"].includes(action);
  const time = hold ? seconds : seconds % (duration + (clip.loop < 0 ? 0.65 : 0));
  const offset = Math.min(clip.count - 1, time * Math.abs(clip.fps));
  return clip.first + (clip.fps < 0 ? clip.count - 1 - offset : offset);
}
