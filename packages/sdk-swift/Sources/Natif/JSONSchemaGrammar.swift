import Foundation

/// Turns a JSON Schema into a GBNF grammar for llama.cpp constrained decoding, so the model can
/// only produce JSON with the right shape (keys, types, enums). Bounds such as minimum/maxItems are
/// not encoded: the validator + one repair attempt handle them, like on every other platform.
/// Unsupported constructs fall back to "any JSON value" for that node.
public enum JSONSchemaGrammar {
    public static func gbnf(for schema: JSONValue) -> String {
        var b = Builder()
        let root = b.rule(for: schema, name: "root-value")
        var lines = ["root ::= \(root)"]
        lines += b.rules.map { "\($0.name) ::= \($0.body)" }
        lines += primitives
        return lines.joined(separator: "\n") + "\n"
    }

    static let primitives: [String] = [
        #"ws ::= | " " | "\n" [ \t]{0,20}"#,
        #"string ::= "\"" char* "\"""#,
        #"char ::= [^"\\\x7F\x00-\x1F] | "\\" (["\\bfnrt/] | "u" [0-9a-fA-F]{4})"#,
        #"integer ::= "-"? ([0-9] | [1-9] [0-9]{0,15})"#,
        #"number ::= integer ("." [0-9]+)? ([eE] [-+]? [0-9]+)?"#,
        #"boolean ::= "true" | "false""#,
        #"null ::= "null""#,
        #"value ::= object | array | string | number | boolean | null"#,
        #"object ::= "{" ws ( string ws ":" ws value ws ( "," ws string ws ":" ws value ws )* )? "}""#,
        #"array ::= "[" ws ( value ws ( "," ws value ws )* )? "]""#,
    ]

    /// GBNF string literal for raw text.
    static func literal(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default: out.unicodeScalars.append(u)
            }
        }
        return out + "\""
    }

    private struct Builder {
        var rules: [(name: String, body: String)] = []
        var used = Set<String>()

        mutating func add(_ name: String, _ body: String) -> String {
            var n = name.lowercased().map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
            if n.isEmpty || n.first!.isNumber { n = "r-" + n }
            var unique = n
            var i = 2
            while used.contains(unique) || ["root", "ws", "string", "char", "integer", "number", "boolean", "null", "value", "object", "array"].contains(unique) {
                unique = "\(n)-\(i)"
                i += 1
            }
            used.insert(unique)
            rules.append((unique, body))
            return unique
        }

        /// Returns a GBNF expression (a rule name or an inline alternative) for the schema.
        mutating func rule(for schema: JSONValue, name: String) -> String {
            guard case .object(let s) = schema else { return "value" }
            if let c = s["const"] { return JSONSchemaGrammar.literal(c.jsonString) }
            if let e = s["enum"]?.arrayValue, !e.isEmpty {
                return add(name, e.map { JSONSchemaGrammar.literal($0.jsonString) }.joined(separator: " | "))
            }
            if let alts = s["anyOf"]?.arrayValue ?? s["oneOf"]?.arrayValue, !alts.isEmpty {
                let parts = alts.enumerated().map { i, a in rule(for: a, name: "\(name)-\(i)") }
                return add(name, parts.joined(separator: " | "))
            }
            if let ts = s["type"]?.arrayValue {
                let parts = ts.compactMap(\.stringValue).map { t -> String in
                    var sub = s
                    sub["type"] = .string(t)
                    return rule(for: .object(sub), name: "\(name)-\(t)")
                }
                return parts.isEmpty ? "value" : add(name, parts.joined(separator: " | "))
            }
            switch s["type"]?.stringValue {
            case "string": return "string"
            case "integer": return "integer"
            case "number": return "number"
            case "boolean": return "boolean"
            case "null": return "null"
            case "array":
                guard let items = s["items"], items.objectValue != nil else { return "array" }
                let item = rule(for: items, name: "\(name)-item")
                return add(name, #""[" ws ( "# + item + #" ws ( "," ws "# + item + #" ws )* )? "]""#)
            case "object":
                guard let props = s["properties"]?.objectValue, !props.isEmpty else { return "object" }
                let required = Set((s["required"]?.arrayValue ?? []).compactMap(\.stringValue))
                let req = props.filter { required.contains($0.key) }
                let opt = props.filter { !required.contains($0.key) }
                // Optional keys need a required key before them to place commas simply.
                if req.isEmpty { return "object" }
                func kv(_ k: String, _ v: JSONValue) -> String {
                    "\(JSONSchemaGrammar.literal(JSONValue.string(k).jsonString)) ws \":\" ws \(rule(for: v, name: "\(name)-\(k)")) ws"
                }
                var body = #""{" ws "#
                body += req.map { kv($0.key, $0.value) }.joined(separator: #" "," ws "#)
                for (k, v) in opt { body += #" ( "," ws "# + kv(k, v) + " )?" }
                body += #" "}""#
                return add(name, body)
            default:
                return "value"
            }
        }
    }
}
