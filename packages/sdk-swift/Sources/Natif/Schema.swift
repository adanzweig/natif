import Foundation

// Port of sdk-core `schema.ts`: pull JSON out of model output, validate it against a JSON Schema
// (TS uses zod; here a small validator covering what zod's toJSONSchema emits), one repair prompt.

public struct SchemaIssue: Sendable, Equatable, CustomStringConvertible {
    public enum PathComponent: Sendable, Equatable {
        case key(String)
        case index(Int)
    }
    /// zod-style code: invalid_type, too_big, too_small, invalid_value, invalid_union, invalid_format.
    public var code: String
    public var message: String
    public var path: [PathComponent]

    public var pathString: String {
        var s = ""
        for p in path {
            switch p {
            case .key(let k): s += s.isEmpty ? k : ".\(k)"
            case .index(let i): s += "[\(i)]"
            }
        }
        return s
    }

    public var description: String { path.isEmpty ? "✖ \(message)" : "✖ \(message)\n  → at \(pathString)" }
}

/// Same layout as zod's `prettifyError`.
func prettify(_ issues: [SchemaIssue]) -> String {
    issues.map(\.description).joined(separator: "\n")
}

/// Models wrap JSON in thinking tags, code fences or chatter. Take the first top-level
/// JSON object or array out of the text.
public func extractJson(_ raw: String) throws -> JSONValue {
    let text = stripThink(raw).trimmingCharacters(in: .whitespacesAndNewlines)
    if let v = try? JSONValue(parsing: text) { return v }
    let scalars = Array(text.unicodeScalars)
    guard let start = scalars.firstIndex(where: { $0 == "{" || $0 == "[" }) else {
        throw JSONParseError(message: "No JSON found in model output")
    }
    let open = scalars[start]
    let close: Unicode.Scalar = open == "{" ? "}" : "]"
    var depth = 0
    var inString = false
    var escaped = false
    for i in start..<scalars.count {
        let c = scalars[i]
        if inString {
            if escaped { escaped = false }
            else if c == "\\" { escaped = true }
            else if c == "\"" { inString = false }
            continue
        }
        if c == "\"" { inString = true }
        else if c == open { depth += 1 }
        else if c == close {
            depth -= 1
            if depth == 0 {
                var view = String.UnicodeScalarView()
                view.append(contentsOf: scalars[start...i])
                return try JSONValue(parsing: String(view))
            }
        }
    }
    throw JSONParseError(message: "Unterminated JSON in model output")
}

private let thinkRegex = try! NSRegularExpression(pattern: "<think>[\\s\\S]*?</think>")

func stripThink(_ s: String) -> String {
    thinkRegex.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: "")
}

public enum ParseOutcome: Sendable {
    case ok(JSONValue)
    case failed(error: String, issues: [SchemaIssue]?)
}

public func parseModelOutput(schema: JSONValue, raw: String) -> ParseOutcome {
    let value: JSONValue
    do {
        value = try extractJson(raw)
    } catch {
        return .failed(error: "\(error)", issues: nil)
    }
    let (clean, issues) = validateJSON(value, schema: schema)
    if issues.isEmpty { return .ok(clean) }
    return .failed(error: prettify(issues), issues: issues)
}

/// Message appended for the single repair attempt.
public func repairMessage(_ error: String) -> String {
    "Your previous answer was not valid for the required JSON schema:\n\(error)\nReply again with only the corrected JSON object."
}

// MARK: - Validator

/// Validates `value` against a JSON Schema. Returns the value with unknown keys stripped where
/// `additionalProperties` is false (zod's default for objects), and the issues found.
/// Supported: type, enum, const, properties, required, additionalProperties, items, min/maxItems,
/// min/maxLength, pattern, minimum/maximum, exclusiveMinimum/Maximum, multipleOf, anyOf, oneOf, allOf.
public func validateJSON(_ value: JSONValue, schema: JSONValue) -> (value: JSONValue, issues: [SchemaIssue]) {
    var issues: [SchemaIssue] = []
    let v = check(value, schema, [], &issues)
    return (v, issues)
}

private func typeName(_ v: JSONValue) -> String {
    switch v {
    case .null: return "null"
    case .bool: return "boolean"
    case .number: return "number"
    case .string: return "string"
    case .array: return "array"
    case .object: return "object"
    }
}

private func matches(_ v: JSONValue, type t: String) -> Bool {
    switch (t, v) {
    case ("null", .null), ("boolean", .bool), ("number", .number), ("string", .string), ("array", .array), ("object", .object): return true
    case ("integer", .number(let n)): return n.isFinite && n.rounded() == n
    default: return false
    }
}

private func fmt(_ n: Double) -> String { JSONValue.formatNumber(n) }

