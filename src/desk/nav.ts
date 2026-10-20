/** Keyboard selection on the desk: one knob per module is remembered, ↑↓ moves within a module, tab between modules. */
import { MODULES, PARAMS } from "../master/settings.ts";
import type { Module, ParamKey } from "../master/settings.ts";

export interface Nav {
  module: Module;
  index: Record<Module, number>;
}

const KNOBS = new Map<Module, ParamKey[]>(MODULES.map((m) => [m, PARAMS.filter((p) => p.module === m).map((p) => p.key)]));

export function knobsOf(module: Module): ParamKey[] {
  return KNOBS.get(module) ?? [];
}

function wrap(i: number, n: number): number {
  return ((i % n) + n) % n;
}

export function initialNav(): Nav {
  return { module: "eq", index: Object.fromEntries(MODULES.map((m) => [m, 0])) as Record<Module, number> };
}

export function selected(nav: Nav): ParamKey {
  return knobsOf(nav.module)[nav.index[nav.module]];
}

export function moveKnob(nav: Nav, delta: number): Nav {
  const n = knobsOf(nav.module).length;
  return { ...nav, index: { ...nav.index, [nav.module]: wrap(nav.index[nav.module] + delta, n) } };
}

export function moveModule(nav: Nav, delta: number): Nav {
  return { ...nav, module: MODULES[wrap(MODULES.indexOf(nav.module) + delta, MODULES.length)] };
}

export function selectKnob(nav: Nav, key: ParamKey): Nav {
  const module = MODULES.find((m) => knobsOf(m).includes(key));
  if (!module) throw new RangeError(`unknown knob ${key}`);
  return { module, index: { ...nav.index, [module]: knobsOf(module).indexOf(key) } };
}
