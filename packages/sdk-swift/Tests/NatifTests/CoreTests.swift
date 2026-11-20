import Foundation
import Testing
@testable import Natif

@Suite struct TrimHistoryTests {
    func turns(_ n: Int) -> [ChatMessage] { (0..<n).map { ChatMessage(role: $0 % 2 == 1 ? .assistant : .user, content: String($0)) } }

    @Test func keepsEverythingUnderLimit() {
        let r = trimHistory(turns(20), max: 20)
        #expect(r.kept == turns(20) && r.dropped == 0)
    }

    @Test func dropsInBlocksSoPrefixStaysStable() {
        let starts = [22, 24, 26, 28].map { trimHistory(turns($0), max: 20).kept[0].content }
        #expect(Set(starts).count == 1)
        for n in [21, 25, 29, 33, 40, 57] {
            let (kept, dropped) = trimHistory(turns(n), max: 20)
            #expect(kept.count <= 20)
            #expect(kept[0].role == .user)
            #expect(dropped + kept.count == n)
        }
    }

    @Test func zeroMaxDropsAll() { #expect(trimHistory(turns(3), max: 0).dropped == 3) }
}

@Suite struct SchemaTests {
    @Test(arguments: [
        (#"{"a":1}"#, #"{"a":1}"#),
        ("<think>\n\n</think>\n{\"a\":1}", #"{"a":1}"#),
        ("Sure! ```json\n{\"a\":{\"b\":\"}\"}}\n```", #"{"a":{"b":"}"}}"#),
        ("text [1,2] more", "[1,2]"),
        (#"{"s":"quote \" brace {"}"#, #"{"s":"quote \" brace {"}"#),
    ])
    func extractJsonCases(raw: String, expected: String) throws {
        #expect(try extractJson(raw) == JSONValue(parsing: expected))
    }

    @Test func extractJsonThrows() {
        #expect(throws: (any Error).self) { try extractJson("no json here") }
        #expect(throws: (any Error).self) { try extractJson(#"{"a":1"#) }
    }

    // Same JSON Schema zod produces for z.object({ mood: int 1..10, emotions: string[] max 5 }).
    let S: JSONValue = [
        "type": "object",
        "properties": [
            "mood": ["type": "integer", "minimum": 1, "maximum": 10],
            "emotions": ["maxItems": 5, "type": "array", "items": ["type": "string"]],
        ],
        "required": ["mood", "emotions"],
        "additionalProperties": false,
    ]

    @Test func validOutput() {
        guard case .ok(let v) = parseModelOutput(schema: S, raw: #"{"mood":7,"emotions":["calma"]}"#) else { Issue.record("failed"); return }
        #expect(v == ["mood": 7, "emotions": ["calma"]])
    }

    @Test func messagesMatchZod() {
        // Strings taken from sdk-core (zod prettifyError) for the same inputs.
        guard case .failed(let e1, _) = parseModelOutput(schema: S, raw: #"{"mood":11,"emotions":[]}"#) else { Issue.record("passed"); return }
        #expect(e1 == "✖ Too big: expected number to be <=10\n  → at mood")
        guard case .failed(let e2, _) = parseModelOutput(schema: S, raw: #"{"mood":"x"}"#) else { Issue.record("passed"); return }
        #expect(e2 == "✖ Invalid input: expected number, received string\n  → at mood\n✖ Invalid input: expected array, received undefined\n  → at emotions")
        let labels: JSONValue = ["type": "object", "properties": ["label": ["type": "string", "enum": ["a", "b"]]], "required": ["label"]]
        guard case .failed(let e3, _) = parseModelOutput(schema: labels, raw: #"{"label":"spam"}"#) else { Issue.record("passed"); return }
        #expect(e3 == "✖ Invalid option: expected one of \"a\"|\"b\"\n  → at label")
    }

    @Test func notJSON() {
        guard case .failed = parseModelOutput(schema: S, raw: "hola") else { Issue.record("passed"); return }
    }

    @Test func stripsUnknownKeysLikeZod() {
        guard case .ok(let v) = parseModelOutput(schema: S, raw: #"{"mood":3,"emotions":[],"extra":true}"#) else { Issue.record("failed"); return }
        #expect(v["extra"] == nil)
    }

    @Test func unionsAndNullable() {
        let s: JSONValue = ["anyOf": [["type": "string"], ["type": "null"]]]
        #expect(validateJSON(.null, schema: s).issues.isEmpty)
        #expect(validateJSON(3, schema: s).issues.count == 1)
    }

    @Test func repairMessageIsTheSame() {
        #expect(repairMessage("x") == "Your previous answer was not valid for the required JSON schema:\nx\nReply again with only the corrected JSON object.")
    }
}

@Suite struct JSONValueTests {
    @Test func serializesLikeJSONStringify() {
        let schema: JSONValue = [
            "type": "object",
            "properties": ["label": ["type": "string", "enum": ["billing", "bug", "feature"]]],
            "required": ["label"],
            "additionalProperties": false,
        ]
        // Output of sdk-core toJsonSchema(z.object({ label: z.enum([...]) })).
        #expect(schema.jsonString == #"{"type":"object","properties":{"label":{"type":"string","enum":["billing","bug","feature"]}},"required":["label"],"additionalProperties":false}"#)
        #expect(JSONValue.number(0.1).jsonString == "0.1")
        #expect(JSONValue.number(1e-7).jsonString == "1e-7")
        #expect(JSONValue.number(-3).jsonString == "-3")
        #expect(JSONValue.string("a\"b\n\u{01}é").jsonString == #""a\"b\n\u0001é""#)
    }

    @Test func parsesAndKeepsOrder() throws {
        let v = try JSONValue(parsing: #"{"z":1,"a":[true,null,"é😀"],"m":{"x":-1.5e2}}"#)
        #expect(v.objectValue?.keys == ["z", "a", "m"])
        #expect(v["a"]?[2]?.stringValue == "é😀")
        #expect(v["m"]?["x"]?.doubleValue == -150)
        #expect(v.jsonString == #"{"z":1,"a":[true,null,"é😀"],"m":{"x":-150}}"#)
    }

    @Test func bridgesFoundationAndDecodable() throws {
        struct Out: Decodable { let mood: Int; let ok: Bool }
        let v = try JSONValue(any: ["mood": 3, "ok": true] as [String: Any])
        #expect(v == ["mood": 3, "ok": true])
        #expect(try v.decode(Out.self).mood == 3)
    }
}

@Suite struct GrammarTests {
    @Test func classifySchemaBecomesEnumGrammar() {
        let schema: JSONValue = ["type": "object", "properties": ["label": ["type": "string", "enum": ["billing", "bug"]]], "required": ["label"], "additionalProperties": false]
        let g = JSONSchemaGrammar.gbnf(for: schema)
        #expect(g.hasPrefix("root ::= root-value\n"))
        #expect(g.contains(#"root-value-label ::= "\"billing\"" | "\"bug\"""#))
        #expect(g.contains(#"root-value ::= "{" ws "\"label\"" ws ":" ws root-value-label ws "}""#))
    }

    @Test func optionalKeysAndArrays() {
        let schema: JSONValue = [
            "type": "object",
            "properties": ["mood": ["type": "integer"], "tags": ["type": "array", "items": ["type": "string"]], "note": ["type": "string"]],
            "required": ["mood", "tags"],
        ]
        let g = JSONSchemaGrammar.gbnf(for: schema)
        #expect(g.contains(#"( "," ws "\"note\"" ws ":" ws string ws )?"#))
        #expect(g.contains(#"root-value-tags ::= "[" ws ( string ws ( "," ws string ws )* )? "]""#))
    }

    @Test func unknownFallsBackToAnyValue() {
        #expect(JSONSchemaGrammar.gbnf(for: ["$ref": "#/x"]).hasPrefix("root ::= value\n"))
    }
}

@Suite struct ContractTests {
    @Test func bundledCatalogMatchesSdkCoreContract() throws {
        let file = sdkCoreDir.appending(path: "contract/catalog.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return } // outside the monorepo
        let core = try ModelCatalog(data: Data(contentsOf: file))
        #expect(core == ModelCatalog.bundled, "Run scripts/sync-contract.sh: Resources/catalog.json is out of date")
    }

    @Test func bundledCatalogHasGGUFModels() {
        #expect(ModelCatalog.bundled.models.compactMap(ggufModelId) == ["Qwen3-4B-Q4_K_M", "Qwen3-1.7B-Q8_0"])
    }

    // Values computed with sdk-core `deviceKey` (node) for the same profiles.
    @Test func deviceKeyMatchesTS() {
        #expect(deviceKey(highEndWeb) == "bb6f863a7cafa596ee10aca5")
        #expect(deviceKey(iPhone) == "364b5fc8a650463f15b07b76")
    }

    @Test func detectsThisMac() {
        let d = AppleDevice.detect()
        #expect(d.memoryGB ?? 0 > 0)
        #expect(d.hardwareModel?.isEmpty == false)
    }
}
