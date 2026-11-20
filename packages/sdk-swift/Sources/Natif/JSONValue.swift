import Foundation

/// A JSON value. Objects keep their key order (like JS), so schemas written as literals are sent
/// to the model, and turned into grammars, in the order you wrote them.
public enum JSONValue: Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object(JSONObject)
}

/// An insertion-ordered JSON object. Equality ignores key order.
public struct JSONObject: Sendable, Hashable, Sequence, ExpressibleByDictionaryLiteral {
    public private(set) var keys: [String] = []
    private var storage: [String: JSONValue] = [:]

    public init() {}
    public init(_ pairs: [(String, JSONValue)]) {
        for (k, v) in pairs { self[k] = v }
    }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self.init(elements)
    }

    public subscript(key: String) -> JSONValue? {
        get { storage[key] }
        set {
            if let newValue {
                if storage.updateValue(newValue, forKey: key) == nil { keys.append(key) }
            } else if storage.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }

    public func makeIterator() -> AnyIterator<(key: String, value: JSONValue)> {
        var i = 0
        return AnyIterator {
            guard i < keys.count else { return nil }
            defer { i += 1 }
            return (keys[i], storage[keys[i]]!)
        }
    }

    public static func == (a: JSONObject, b: JSONObject) -> Bool { a.storage == b.storage }
    public func hash(into hasher: inout Hasher) { hasher.combine(storage) }
}

// MARK: - Literals

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(JSONObject(elements)) }
}

// MARK: - Accessors

extension JSONValue {
    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }
    public subscript(index: Int) -> JSONValue? {
        if case .array(let a) = self, a.indices.contains(index) { return a[index] }
        return nil
    }
    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
    public var intValue: Int? {
        if case .number(let n) = self, n.rounded() == n, abs(n) < 9.2e18 { return Int(n) }
        return nil
    }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var objectValue: JSONObject? { if case .object(let o) = self { return o }; return nil }
    public var isNull: Bool { self == .null }
}

// MARK: - Bridging with Foundation / Any

extension JSONValue {
    /// Builds a value from `[String: Any]`, arrays, strings, numbers, bools and NSNull
    /// (what JSONSerialization returns). Note: Swift dictionaries have no order, so keys are sorted.
    public init(any value: Any) throws {
        switch value {
        case let v as JSONValue: self = v
        case is NSNull: self = .null
        case let s as String: self = .string(s)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
        case let b as Bool: self = .bool(b)
        case let i as Int: self = .number(Double(i))
        case let d as Double: self = .number(d)
        case let a as [Any]: self = .array(try a.map(JSONValue.init(any:)))
        case let d as [String: Any]:
            self = .object(JSONObject(try d.keys.sorted().map { ($0, try JSONValue(any: d[$0]!)) }))
        case Optional<Any>.none: self = .null
        default: throw NatifError.invalidArgument("Unsupported JSON value of type \(type(of: value))")
        }
    }

    /// Foundation representation (`[String: Any]`, `[Any]`, `String`, `Double`, `Bool`, `NSNull`).
    public var anyValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n
        case .string(let s): return s
        case .array(let a): return a.map(\.anyValue)
        case .object(let o): return Dictionary(uniqueKeysWithValues: o.map { ($0.key, $0.value.anyValue) })
        }
    }

    /// Decodes the value into your own `Decodable` type.
    public func decode<T: Decodable>(_ type: T.Type = T.self, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        try decoder.decode(T.self, from: Data(jsonString.utf8))
    }

    /// Parses JSON text (strict, like `JSON.parse`).
    public init(parsing text: String) throws {
        var p = JSONParser(Array(text.utf8))
        self = try p.parseDocument()
    }
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(JSONObject(o.keys.sorted().map { ($0, o[$0]!) }))
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not a JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(Dictionary(uniqueKeysWithValues: o.map { ($0.key, $0.value) }))
        }
    }
}

// MARK: - Serialization (same output as JS `JSON.stringify`)

