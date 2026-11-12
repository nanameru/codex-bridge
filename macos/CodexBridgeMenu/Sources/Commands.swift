import Foundation

/// アプリが呼ぶ既存コマンドの場所。待ち受けのポートは開かず、子プロセスを呼ぶだけ。
struct AppConfig: Equatable {
    var repository: URL
    var python: URL
    var node: URL
    var routerPort: Int
    var bridgePort: Int

    /// 環境変数 → ビルド時に Info.plist へ書いた値 → 既定、の順で決める。
    static func resolve(environment: [String: String] = ProcessInfo.processInfo.environment,
                        info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> AppConfig {
        func pick(_ env: String, _ key: String, _ fallback: String) -> String {
            if let value = environment[env], !value.isEmpty { return value }
            if let value = info[key] as? String, !value.isEmpty { return value }
            return fallback
        }
        func port(_ env: String, _ fallback: Int) -> Int {
            guard let value = environment[env].flatMap(Int.init), (1...65535).contains(value) else { return fallback }
            return value
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return AppConfig(
            repository: URL(fileURLWithPath: pick("CODEX_BRIDGE_HOME", "CodexBridgeRepository", home + "/codex-bridge")),
            python: URL(fileURLWithPath: pick("CODEX_BRIDGE_PYTHON", "CodexBridgePython", "/usr/bin/python3")),
            node: URL(fileURLWithPath: pick("CODEX_BRIDGE_NODE", "CodexBridgeNode", "/usr/local/bin/node")),
            routerPort: port("CODEX_BRIDGE_ROUTER_PORT", 8790),
            bridgePort: port("CODEX_BRIDGE_BRIDGE_PORT", 8788))
    }
}

struct CommandSpec: Equatable {
    var executable: URL
    var arguments: [String]
    /// 鍵はここ（標準入力）だけで渡す。引数・環境変数には入れない。
    var input: Data?
}

enum Commands {
    static func script(_ config: AppConfig, _ name: String) -> String {
        config.repository.appendingPathComponent("scripts").appendingPathComponent(name).path
    }

    static func status(_ config: AppConfig) -> CommandSpec {
        CommandSpec(executable: config.python,
                    arguments: [script(config, "menubar_status.py"),
                                "--router-port", String(config.routerPort),
                                "--bridge-port", String(config.bridgePort)],
                    input: nil)
    }

    static func historyMode(_ config: AppConfig, _ mode: HistoryMode) -> CommandSpec {
        CommandSpec(executable: config.node,
                    arguments: [config.repository.appendingPathComponent("src/history-mode.mjs").path, "--mode", mode.rawValue],
                    input: nil)
    }

    /// 既存の `unified_config.py on|off`。会話の接続が空くまで待ってから切り替える（接続は止めない）。
    static func unified(_ config: AppConfig, enabled: Bool, waitIdleSeconds: Int = 1800) -> CommandSpec {
        CommandSpec(executable: config.python,
                    arguments: [script(config, "unified_config.py"), enabled ? "on" : "off",
                                "--port", String(config.routerPort), "--wait-idle", String(waitIdleSeconds)],
                    input: nil)
    }

    static func setKey(_ config: AppConfig, provider: KeyProvider, key: String) -> CommandSpec {
        CommandSpec(executable: config.python,
                    arguments: [script(config, "manual_providers.py"), "set-key", provider.rawValue, "--stdin"],
                    input: Data((key + "\n").utf8))
    }
}

struct CommandResult: Sendable {
    var exitCode: Int32
    var output: Data
    var errorOutput: Data

    /// 画面に出してよい最後の1行（既存コマンドの日本語の案内）。鍵の登録では使わない。
    var lastLine: String {
        let text = String(decoding: exitCode == 0 ? output : errorOutput, as: UTF8.self)
        return text.split(whereSeparator: \.isNewline).last.map(String.init) ?? ""
    }
}

enum CommandRunner {
    static func environment(_ config: AppConfig) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let extra = [config.node.deletingLastPathComponent().path, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        environment["PATH"] = (extra + [environment["PATH"] ?? ""]).filter { !$0.isEmpty }.joined(separator: ":")
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        return environment
    }

    static func run(_ spec: CommandSpec, config: AppConfig) async -> CommandResult {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = spec.executable
                process.arguments = spec.arguments
                process.currentDirectoryURL = config.repository
                process.environment = environment(config)
                let output = Pipe(), errors = Pipe(), input = Pipe()
                process.standardOutput = output
                process.standardError = errors
                process.standardInput = input
                do { try process.run() } catch {
                    continuation.resume(returning: CommandResult(exitCode: -1, output: Data(),
                                                                 errorOutput: Data("コマンドを起動できません".utf8)))
                    return
                }
                if let data = spec.input { input.fileHandleForWriting.write(data) }
                try? input.fileHandleForWriting.close()
                var outData = Data(), errData = Data()
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global().async { outData = output.fileHandleForReading.readDataToEndOfFile(); group.leave() }
                group.enter()
                DispatchQueue.global().async { errData = errors.fileHandleForReading.readDataToEndOfFile(); group.leave() }
                group.wait()
                process.waitUntilExit()
                continuation.resume(returning: CommandResult(exitCode: process.terminationStatus, output: outData, errorOutput: errData))
            }
        }
    }
}
