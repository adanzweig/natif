/// Something with a chat role (lets `trimHistory` work on your own message types too).
public protocol RoleBearing {
    var isUserTurn: Bool { get }
}

extension ChatMessage: RoleBearing {
    public var isUserTurn: Bool { role == .user }
}

/// Cache-friendly trimming: instead of sliding one message per turn (which changes the prefix and
/// invalidates the engine's KV cache every time), drop a block down to half the limit, so the
/// same prefix is reused for the next max/2 turns. Always starts on a user turn.
public func trimHistory<M: RoleBearing>(_ history: [M], max: Int) -> (kept: [M], dropped: Int) {
    if max <= 0 { return ([], history.count) }
    if history.count <= max { return (history, 0) }
    let target = Swift.max(1, max / 2)
    let block = (history.count / target) * target - target
    var start = Swift.max(history.count - max, block)
    while start < history.count && !history[start].isUserTurn { start += 1 }
    return (Array(history[start...]), start)
}
