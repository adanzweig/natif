/**
 * Crisis check that does NOT depend on the model: runs before the AI, on the raw text, and works
 * even if the model never loads. Errs on the side of showing help. Not a diagnostic tool.
 */

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");

const PATTERNS: RegExp[] = [
  // Spanish
  /\b(quiero|quisiera|voy a|pienso en|ganas de|deseo) (morir(me)?|matarme|suicidarme|desaparecer para siempre)\b/,
  /\bsuicid(io|arme|arse|a)\b/,
  /\bmatarme\b/,
  /\bquitarme la vida\b/,
  /\bno (quiero|vale la pena) (seguir )?vivir\b/,
  /\b(hacerme dano|lastimarme|cortarme)\b/,
  /\bmejor (estaria|estarian) (muert[oa]|sin mi)\b/,
  /\b(estaria|estarian) mejor (muert[oa]|sin mi)\b/,
  /\bno (le )?veo (salida|sentido a (la )?vida)\b/,
  // English
  /\b(kill|hurt|harm) myself\b/,
  /\bsuicid(e|al)\b/,
  /\b(want|wish|going) to die\b/,
  /\bend (my|it all|my life)\b/,
  /\bno reason to live\b/,
  /\bbetter off (dead|without me)\b/,
  /\bself[- ]harm\b/,
];

/** Phrases that mention the words without risk ("no tengo ganas de morir", "not suicidal"). */
const NEGATIONS: RegExp[] = [
  /\bno (tengo|siento) (ganas de|ideas de) (morir|suicid)/,
  /\bnunca (me )?(suicidaria|mataria)\b/,
  /\b(not|never) (suicidal|going to (kill|hurt) myself)\b/,
  /\bdon'?t want to die\b/,
];

export function crisisCheck(text: string): boolean {
  let t = normalize(text);
  for (const n of NEGATIONS) t = t.replace(n, " ");
  return PATTERNS.some((p) => p.test(t));
}

/** Help lines per locale. Verify each number before publishing (PLAN §9). */
export const CRISIS_RESOURCES: Record<string, { name: string; contact: string }[]> = {
  US: [{ name: "988 Suicide & Crisis Lifeline", contact: "Llamá o escribí al 988" }],
  AR: [{ name: "Centro de Asistencia al Suicida", contact: "135 (CABA y GBA) o 0800 345 1435" }],
  default: [{ name: "Find A Helpline", contact: "https://findahelpline.com" }],
};

export function resourcesFor(locale: string) {
  const region = locale.split("-")[1]?.toUpperCase() ?? "";
  return [...(CRISIS_RESOURCES[region] ?? []), ...CRISIS_RESOURCES.default!];
}
