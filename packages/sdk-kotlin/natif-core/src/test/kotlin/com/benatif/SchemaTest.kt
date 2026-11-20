package com.benatif

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

class SchemaTest {
    @Test fun `extractJson takes the first object out of chatter`() {
        assertEquals("""{"a":"}"}""", extractJson("""Here: {"a":"}"} and more {"b":2}""").toString())
        assertEquals("[1,2]", extractJson("<think>{oops</think> [1,2]").toString())
        assertFailsWith<JsonExtractException> { extractJson("nothing") }
        assertFailsWith<JsonExtractException> { extractJson("""{"a": 1""") }
    }

    @Test fun `validator reports paths and messages`() {
        val schema = parseJsonSchema("""{"type":"object","properties":{"tags":{"type":"array","items":{"type":"string"},"maxItems":1},"n":{"type":["integer","null"]}},"required":["tags"],"additionalProperties":false}""")
        assertTrue(JsonSchemaValidator.validate(schema, extractJson("""{"tags":["a"],"n":null}""")).isEmpty())
        val issues = JsonSchemaValidator.validate(schema, extractJson("""{"tags":["a",2],"n":1.5,"x":1}"""))
        assertEquals(listOf(listOf<Any>("tags"), listOf("tags", 1), listOf("n"), listOf()), issues.map { it.path })
        val out = parseModelOutput(schema, """{"tags":[]}""")
        assertIs<ParseOutcome.Ok>(out)
    }

    @Test fun `grammar for the classify schema only allows the labels`() {
        val schema = parseJsonSchema("""{"type":"object","properties":{"label":{"type":"string","enum":["billing","bug"]}},"required":["label"],"additionalProperties":false}""")
        val g = JsonSchemaGrammar.convert(schema)
        assertTrue(g.startsWith("root ::= r2-top\n"), g)
        assertTrue(g.contains("""r1-label ::= ("\"billing\"" | "\"bug\"") space"""), g)
        assertTrue(g.contains("""r2-top ::= "{" space "\"label\"" space ":" space r1-label "}" space"""), g)
    }

    @Test fun `grammar handles optional properties, arrays and unions`() {
        val schema = parseJsonSchema("""{"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":3},"c":{"type":["string","null"]}},"required":["a"]}""")
        val g = JsonSchemaGrammar.convert(schema)
        assertTrue(g.contains("""string ("," space string){0,2}"""), g)
        assertTrue(g.contains("string | null"), g)
        assertTrue(g.contains("""(\",\" space r""".replace("\\", "")), g)
        // every rule referenced is defined
        val defined = g.lines().filter { "::=" in it }.map { it.substringBefore(" ::=") }.toSet()
        val bodies = g.lines().filter { "::=" in it }.map { it.substringAfter("::=") }
        val referenced = bodies.flatMap { Regex("(?<![\"\\w\\\\-])(r\\d+-\\w+|string|number|integer|boolean|null|value|object|array|space|char)(?![\\w-])").findAll(it.replace(Regex("\"(\\\\.|[^\"\\\\])*\""), "")).map { m -> m.value }.toList() }.toSet()
        assertTrue(defined.containsAll(referenced), "undefined: ${referenced - defined}\n$g")
    }

    @Test fun `literal escapes quotes and backslashes`() = assertEquals("\"\\\"a\\\\b\\\"\"", JsonSchemaGrammar.literal("\"a\\b\""))
}
