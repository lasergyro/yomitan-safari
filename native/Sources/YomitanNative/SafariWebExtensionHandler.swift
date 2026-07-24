//
//  SafariWebExtensionHandler.swift
//  Yomitan Safari Extension
//
//  The message router: the only door between the extension and the native engine.
//
//  Kept a thin dispatch layer with no engine state of its own, deliberately. The engine lives in
//  the app extension today because that is the simplest thing that works, but a standalone macOS
//  app wants a long-lived process holding the database and serving both its own UI and the
//  extension. Nothing here should have to change when that happens — only what
//  `sharedEngine`/`DictionaryInstaller` resolve to (plan/native-rewrite.md → Which process).
//

import Foundation
import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let supportedHosts = Set(["localhost", "127.0.0.1", "::1"])

    /// The engine, shared across every message this process handles.
    ///
    /// Static because Safari creates a fresh handler object per message: an instance-owned engine
    /// would pay JavaScriptCore start-up and a database open on *every* hover. The app extension
    /// process itself does stay warm between calls on macOS — the probe measured no wake-up outlier
    /// (plan/native-engine-probe.md) — so this is what turns that into a warm engine too.
    private static let sharedEngine = NativeEngineHost(databasePath: DictionaryStore.databasePath)

    /// Serializes every engine call. A `JSContext` is not re-entrant, the SQLite connection is
    /// opened `NOMUTEX`, and the engine caches prepared statements — overlapping messages (which
    /// Safari does deliver) must not interleave inside it.
    private static let engineQueue = DispatchQueue(label: "dev.yomitan.safari.engine")

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        guard let body = message as? [String: Any] else {
            os_log(.error, "Received invalid native message payload from Safari web extension")
            complete(context: context, response: ["error": "Invalid native message payload"])
            return
        }

        handle(message: body, context: context)
    }

    private func handle(message: [String: Any], context: NSExtensionContext) {
        guard let action = message["action"] as? String else {
            complete(context: context, response: ["error": "Missing action"])
            return
        }

        switch action {
        case "engine":
            handleEngine(message: message, context: context)
        case "engineStatus":
            handleEngineStatus(context: context)
        case "installBegin", "installChunk", "installCommit", "installAbort":
            handleInstall(action: action, message: message, context: context)
        case "ankiRequest":
            proxyAnkiRequest(message: message, context: context)
        case "ping":
            handlePing(message: message, context: context)
        default:
            complete(context: context, response: ["error": "Unsupported action: " + action])
        }
    }

    // MARK: - Engine

    /// Forwards one request to the engine and returns its reply verbatim.
    ///
    /// The payload crosses as a single JSON string in both directions rather than as a nested
    /// property list. That is not incidental: the only transport measurement we have timed a flat
    /// string, and its first caveat is that a plist of many rows may behave quite differently
    /// (plan/native-engine-probe.md). Keeping the shape flat keeps the measurement applicable.
    private func handleEngine(message: [String: Any], context: NSExtensionContext) {
        guard let requestJson = message["request"] as? String else {
            complete(context: context, response: ["error": "Missing engine request"])
            return
        }
        Self.engineQueue.async {
            do {
                let response = try Self.sharedEngine.invoke(requestJson: requestJson)
                self.complete(context: context, response: ["response": response])
            } catch {
                os_log(.error, "Yomitan engine call failed: %{public}@", "\(error)")
                self.complete(context: context, response: ["error": "\(error)"])
            }
        }
    }

    /// Cheap liveness and cold-start report, for the settings UI and for stage-N0 measurement. Does
    /// not start the engine — a status call that paid for a cold start would be reporting its own
    /// cost rather than the app's state.
    private func handleEngineStatus(context: NSExtensionContext) {
        Self.engineQueue.async {
            let path = DictionaryStore.databasePath
            let attributes = try? FileManager.default.attributesOfItem(atPath: path)
            self.complete(context: context, response: [
                "ok": true,
                "databasePath": path,
                "databaseBytes": (attributes?[.size] as? NSNumber)?.intValue ?? 0,
                "startupMilliseconds": Self.sharedEngine.startupMilliseconds,
            ])
        }
    }

    // MARK: - Dictionary install

    /// Streams a build-time-compiled `.sqlite3` into the app container.
    ///
    /// Chunked because `sendNativeMessage` has no documented size limit and the one measured round
    /// trip that mattered was 4 MB; a 49 MB database in one message is exactly the kind of thing
    /// that works on a developer's machine and fails on a user's. At the measured ~60 MB/s the whole
    /// database still lands in about a second.
    private func handleInstall(action: String, message: [String: Any], context: NSExtensionContext) {
        Self.engineQueue.async {
            do {
                switch action {
                case "installBegin":
                    // The engine holds the live database open; it has to let go before the file
                    // underneath it is replaced.
                    Self.sharedEngine.shutdown()
                    try DictionaryInstaller.shared.begin()
                    self.complete(context: context, response: ["ok": true])
                case "installChunk":
                    guard let chunk = message["chunk"] as? String else {
                        throw DictionaryInstallError.missingChunk
                    }
                    let written = try DictionaryInstaller.shared.append(base64: chunk)
                    self.complete(context: context, response: ["ok": true, "bytesWritten": written])
                case "installCommit":
                    let bytes = try DictionaryInstaller.shared.commit()
                    self.complete(context: context, response: ["ok": true, "databaseBytes": bytes])
                default:
                    DictionaryInstaller.shared.abort()
                    self.complete(context: context, response: ["ok": true])
                }
            } catch {
                DictionaryInstaller.shared.abort()
                os_log(.error, "Yomitan dictionary install failed: %{public}@", "\(error)")
                self.complete(context: context, response: ["error": "\(error)"])
            }
        }
    }

    // MARK: - Pre-existing actions

    /// Latency probe for the native-engine option (plan/native-engine-probe.md). Echoes a
    /// payload of a caller-requested size so the round trip can be timed at realistic
    /// query-result sizes, and returns a native wall-clock stamp so the request and response
    /// legs can be told apart.
    private func handlePing(message: [String: Any], context: NSExtensionContext) {
        let receivedBytes = (message["payload"] as? String)?.count ?? 0
        let echoBytes = (message["echoBytes"] as? Int) ?? 0
        complete(context: context, response: [
            "ok": true,
            "receivedBytes": receivedBytes,
            "nativeTimestampMs": Date().timeIntervalSince1970 * 1000.0,
            "payload": echoBytes > 0 ? String(repeating: "x", count: echoBytes) : "",
        ])
    }

    private func proxyAnkiRequest(message: [String: Any], context: NSExtensionContext) {
        guard let urlString = message["url"] as? String, let url = URL(string: urlString) else {
            complete(context: context, response: ["error": "Invalid URL"])
            return
        }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            complete(context: context, response: ["error": "Unsupported URL scheme"])
            return
        }
        guard let host = url.host?.lowercased(), supportedHosts.contains(host) else {
            complete(context: context, response: ["error": "Only loopback AnkiConnect URLs are supported"])
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = (message["method"] as? String) ?? "POST"
        request.timeoutInterval = 10.0

        if let headers = message["headers"] as? [String: Any] {
            for (header, value) in headers {
                if let value = value as? String {
                    request.setValue(value, forHTTPHeaderField: header)
                }
            }
        }

        if let requestBody = message["body"] as? String {
            request.httpBody = requestBody.data(using: .utf8)
        }

        let configuration = URLSessionConfiguration.ephemeral
        let session = URLSession(configuration: configuration)
        let task = session.dataTask(with: request) { data, response, error in
            if let error = error {
                os_log(.error, "Anki proxy request failed: %{public}@", error.localizedDescription)
                self.complete(context: context, response: ["error": error.localizedDescription])
                return
            }

            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let responseText = String(data: data ?? Data(), encoding: .utf8) ?? ""
            self.complete(context: context, response: ["status": status, "responseText": responseText])
        }
        task.resume()
    }

    private func complete(context: NSExtensionContext, response: [String: Any]) {
        let item = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            item.userInfo = [SFExtensionMessageKey: response]
        } else {
            item.userInfo = ["message": response]
        }
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }
}
