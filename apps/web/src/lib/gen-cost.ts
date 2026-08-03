/** Credit cost calculation per gen_models unit (SPEC §8.2). */
export function computeCost(
  creditPerUnit: number,
  unit: string,
  prompt: string,
  params: { durationSec?: number; bestOf2?: boolean },
): number {
  let units: number;
  switch (unit) {
    case "second":
      units = Math.max(1, Math.ceil(params.durationSec ?? 5));
      break;
    case "100chars":
      units = Math.max(1, Math.ceil(prompt.length / 100));
      break;
    default: // image | track60s
      units = 1;
  }
  const takes = params.bestOf2 ? 2 : 1; // Best-of-2 = 2× credits (SPEC §8.3)
  return creditPerUnit * units * takes;
}