extension JSONValue: CustomStringConvertible {
    public var description: String { jsonString }

    /// Compact JSON, byte-identical to `JSON.stringify` for the values the SDK produces.
    public var jsonString: String {
        var out = ""
        write(to: &out)
        return out
    }

    private func write(to out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let n): out += JSONValue.formatNumber(n)
        case .string(let s): JSONValue.writeString(s, to: &out)
        case .array(let a):
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                v.write(to: &out)
            }
            out += "]"
        case .object(let o):
            out += "{"
            var first = true
            for (k, v) in o {
                if !first { out += "," }
                first = false
                JSONValue.writeString(k, to: &out)
                out += ":"
                v.write(to: &out)
            }
            out += "}"
        }
    }

    static func formatNumber(_ n: Double) -> String {
        guard n.isFinite else { return "null" }
        if n == 0 { return "0" }
        if n.rounded() == n, abs(n) < 1e21 {
            if abs(n) < 9.2e18 { return String(Int64(n)) }
            return String(format: "%.0f", n)
        }
        // Swift prints the shortest round-trip form like JS, but with a padded exponent ("1e-07").
        var s = "\(n)"
        if let e = s.firstIndex(of: "e") {
            var mantissa = String(s[..<e])
            if mantissa.hasSuffix(".0") { mantissa.removeLast(2) }
            var exp = String(s[s.index(after: e)...])
            let sign = exp.hasPrefix("-") ? "-" : "+"
            exp = String(exp.drop { $0 == "-" || $0 == "+" }.drop { $0 == "0" })
            s = "\(mantissa)e\(sign)\(exp.isEmpty ? "0" : exp)"
        }
        return s
    }

    static func writeString(_ s: String, to out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
    }
}

// MARK: - Parser

struct JSONParseError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

struct JSONParser {
    private let b: [UInt8]
    private var i = 0

    init(_ bytes: [UInt8]) { b = bytes }

    mutating func parseDocument() throws -> JSONValue {
        skipWS()
        let v = try parseValue(depth: 0)
        skipWS()
        if i != b.count { throw err("Unexpected non-whitespace character after JSON") }
        return v
    }

    private func err(_ m: String) -> JSONParseError { JSONParseError(message: "\(m) at position \(i)") }

    private mutating func skipWS() {
        while i < b.count, b[i] == 0x20 || b[i] == 0x0A || b[i] == 0x0D || b[i] == 0x09 { i += 1 }
    }

    private mutating func parseValue(depth: Int) throws -> JSONValue {
        guard depth < 512 else { throw err("JSON nested too deeply") }
        guard i < b.count else { throw err("Unexpected end of JSON input") }
        switch b[i] {
        case UInt8(ascii: "{"):
            i += 1
            var obj = JSONObject()
            skipWS()
            if i < b.count, b[i] == UInt8(ascii: "}") { i += 1; return .object(obj) }
            while true {
                skipWS()
                guard i < b.count, b[i] == UInt8(ascii: "\"") else { throw err("Expected property name") }
                let key = try parseString()
                skipWS()
                guard i < b.count, b[i] == UInt8(ascii: ":") else { throw err("Expected ':' after property name") }
                i += 1
                skipWS()
                obj[key] = try parseValue(depth: depth + 1)
                skipWS()
                guard i < b.count else { throw err("Unexpected end of JSON input") }
                if b[i] == UInt8(ascii: ",") { i += 1; continue }
                if b[i] == UInt8(ascii: "}") { i += 1; return .object(obj) }
                throw err("Expected ',' or '}'")
            }
        case UInt8(ascii: "["):
            i += 1
            var arr: [JSONValue] = []
            skipWS()
            if i < b.count, b[i] == UInt8(ascii: "]") { i += 1; return .array(arr) }
            while true {
                skipWS()
                arr.append(try parseValue(depth: depth + 1))
                skipWS()
                guard i < b.count else { throw err("Unexpected end of JSON input") }
                if b[i] == UInt8(ascii: ",") { i += 1; continue }
                if b[i] == UInt8(ascii: "]") { i += 1; return .array(arr) }
                throw err("Expected ',' or ']'")
            }
        case UInt8(ascii: "\""):
            return .string(try parseString())
        case UInt8(ascii: "t"): try literal("true"); return .bool(true)
        case UInt8(ascii: "f"): try literal("false"); return .bool(false)
        case UInt8(ascii: "n"): try literal("null"); return .null
        default:
            return .number(try parseNumber())
        }
    }

