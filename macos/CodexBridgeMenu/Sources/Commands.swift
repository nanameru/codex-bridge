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
    /// これを過ぎたら子プロセスを止めて失敗として返す（画面が待ち続けないように）。
    var timeout: TimeInterval = 30
    /// false なら期限で SIGTERM だけを送る（書き込み中は子が SIGTERM を無視して書き終える）。
    var forceKill = true
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

    /// 既存の `unified_config.py on|off`。ルーターとブリッジの会話の接続が空くまで待ってから切り替える
    /// （接続は止めない）。空かなければ切り替えずに失敗する。期限の SIGTERM で止まるのは待つ段階だけで、
    /// 書き込みが始まったら子は SIGTERM を無視して書き終える。そのため SIGKILL は送らない。
    static func unified(_ config: AppConfig, enabled: Bool, waitIdleSeconds: Int = 120) -> CommandSpec {
        CommandSpec(executable: config.python,
                    arguments: [script(config, "unified_config.py"), enabled ? "on" : "off",
                                "--port", String(config.routerPort), "--bridge-port", String(config.bridgePort),
                                "--wait-idle", String(waitIdleSeconds)],
                    input: nil, timeout: TimeInterval(waitIdleSeconds + 30), forceKill: false)
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

    /// 期限で SIGTERM を送ったあと、SIGKILL を送るまでの猶予。
    static let killGrace: TimeInterval = 1

    static func run(_ spec: CommandSpec, config: AppConfig) async -> CommandResult {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: runBlocking(spec, config: config))
            }
        }
    }

    /// 戻るまでの時間は必ず `timeout + killGrace + 0.5` 秒以内。子が SIGTERM を無視しても、
    /// 孫が出力の管を開いたままでも待ち続けない。
    static func runBlocking(_ spec: CommandSpec, config: AppConfig) -> CommandResult {
        signal(SIGPIPE, SIG_IGN)  // 先に終わった子へ標準入力を書いてもアプリが落ちないように
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
            return CommandResult(exitCode: -1, output: Data(), errorOutput: Data("コマンドを起動できません".utf8))
        }
        let pid = process.processIdentifier
        let start = DispatchTime.now()
        let hardLimit = start + spec.timeout + killGrace + 0.5
        let lock = NSLock()
        var timedOut = false
        let terminate = DispatchWorkItem {
            guard process.isRunning else { return }
            lock.lock(); timedOut = true; lock.unlock()
            process.terminate()
        }
        // 書き込みの途中で止めてはいけないコマンド（forceKill = false）には SIGKILL を送らない。
        let forceKill = DispatchWorkItem { if spec.forceKill && process.isRunning { kill(pid, SIGKILL) } }
        DispatchQueue.global().asyncAfter(deadline: start + spec.timeout, execute: terminate)
        DispatchQueue.global().asyncAfter(deadline: start + spec.timeout + killGrace, execute: forceKill)
        defer { terminate.cancel(); forceKill.cancel() }

        if let data = spec.input { try? input.fileHandleForWriting.write(contentsOf: data) }
        try? input.fileHandleForWriting.close()
        let box = OutputBox()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async { box.set(out: output.fileHandleForReading.readDataToEndOfFile()); group.leave() }
        group.enter()
        DispatchQueue.global().async { box.set(err: errors.fileHandleForReading.readDataToEndOfFile()); group.leave() }
        let stopped = CommandResult(exitCode: -2, output: Data(),
                                    errorOutput: Data("時間内に終わらなかったため待つのをやめました。状態を読み直してください".utf8))
        guard group.wait(timeout: hardLimit) == .success else { return stopped }
        while process.isRunning && DispatchTime.now() < hardLimit { usleep(20_000) }
        if process.isRunning { return stopped }
        lock.lock(); let expired = timedOut; lock.unlock()
        if expired && process.terminationReason == .uncaughtSignal { return stopped }
        let (out, err) = box.get()
        return CommandResult(exitCode: process.terminationStatus, output: out, errorOutput: err)
    }
}

/// 読み取りの糸と待つ側で、出力を安全に受け渡す。
private final class OutputBox: @unchecked Sendable {
    private let lock = NSLock()
    private var out = Data(), err = Data()
    func set(out value: Data) { lock.lock(); out = value; lock.unlock() }
    func set(err value: Data) { lock.lock(); err = value; lock.unlock() }
    func get() -> (Data, Data) { lock.lock(); defer { lock.unlock() }; return (out, err) }
}
