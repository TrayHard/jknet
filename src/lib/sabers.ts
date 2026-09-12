// --- slice: skins and hilts ---
/**
 * The three shapes a lightsaber takes, and the profile values each one writes.
 *
 * The engine has no cvar for «what shape am I carrying». It has four values —
 * `saber1`, `saber2`, `color1`, `color2` — and the shape falls out of them,
 * which is exactly what the game's own menu does with its `ui_saber_type`:
 * `UI_UpdateSaberType` (`codemp/ui/ui_main.c:5343-5353` of OpenJK `1a6a6434`)
 * blanks `ui_saber2` for **single** and **staff** and leaves it alone for
 * **dual**, and `UI_UpdateSaberCvars` (`ui_main.c:5246-5260`) then copies the
 * four cvars out. The type itself is never stored: `UI_GetSaberCvars`
 * (`ui_main.c:5418-5429`) reads `saber1`, `saber2`, `color1` and `color2`
 * back and the line that would have restored `ui_saber_type` is commented out
 * (`ui_main.c:5420`).
 *
 * A player profile does the same and for the same reason — a stored shape
 * could disagree with the values under it, and then two fields would describe
 * one thing.
 *
 * ## Which colour paints which blade
 *
 * `CG_AddSaberBlade` picks the colour by the **hilt** number and never by the
 * blade number: `scolor = client->icolor1` for `saberNum == 0` and
 * `client->icolor2` for the second hilt (`codemp/cgame/cg_players.c:6130-6140`).
 * A staff is one hilt with `numBlades == 2`, so both of its blades take
 * `color1` and `color2` paints nothing at all. Two single hilts are two hilts,
 * so each takes a colour of its own. The game's own menu preview agrees
 * (`codemp/ui/ui_saber.c:356-365`).
 */
import { NO_SECOND_HILT, type SaberHilt } from "./ipc";

/**
 * The shape the player picks: one hilt, one double-bladed hilt, or two hilts.
 *
 * The words are the launcher's. The engine's own three are `single`, `staff`
 * and `dual` (`codemp/ui/ui_main.c:5279`, `:5286`, `:5348-5349`); **Duals** is
 * plural here because the control names what the player is holding and two
 * sabers are two of them.
 */
export type SaberMode = "single" | "staff" | "duals";

/** The three, in the order the control draws them. */
export const SABER_MODES: readonly SaberMode[] = ["single", "staff", "duals"];

/** The four profile fields the hilt control owns. */
export interface SaberValues {
  saber1: string | null;
  saber2: string | null;
  color1: number | null;
  color2: number | null;
}

/**
 * The `saberType` of a hilt this client offers, or `null` when the list has
 * never heard of it.
 *
 * `null` covers three cases that behave the same: no hilt at all, the value
 * `none` that means an empty second hand, and a hilt a mod once provided and
 * no longer does. None of the three says anything about a shape.
 */
export function hiltTypeOf(hilts: SaberHilt[], id: string | null): string | null {
  if (id === null || id === NO_SECOND_HILT) return null;
  return hilts.find((hilt) => hilt.id === id)?.saberType ?? null;
}

/**
 * Which shape a set of values reads as.
 *
 * A real hilt in the second hand is two hilts, whatever the first one is. With
 * the second hand empty, the shape is the shape of the first hilt. Everything
 * else — no hilt yet, a hilt the client no longer carries — reads as
 * **Single**, which is the shape a player who has picked nothing is in.
 */
export function saberModeOf(values: SaberValues, hilts: SaberHilt[]): SaberMode {
  if (values.saber2 !== null && values.saber2 !== NO_SECOND_HILT) return "duals";
  if (hiltTypeOf(hilts, values.saber1) === "staff") return "staff";
  return "single";
}

/**
 * The hilts one mode offers.
 *
 * **Staff** is the double-bladed hilts, `SABER_STAFF` — in the retail archives
 * those are the five named `dual_1` … `dual_5`, where «dual» means two blades
 * and not two hilts. Both other modes offer the one-bladed `SABER_SINGLE`,
 * because **Duals** is two hilts of one blade each.
 *
 * The dozen other shapes of `saberType_t` (`codemp/game/bg_public.h:1501-1516`)
 * are story weapons — a dagger, a lance, a trident — and `notInMP` keeps every
 * retail one of them out of the list before this filter ever sees it. A mod
 * that ships such a shape is offered under **Single**: it is one hilt in one
 * hand, which is what that mode is.
 */
export function hiltsForMode(mode: SaberMode, hilts: SaberHilt[]): SaberHilt[] {
  if (mode === "staff") return hilts.filter((hilt) => hilt.saberType === "staff");
  return hilts.filter((hilt) => hilt.saberType !== "staff");
}

/**
 * Whether this mode paints a second blade colour.
 *
 * Only two hilts do. A staff has two blades and one hilt, and the engine
 * colours by hilt.
 */
export function hasSecondBlade(mode: SaberMode): boolean {
  return mode === "duals";
}

/**
 * The four values one mode produces out of whatever the form holds.
 *
 * Run on every change of the control, not only on a change of mode, so the
 * four fields can never drift into a set that reads as another shape. Three
 * rules:
 *
 * - **A hilt of the wrong shape goes.** Switching to **Staff** with a
 *   one-bladed hilt in hand keeps nothing: the value would name a hilt the
 *   mode does not offer, and the list would show it as the odd option out.
 *   A hilt of a shape the list has never heard of stays, because the launcher
 *   knows nothing about it and throwing it away would lose a mod's work.
 * - **One hilt says the other hand is empty.** `saber2` becomes `none`, the
 *   engine's own word for it (`G_SetSaber(ent, 1, …, "none")` at
 *   `codemp/game/g_client.c:2240`). Leaving the field unset would leave the
 *   second hand to whatever the player's own `jampconfig.cfg` holds, and a
 *   profile that says **Single** would hand out two sabers.
 * - **No hilt says nothing at all.** A profile with no `saber1` manages no
 *   saber, so it writes neither cvar and the engine keeps its own — which is
 *   what an empty field means everywhere else in the form.
 */
export function saberValuesFor(
  mode: SaberMode,
  values: SaberValues,
  hilts: SaberHilt[],
): SaberValues {
  const kept = (id: string | null, staff: boolean): string | null => {
    if (id === null || id === NO_SECOND_HILT) return null;
    const type = hiltTypeOf(hilts, id);
    if (type === null) return id;
    return (type === "staff") === staff ? id : null;
  };

  if (mode === "duals") {
    return {
      saber1: kept(values.saber1, false),
      saber2: kept(values.saber2, false),
      color1: values.color1,
      color2: values.color2,
    };
  }

  const saber1 = kept(values.saber1, mode === "staff");
  return {
    saber1,
    saber2: saber1 === null ? null : NO_SECOND_HILT,
    color1: values.color1,
    color2: null,
  };
}