    private mutating func literal(_ word: String) throws {
        let w = Array(word.utf8)
        guard i + w.count <= b.count, Array(b[i..<(i + w.count)]) == w else { throw err("Unexpected token") }
        i += w.count
    }

    private mutating func parseNumber() throws -> Double {
        let start = i
        if i < b.count, b[i] == UInt8(ascii: "-") { i += 1 }
        guard i < b.count, isDigit(b[i]) else { throw err("Unexpected token") }
        if b[i] == UInt8(ascii: "0") { i += 1 } else { while i < b.count, isDigit(b[i]) { i += 1 } }
        if i < b.count, b[i] == UInt8(ascii: ".") {
            i += 1
            guard i < b.count, isDigit(b[i]) else { throw err("Unterminated fractional number") }
            while i < b.count, isDigit(b[i]) { i += 1 }
        }
        if i < b.count, b[i] == UInt8(ascii: "e") || b[i] == UInt8(ascii: "E") {
            i += 1
            if i < b.count, b[i] == UInt8(ascii: "+") || b[i] == UInt8(ascii: "-") { i += 1 }
            guard i < b.count, isDigit(b[i]) else { throw err("Exponent part is missing a number") }
            while i < b.count, isDigit(b[i]) { i += 1 }
        }
        guard let d = Double(String(decoding: b[start..<i], as: UTF8.self)) else { throw err("Bad number") }
        return d
    }

    private func isDigit(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }

    private mutating func parseString() throws -> String {
        i += 1 // opening quote
        var bytes: [UInt8] = []
        while true {
            guard i < b.count else { throw err("Unterminated string in JSON") }
            let c = b[i]
            if c == UInt8(ascii: "\"") { i += 1; break }
            if c < 0x20 { throw err("Bad control character in string literal") }
            if c != UInt8(ascii: "\\") { bytes.append(c); i += 1; continue }
            i += 1
            guard i < b.count else { throw err("Unterminated string in JSON") }
            let e = b[i]
            i += 1
            switch e {
            case UInt8(ascii: "\""): bytes.append(0x22)
            case UInt8(ascii: "\\"): bytes.append(0x5C)
            case UInt8(ascii: "/"): bytes.append(0x2F)
            case UInt8(ascii: "b"): bytes.append(0x08)
            case UInt8(ascii: "f"): bytes.append(0x0C)
            case UInt8(ascii: "n"): bytes.append(0x0A)
            case UInt8(ascii: "r"): bytes.append(0x0D)
            case UInt8(ascii: "t"): bytes.append(0x09)
            case UInt8(ascii: "u"):
                var code = try hex4()
                if (0xD800...0xDBFF).contains(code), i + 1 < b.count, b[i] == UInt8(ascii: "\\"), b[i + 1] == UInt8(ascii: "u") {
                    let save = i
                    i += 2
                    let low = try hex4()
                    if (0xDC00...0xDFFF).contains(low) {
                        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                    } else {
                        i = save
                    }
                }
                let scalar = Unicode.Scalar(code) ?? "\u{FFFD}"
                bytes.append(contentsOf: Array(String(Character(scalar)).utf8))
            default: throw err("Bad escaped character in JSON")
            }
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    private mutating func hex4() throws -> UInt32 {
        guard i + 4 <= b.count, let v = UInt32(String(decoding: b[i..<(i + 4)], as: UTF8.self), radix: 16) else {
            throw err("Bad Unicode escape in JSON")
        }
        i += 4
        return v
    }
}
