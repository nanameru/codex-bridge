import Foundation

// swiftc で Sources/BridgeStatus.swift・Sources/Commands.swift と一緒にビルドする（App.swift は含めない）。
var failures = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    if condition() { print("ok - \(name)") } else { failures += 1; print("not ok - \(name)") }
}

let fixture = """
{"version":1,"checked_at":1762930800000,
 "router":{"port":8790,"running":true,"implementation":"e52b6d5b87af","revision":"0123456789ab","history_mode":"selected","busy":true},
 "bridge":{"port":8788,"running":false},
 "unified":{"enabled":true},
 "history_mode":"openai",
 "summary_limit":{"openai_limited":true,"until":1762934400000,"source":"router","recent_fallbacks":2,"last_fallback_requests_ago":1},
 "providers":{"recent_requests":5,"counts":{"commandcode":3,"openai":2},"limited_until":{"ollama":1762934400000}},
 "keys":{"commandcode":true,"ollama":false}}
"""
let tokyo = TimeZone(identifier: "Asia/Tokyo")!
let status = try! BridgeStatus.decode(Data(fixture.utf8))
check(status.router.running && !status.bridge.running, "decodes running state")
check(StatusText.overall(status) == .degraded, "bridge down is degraded")
check(StatusText.overall(nil) == .loading, "no status is loading")
var stopped = status; stopped.router.running = false
check(StatusText.overall(stopped) == .down, "router down is down")
check(StatusText.versionLine(status.router) == "版 e52b6d5 · runtime 0123456", "version line")
check(StatusText.versionLine(stopped.router) == nil, "no version when stopped")
check(StatusText.limitHeadline(status.summary_limit, timeZone: tokyo) == "OpenAI 上限中。17:00 まで代わりのモデルで要約", "limit headline with until")
var logOnly = status.summary_limit; logOnly.openai_limited = nil; logOnly.until = nil; logOnly.source = "log"
check(StatusText.limitHeadline(logOnly) == "最近 OpenAI の上限に当たりました", "log-only limit headline")
check(StatusText.limitDetail(logOnly)?.contains("2 回") == true, "log-only detail counts fallbacks")
let rows = StatusText.providerRows(status.providers)
check(rows.map(\.name) == ["OpenAI", "Command Code", "Ollama"], "provider rows in fixed order incl. limited")
check(abs(rows[1].share - 0.6) < 0.001, "provider share")
check((try? BridgeStatus.decode(Data(fixture.replacingOccurrences(of: "\"version\":1", with: "\"version\":2").utf8))) == nil, "rejects unknown version")

let config = AppConfig(repository: URL(fileURLWithPath: "/repo"), python: URL(fileURLWithPath: "/py"),
                       node: URL(fileURLWithPath: "/node"), routerPort: 18790, bridgePort: 18788)
let secret = "sk-synthetic-ABC123"
let keySpec = Commands.setKey(config, provider: .commandcode, key: secret)
check(!keySpec.arguments.joined(separator: " ").contains(secret), "key never in arguments")
check(keySpec.input == Data((secret + "\n").utf8), "key passed via stdin only")
check(keySpec.arguments == ["/repo/scripts/manual_providers.py", "set-key", "commandcode", "--stdin"], "set-key command")
check(!CommandRunner.environment(config).values.contains { $0.contains(secret) }, "key never in environment")
check(Commands.historyMode(config, .ask).arguments == ["/repo/src/history-mode.mjs", "--mode", "ask"], "history mode command")
check(Commands.unified(config, enabled: false).arguments ==
      ["/repo/scripts/unified_config.py", "off", "--port", "18790", "--bridge-port", "18788", "--wait-idle", "120"],
      "unified waits for router and bridge to be idle")
check(Commands.unified(config, enabled: true).timeout == 150 && Commands.status(config).timeout == 30, "every command has a time limit")
let sleeper = CommandSpec(executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["30"], input: nil, timeout: 1)
let started = Date()
let semaphore = DispatchSemaphore(value: 0)
var timedOut: CommandResult?
Task { timedOut = await CommandRunner.run(sleeper, config: AppConfig(repository: URL(fileURLWithPath: "/"),
    python: URL(fileURLWithPath: "/py"), node: URL(fileURLWithPath: "/node"), routerPort: 1, bridgePort: 2)); semaphore.signal() }
semaphore.wait()
check(timedOut?.exitCode != 0 && Date().timeIntervalSince(started) < 10, "a hung command is stopped at its time limit")
check(Commands.status(config).arguments.contains("18790") && !Commands.status(config).arguments.contains("8791"), "status uses configured router port")
let resolved = AppConfig.resolve(environment: ["CODEX_BRIDGE_HOME": "/r", "CODEX_BRIDGE_ROUTER_PORT": "8791x"],
                                 info: ["CodexBridgePython": "/p"])
check(resolved.repository.path == "/r" && resolved.python.path == "/p" && resolved.routerPort == 8790, "config resolution")

print(failures == 0 ? "# all passed" : "# \(failures) failed")
exit(failures == 0 ? 0 : 1)
