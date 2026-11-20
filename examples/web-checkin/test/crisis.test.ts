import { describe, expect, it } from "vitest";
import { crisisCheck, resourcesFor } from "../src/crisis";

describe("crisisCheck", () => {
  it.each([
    "A veces pienso en matarme",
    "quiero morirme, no aguanto más",
    "Ya no quiero vivir",
    "estarían mejor sin mí",
    "pensé en quitarme la vida",
    "Me dan ganas de lastimarme",
    "I want to die",
    "thinking about suicide lately",
    "they'd be better off without me",
    "I keep wanting to hurt myself",
  ])("flags: %s", (t) => expect(crisisCheck(t)).toBe(true));

  it.each([
    "Hoy fue un día genial, salí a correr",
    "Estoy muerto de cansancio",
    "Me mató de risa el video",
    "No tengo ganas de morir, solo estoy cansado",
    "I'm not suicidal, just stressed about work",
    "This deadline is killing me",
    "",
  ])("does not flag: %s", (t) => expect(crisisCheck(t)).toBe(false));
});

describe("resourcesFor", () => {
  it("US gets 988 plus the international directory", () => {
    expect(resourcesFor("en-US").map((r) => r.name)).toEqual(["988 Suicide & Crisis Lifeline", "Find A Helpline"]);
  });
  it("unknown locale gets the directory", () => expect(resourcesFor("fr")).toHaveLength(1));
});
