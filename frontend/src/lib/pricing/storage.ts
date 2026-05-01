import type { ScenarioInputs } from "./scenario";
import { DEFAULT_INPUTS } from "./scenario";

const KEY = "gmcc_pricing_scenario_inputs_v1";

export function loadScenarioInputs(): ScenarioInputs {
  if (typeof window === "undefined") return DEFAULT_INPUTS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_INPUTS;
    const parsed = JSON.parse(raw) as Partial<ScenarioInputs>;
    return { ...DEFAULT_INPUTS, ...parsed };
  } catch {
    return DEFAULT_INPUTS;
  }
}

export function saveScenarioInputs(inputs: ScenarioInputs): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(inputs));
  } catch {
    /* quota / disabled — ignore */
  }
}
