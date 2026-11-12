import Foundation

/// `scripts/menubar_status.py` の出力。本文・鍵・パスは含まれない。
struct BridgeStatus: Decodable, Equatable {
    struct Router: Decodable, Equatable {
        var port: Int
        var running: Bool
        var implementation: String?
        var revision: String?
        var history_mode: String?
        var busy: Bool?
    }
    struct Bridge: Decodable, Equatable {
        var port: Int
        var running: Bool
    }
    struct Unified: Decodable, Equatable { var enabled: Bool }
    struct SummaryLimit: Decodable, Equatable {
        var openai_limited: Bool?
        var until: Int64?
        var source: String
        var recent_fallbacks: Int
        var last_fallback_requests_ago: Int?
    }
    struct Providers: Decodable, Equatable {
        var recent_requests: Int
        var counts: [String: Int]
        var limited_until: [String: Int64]
    }

    var version: Int
    var checked_at: Int64
    var router: Router
    var bridge: Bridge
    var unified: Unified
    var history_mode: String
    var summary_limit: SummaryLimit
    var providers: Providers
    var keys: [String: Bool]

    static func decode(_ data: Data) throws -> BridgeStatus {
        let value = try JSONDecoder().decode(BridgeStatus.self, from: data)
        guard value.version == 1 else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "unsupported version")) }
        return value
    }
}

enum HistoryMode: String, CaseIterable, Identifiable {
    case selected, openai, ask
    var id: String { rawValue }
    var title: String {
        switch self {
        case .selected: return "選択中のモデル"
        case .openai: return "OpenAI"
        case .ask: return "毎回聞く"
        }
    }
}

enum KeyProvider: String, CaseIterable, Identifiable {
    case commandcode, ollama
    var id: String { rawValue }
    var title: String { self == .commandcode ? "Command Code" : "Ollama" }
}

enum Overall: Equatable { case loading, healthy, degraded, down }

/// 画面に出す文言。UIから切り離してテストする。
enum StatusText {
    static let providerNames: [String: String] = [
        "openai": "OpenAI", "opencode": "OpenCode", "commandcode": "Command Code",
        "ollama": "Ollama", "whatstoken": "WhatsToken",
    ]
    static let providerOrder = ["openai", "opencode", "commandcode", "ollama", "whatstoken"]

    static func overall(_ status: BridgeStatus?) -> Overall {
        guard let status else { return .loading }
        if !status.router.running { return .down }
        if !status.bridge.running || status.history_mode == "invalid" { return .degraded }
        return .healthy
    }

    static func symbol(_ overall: Overall) -> String {
        switch overall {
        case .loading: return "ellipsis.circle"
        case .healthy: return "point.3.connected.trianglepath.dotted"
        case .degraded: return "exclamationmark.circle"
        case .down: return "exclamationmark.triangle.fill"
        }
    }

    static func clock(_ milliseconds: Int64, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.timeZone = timeZone
        formatter.dateFormat = "H:mm"
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000))
    }

    static func routerLine(_ router: BridgeStatus.Router) -> String {
        router.running ? "ルーター（\(router.port)）動作中" : "ルーター（\(router.port)）停止中"
    }

    static func versionLine(_ router: BridgeStatus.Router) -> String? {
        guard router.running else { return nil }
        var parts: [String] = []
        if let implementation = router.implementation { parts.append("版 \(implementation.prefix(7))") }
        if let revision = router.revision { parts.append("runtime \(revision.prefix(7))") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func bridgeLine(_ bridge: BridgeStatus.Bridge) -> String {
        bridge.running ? "ブリッジ（\(bridge.port)）動作中" : "ブリッジ（\(bridge.port)）停止中"
    }

    static func limitHeadline(_ limit: BridgeStatus.SummaryLimit, timeZone: TimeZone = .current) -> String {
        if limit.openai_limited == true, let until = limit.until {
            return "OpenAI 上限中。\(clock(until, timeZone: timeZone)) まで代わりのモデルで要約"
        }
        if limit.openai_limited == false { return "OpenAI で要約できます" }
        return limit.recent_fallbacks > 0 ? "最近 OpenAI の上限に当たりました" : "上限の記録はありません"
    }

    static func limitDetail(_ limit: BridgeStatus.SummaryLimit) -> String? {
        guard limit.recent_fallbacks > 0 else {
            return limit.source == "log" ? "解除時刻は、ルーターを更新すると表示されます" : nil
        }
        var text = "直近の要求で \(limit.recent_fallbacks) 回、代わりのモデルで要約"
        if limit.source == "log" { text += "（解除時刻はルーターの更新後に表示）" }
        return text
    }

    /// 内訳の行。件数の多い順ではなく、決まった順に並べる（見るたびに入れ替わらないように）。
    static func providerRows(_ providers: BridgeStatus.Providers) -> [(name: String, count: Int, share: Double, limitedUntil: Int64?)] {
        let total = max(1, providers.counts.values.reduce(0, +))
        return providerOrder.compactMap { key in
            let count = providers.counts[key] ?? 0
            let until = providers.limited_until[key]
            guard count > 0 || until != nil else { return nil }
            return (providerNames[key] ?? key, count, Double(count) / Double(total), until)
        }
    }
}
