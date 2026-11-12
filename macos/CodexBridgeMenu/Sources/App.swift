import SwiftUI
import AppKit

@MainActor
final class BridgeModel: ObservableObject {
    @Published var status: BridgeStatus?
    @Published var statusError: String?
    @Published var busyMessage: String?
    @Published var notice: String?
    @Published var editingKey: KeyProvider?

    let config = AppConfig.resolve()
    private var timer: Timer?
    private var refreshing = false

    init() {
        Task { await refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    var overall: Overall { StatusText.overall(status) }

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        let result = await CommandRunner.run(Commands.status(config), config: config)
        if result.exitCode == 0, let value = try? BridgeStatus.decode(result.output) {
            status = value
            statusError = nil
        } else {
            statusError = "状態を読めません（リポジトリと Python 3.11 以上を確認）"
        }
    }

    private func perform(_ spec: CommandSpec, busy: String, success: String, showOutput: Bool = true) async {
        busyMessage = busy
        notice = nil
        let result = await CommandRunner.run(spec, config: config)
        busyMessage = nil
        if result.exitCode == 0 {
            notice = success
        } else {
            notice = showOutput && !result.lastLine.isEmpty ? result.lastLine : "変更できませんでした"
        }
        await refresh()
    }

    func setHistoryMode(_ mode: HistoryMode) {
        guard status?.history_mode != mode.rawValue, busyMessage == nil else { return }
        Task { await perform(Commands.historyMode(config, mode), busy: "要約の担当を変えています…",
                             success: "要約の担当: \(mode.title)（次の要求から）") }
    }

    func setUnified(_ enabled: Bool) {
        guard status?.unified.enabled != enabled, busyMessage == nil else { return }
        Task { await perform(Commands.unified(config, enabled: enabled),
                             busy: "会話が空くのを待ってから切り替えます…",
                             success: enabled ? "ブリッジを使います。開いているチャットは完了後に開き直してください"
                                              : "ブリッジを使いません。開いているチャットは完了後に開き直してください") }
    }

    /// 鍵は標準入力だけで渡す。出力は画面に出さない（固定の文言だけ）。
    func saveKey(_ provider: KeyProvider, _ key: String) {
        guard busyMessage == nil else { return }
        let spec = Commands.setKey(config, provider: provider, key: key)
        editingKey = nil
        Task { await perform(spec, busy: "\(provider.title) の鍵を保存しています…",
                             success: "\(provider.title) の鍵を保存しました", showOutput: false) }
    }
}

@main
struct CodexBridgeMenuApp: App {
    @StateObject private var model = BridgeModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            Image(systemName: StatusText.symbol(model.overall))
                .accessibilityLabel("Codex Bridge")
        }
        .menuBarExtraStyle(.window)
    }
}

// MARK: - Views

private struct MenuContent: View {
    @ObservedObject var model: BridgeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(model: model)
            Divider()
            if let status = model.status {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        ServiceSection(status: status, model: model)
                        HistorySection(status: status, model: model)
                        LimitSection(status: status)
                        KeySection(status: status, model: model)
                    }
                    .padding(14)
                }
                .frame(maxHeight: 560)
            } else {
                HStack(spacing: 8) {
                    if model.statusError == nil { ProgressView().controlSize(.small) }
                    Text(model.statusError ?? "状態を読んでいます…").foregroundStyle(.secondary)
                }
                .padding(14)
            }
            Footer(model: model)
        }
        .frame(width: 320)
    }
}

private struct Header: View {
    @ObservedObject var model: BridgeModel

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: StatusText.symbol(model.overall))
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(overallColor(model.overall))
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text("Codex Bridge").font(.headline)
                Text(summary).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
                .help("今すぐ状態を読み直す")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var summary: String {
        switch model.overall {
        case .loading: return "確認中"
        case .healthy: return "ルーターとブリッジは動いています"
        case .degraded: return "一部が止まっているか、設定に問題があります"
        case .down: return "ルーターが止まっています"
        }
    }
}

private func overallColor(_ overall: Overall) -> Color {
    switch overall {
    case .loading: return .secondary
    case .healthy: return .green
    case .degraded: return .orange
    case .down: return .red
    }
}

private struct SectionTitle: View {
    let text: String
    var body: some View {
        Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(nil)
    }
}

private struct StatusDot: View {
    let on: Bool
    var body: some View {
        Circle().fill(on ? Color.green : Color.red).frame(width: 7, height: 7)
    }
}

