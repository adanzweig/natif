import { z } from "zod";

export const EMOTIONS = [
  "joy", "calm", "gratitude", "excitement", "pride", "tiredness", "sadness",
  "anxiety", "frustration", "anger", "loneliness", "worry", "boredom",
] as const;

export const EMOTION_LABELS_ES: Record<(typeof EMOTIONS)[number], string> = {
  joy: "alegría", calm: "calma", gratitude: "gratitud", excitement: "entusiasmo", pride: "orgullo",
  tiredness: "cansancio", sadness: "tristeza", anxiety: "ansiedad", frustration: "frustración",
  anger: "enojo", loneliness: "soledad", worry: "preocupación", boredom: "aburrimiento",
};

/** Fixed emotion list: constrained decoding can only pick from it, so days are comparable. */
export const CheckInSchema = z.object({
  mood: z.number().int().min(1).max(10),
  energy: z.number().int().min(1).max(10),
  stress: z.number().int().min(1).max(10),
  emotions: z.array(z.enum(EMOTIONS)).max(5),
});
export type CheckIn = z.infer<typeof CheckInSchema>;

export const CHECKIN_TASK = {
  version: 1,
  temperature: 0,
  maxTokens: 120,
  systemPrompt: `You turn a daily wellbeing check-in into structured data. The user may write in Spanish or English.
Score with this rubric:
- mood: 1-2 very bad / hopeless; 3-4 bad; 5-6 neutral or mixed; 7-8 good; 9-10 excellent.
- energy: 1-2 exhausted, can't get up; 3-4 tired; 5-6 normal; 7-8 energetic; 9-10 very active.
- stress: 1-2 very relaxed; 3-4 some pressure; 5-6 moderate stress; 7-8 anxious or overwhelmed; 9-10 crisis or panic.
- emotions: up to 5 from the allowed list, only the ones the text expresses.
If something is not mentioned, use the neutral value 5.`,
};