private func check(_ v: JSONValue, _ schema: JSONValue, _ path: [SchemaIssue.PathComponent], _ issues: inout [SchemaIssue]) -> JSONValue {
    func add(_ code: String, _ message: String, _ p: [SchemaIssue.PathComponent]? = nil) {
        issues.append(SchemaIssue(code: code, message: message, path: p ?? path))
    }
    if schema == .bool(false) { add("invalid_type", "Invalid input: expected never, received \(typeName(v))"); return v }
    guard case .object(let s) = schema else { return v }
    var value = v

    if let all = s["allOf"]?.arrayValue {
        for sub in all { value = check(value, sub, path, &issues) }
    }
    if let alts = s["anyOf"]?.arrayValue ?? s["oneOf"]?.arrayValue {
        var matched: JSONValue?
        for sub in alts {
            var sink: [SchemaIssue] = []
            let c = check(value, sub, path, &sink)
            if sink.isEmpty { matched = c; break }
        }
        guard let matched else { add("invalid_union", "Invalid input"); return value }
        value = matched
    }
    if let c = s["const"], value != c {
        add("invalid_value", "Invalid input: expected \(c.jsonString)")
        return value
    }
    if let options = s["enum"]?.arrayValue, !options.contains(value) {
        add("invalid_value", "Invalid option: expected one of \(options.map(\.jsonString).joined(separator: "|"))")
        return value
    }

    var types: [String] = []
    if let t = s["type"]?.stringValue { types = [t] }
    else if let ts = s["type"]?.arrayValue { types = ts.compactMap(\.stringValue) }
    if !types.isEmpty && !types.contains(where: { matches(value, type: $0) }) {
        // zod: "expected int" only for non-integer numbers; other mismatches say "number".
        var expected = types[0]
        if expected == "integer" { if case .number = value { expected = "int" } else { expected = "number" } }
        add("invalid_type", "Invalid input: expected \(expected), received \(typeName(value))")
        return value
    }

    switch value {
    case .number(let n):
        if let max = s["maximum"]?.doubleValue, n > max { add("too_big", "Too big: expected number to be <=\(fmt(max))") }
        if let max = s["exclusiveMaximum"]?.doubleValue, n >= max { add("too_big", "Too big: expected number to be <\(fmt(max))") }
        if let min = s["minimum"]?.doubleValue, n < min { add("too_small", "Too small: expected number to be >=\(fmt(min))") }
        if let min = s["exclusiveMinimum"]?.doubleValue, n <= min { add("too_small", "Too small: expected number to be >\(fmt(min))") }
        if let m = s["multipleOf"]?.doubleValue, m > 0, (n / m).rounded() != n / m { add("not_multiple_of", "Invalid number: must be a multiple of \(fmt(m))") }
    case .string(let str):
        let len = str.utf16.count
        if let max = s["maxLength"]?.intValue, len > max { add("too_big", "Too big: expected string to have <=\(max) characters") }
        if let min = s["minLength"]?.intValue, len < min { add("too_small", "Too small: expected string to have >=\(min) characters") }
        if let pattern = s["pattern"]?.stringValue, let re = try? NSRegularExpression(pattern: pattern),
           re.firstMatch(in: str, range: NSRange(location: 0, length: (str as NSString).length)) == nil {
            add("invalid_format", "Invalid string: must match pattern /\(pattern)/")
        }
    case .array(let items):
        if let max = s["maxItems"]?.intValue, items.count > max { add("too_big", "Too big: expected array to have <=\(max) items") }
        if let min = s["minItems"]?.intValue, items.count < min { add("too_small", "Too small: expected array to have >=\(min) items") }
        if let itemSchema = s["items"], itemSchema.objectValue != nil || itemSchema.boolValue != nil {
            value = .array(items.enumerated().map { i, item in check(item, itemSchema, path + [.index(i)], &issues) })
        }
    case .object(let obj):
        let props = s["properties"]?.objectValue ?? JSONObject()
        let required = Set((s["required"]?.arrayValue ?? []).compactMap(\.stringValue))
        let additional = s["additionalProperties"]
        var out = JSONObject()
        for (k, item) in obj {
            if let ps = props[k] {
                out[k] = check(item, ps, path + [.key(k)], &issues)
            } else if additional == .bool(false) {
                continue // stripped, like zod's default object parsing
            } else if let additional, additional.objectValue != nil {
                out[k] = check(item, additional, path + [.key(k)], &issues)
            } else {
                out[k] = item
            }
        }
        for k in (props.keys + required.sorted()) where required.contains(k) && obj[k] == nil && !issues.contains(where: { $0.path == path + [.key(k)] }) {
            let expected: String
            if let t = props[k]?["type"]?.stringValue { expected = t == "integer" ? "number" : t }
            else if props[k]?["enum"] != nil { expected = "string" }
            else { expected = "nonoptional" }
            add("invalid_type", "Invalid input: expected \(expected), received undefined", path + [.key(k)])
        }
        value = .object(out)
    default:
        break
    }
    return value
}