private struct ServiceSection: View {
    let status: BridgeStatus
    @ObservedObject var model: BridgeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "動作")
            HStack(spacing: 8) {
                StatusDot(on: status.router.running)
                Text(StatusText.routerLine(status.router))
                Spacer()
                if status.router.busy == true {
                    Text("会話中").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(Color.accentColor.opacity(0.15)))
                }
            }
            if let version = StatusText.versionLine(status.router) {
                Text(version).font(.caption.monospaced()).foregroundStyle(.secondary).padding(.leading, 15)
            }
            HStack(spacing: 8) {
                StatusDot(on: status.bridge.running)
                Text(StatusText.bridgeLine(status.bridge))
            }
            Toggle(isOn: Binding(get: { status.unified.enabled }, set: { model.setUnified($0) })) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("ブリッジを使う")
                    Text("会話中なら、空くまで待ってから切り替えます").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            .disabled(model.busyMessage != nil)
            .padding(.top, 4)
        }
    }
}

private struct HistorySection: View {
    let status: BridgeStatus
    @ObservedObject var model: BridgeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "要約をだれにやらせるか")
            Picker("", selection: Binding(
                get: { HistoryMode(rawValue: status.history_mode) ?? .selected },
                set: { model.setHistoryMode($0) })) {
                ForEach(HistoryMode.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(model.busyMessage != nil)
            if status.history_mode == "invalid" {
                Label("設定ファイルの形式・権限に問題があります", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
    }
}

private struct LimitSection: View {
    let status: BridgeStatus

    var body: some View {
        let limit = status.summary_limit
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "上限")
            Label(StatusText.limitHeadline(limit),
                  systemImage: limit.openai_limited == true ? "hourglass" : "checkmark.circle")
                .foregroundStyle(limit.openai_limited == true ? Color.orange : Color.primary)
            if let detail = StatusText.limitDetail(limit) {
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            let rows = StatusText.providerRows(status.providers)
            if rows.isEmpty {
                Text("最近の要求の記録はありません").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("直近 \(status.providers.recent_requests) 件の提供元").font(.caption).foregroundStyle(.secondary)
                    .padding(.top, 2)
                ForEach(rows, id: \.name) { row in
                    HStack(spacing: 8) {
                        Text(row.name).font(.caption).frame(width: 92, alignment: .leading)
                        GeometryReader { geometry in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.secondary.opacity(0.15))
                                Capsule().fill(row.limitedUntil == nil ? Color.accentColor : Color.orange)
                                    .frame(width: max(3, geometry.size.width * row.share))
                            }
                        }
                        .frame(height: 6)
                        Text("\(row.count)").font(.caption.monospacedDigit()).frame(width: 30, alignment: .trailing)
                    }
                    if let until = row.limitedUntil {
                        Text("\(row.name) は \(StatusText.clock(until)) まで上限中")
                            .font(.caption2).foregroundStyle(.orange).padding(.leading, 100)
                    }
                }
            }
        }
    }
}

private struct KeySection: View {
    let status: BridgeStatus
    @ObservedObject var model: BridgeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "鍵")
            ForEach(KeyProvider.allCases) { provider in
                if model.editingKey == provider {
                    KeyEntry(provider: provider, model: model)
                } else {
                    HStack {
                        Text(provider.title)
                        Spacer()
                        Text(status.keys[provider.rawValue] == true ? "登録済み" : "未登録")
                            .font(.caption).foregroundStyle(.secondary)
                        Button(status.keys[provider.rawValue] == true ? "変更…" : "登録…") { model.editingKey = provider }
                            .controlSize(.small)
                            .disabled(model.busyMessage != nil)
                    }
                }
            }
        }
    }
}

private struct KeyEntry: View {
    let provider: KeyProvider
    @ObservedObject var model: BridgeModel
    @State private var key = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(provider.title) の鍵").font(.caption)
            SecureField("貼り付け（表示されません）", text: $key)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit(save)
            HStack {
                Text("本人だけが読めるファイルに保存します").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button("やめる") { key = ""; model.editingKey = nil }.controlSize(.small)
                Button("保存", action: save).controlSize(.small).keyboardShortcut(.defaultAction)
                    .disabled(key.isEmpty)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.08)))
        .onAppear { focused = true }
        .onDisappear { key = "" }
    }

    private func save() {
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        key = ""
        guard !value.isEmpty else { return }
        model.saveKey(provider, value)
    }
}

private struct Footer: View {
    @ObservedObject var model: BridgeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let message = model.busyMessage ?? model.notice {
                Divider()
                HStack(spacing: 6) {
                    if model.busyMessage != nil { ProgressView().controlSize(.small) }
                    Text(message).font(.caption).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 14).padding(.vertical, 8)
            }
            Divider()
            HStack {
                if let status = model.status {
                    Text("確認 \(StatusText.clock(status.checked_at))").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Button("終了") { NSApplication.shared.terminate(nil) }
                    .buttonStyle(.borderless).controlSize(.small)
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
        }
    }
}
