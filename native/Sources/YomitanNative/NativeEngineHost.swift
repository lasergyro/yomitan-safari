//
//  NativeEngineHost.swift
//  Yomitan Safari Extension
//
//  Hosts the dictionary engine's JavaScript in JavaScriptCore, inside the app extension.
//
//  Route C of plan/native-rewrite.md: Yomitan's language logic is not data, it is live closures and
//  compiled regexes across 23 languages, so it is re-hosted rather than ported. The bundle evaluated
//  here is the same code the vitest suites run against; what differs is the platform underneath it,
//  which this file supplies.
//

import CommonCrypto
import Foundation
import JavaScriptCore
import os.log

/// One synchronous HTTP round trip, as the engine's `host.fetch` sees it.
///
/// The engine runs on a single serial queue and `NativeEngineHost.invoke` blocks it until the JS
/// settles (there is no async-I/O path — the async surface is microtask-only). So a *blocking*
/// fetch is the natural fit: the caller is already blocked, and a `DispatchSemaphore` over
/// `URLSession` returns the whole body without the busy-poll loop having to learn about network I/O.
/// Injectable so the equivalence harness can answer from fixtures and keep `npm run test:jsc`
/// hermetic (plan/native-rewrite.md → Testing, layer 2).
typealias UrlFetcher = (_ request: FetchRequest) -> FetchResult

struct FetchRequest {
    let url: String
    let method: String
    let headers: [String: String]
    let body: Data?
    let timeout: TimeInterval
}

struct FetchResult {
    var status: Int
    var url: String
    var headers: [String: String]
    var body: Data
    var error: String?

    static func failure(_ message: String) -> FetchResult {
        FetchResult(status: 0, url: "", headers: [:], body: Data(), error: message)
    }
}

/// The real network fetcher: `URLSession`, blocked on a semaphore. Used by the app extension; the
/// harness substitutes a fixture fetcher.
func performUrlSessionFetch(_ request: FetchRequest) -> FetchResult {
    guard let url = URL(string: request.url) else { return .failure("Invalid URL") }
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
        return .failure("Unsupported URL scheme")
    }

    var urlRequest = URLRequest(url: url)
    urlRequest.httpMethod = request.method
    urlRequest.timeoutInterval = request.timeout > 0 ? request.timeout : 30
    for (header, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: header) }
    urlRequest.httpBody = request.body

    let semaphore = DispatchSemaphore(value: 0)
    var result = FetchResult.failure("No result")
    // A fresh ephemeral session per call: no cookie store, no cache — the anonymized fetch the
    // extension's declarativeNetRequest rules used to enforce, now the default rather than a rule.
    let session = URLSession(configuration: .ephemeral)
    let task = session.dataTask(with: urlRequest) { data, response, error in
        if let error = error {
            result = .failure(error.localizedDescription)
        } else if let http = response as? HTTPURLResponse {
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String, let value = value as? String { headers[key] = value }
            }
            result = FetchResult(
                status: http.statusCode,
                url: http.url?.absoluteString ?? request.url,
                headers: headers,
                body: data ?? Data(),
                error: nil
            )
        } else {
            result = .failure("No HTTP response")
        }
        semaphore.signal()
    }
    task.resume()
    semaphore.wait()
    return result
}

/// Errors raised by the host itself, as opposed to by the engine.
enum EngineHostError: Error, CustomStringConvertible {
    case bundleMissing(String)
    case evaluationFailed(String)
    case notReady
    case deadlocked(String)
    case invalidResponse

    var description: String {
        switch self {
        case .bundleMissing(let name): return "The engine bundle \(name) is missing from the app extension"
        case .evaluationFailed(let message): return "The engine bundle failed to evaluate: \(message)"
        case .notReady: return "The engine bundle evaluated but did not publish its call surface"
        case .deadlocked(let action): return "The engine never settled \"\(action)\" and has no work left to do"
        case .invalidResponse: return "The engine returned a response that was not a string"
        }
    }
}

/// The JavaScriptCore host.
///
/// **Single-threaded by construction.** Every entry point must be called on the same queue; the
/// router owns that queue. A `JSContext` is not thread-safe, the SQLite connection is opened
/// `NOMUTEX`, and the engine holds prepared statements across calls — so serializing at the router
/// is not a simplification, it is the model.
///
/// **Cold start is the thing to watch.** The app extension can be terminated between messages, in
/// which case the next call pays context creation plus bundle parse plus database open. Everything
/// here is therefore lazy and cached, and `startupMilliseconds` is reported so a real cost can be
/// measured in place rather than guessed at (plan/native-rewrite.md → stage N0).
final class NativeEngineHost {
    static let bundleResourceName = "yomitan-core"
    static let bundleResourceExtension = "js"

    private var context: JSContext?
    private var openDatabases: [SqliteDatabaseBridge] = []
    private let databasePath: String
    /// Where the bundle lives. Injectable so the equivalence harness (native/Tools/jsc-harness) can
    /// run the very same host against a freshly built bundle without an app around it — the layer-2
    /// gate in plan/native-rewrite.md → Testing.
    private let bundleURL: URL?
    /// How `host.fetch` reaches the network. Real `URLSession` in the app extension; a fixture
    /// fetcher in the equivalence harness.
    private let fetcher: UrlFetcher
    private(set) var startupMilliseconds: Double = 0

    init(databasePath: String, bundleURL: URL? = nil, fetcher: @escaping UrlFetcher = performUrlSessionFetch) {
        self.databasePath = databasePath
        self.bundleURL = bundleURL
        self.fetcher = fetcher
    }

    /// Runs one engine action, blocking until it settles.
    ///
    /// Blocking is correct here: `beginRequest` is already an asynchronous boundary from Safari's
    /// point of view, and the alternative — returning to the run loop mid-call — would let a second
    /// message re-enter a context that is not re-entrant.
    /// - Parameter requestJson: `{"action": …, "params": {…}}`, forwarded verbatim from the browser.
    /// - Returns: the engine's response JSON, `{"result": …}` or `{"error": {…}}`.
    func invoke(requestJson: String) throws -> String {
        let context = try requireContext()
        guard let begin = context.objectForKeyedSubscript("yomitanNativeBegin"),
              let poll = context.objectForKeyedSubscript("yomitanNativePoll"),
              let runNextTimer = context.objectForKeyedSubscript("yomitanNativeRunNextTimer") else {
            throw EngineHostError.notReady
        }

        let callId = begin.call(withArguments: [requestJson])
        try throwPendingException(context)
        guard let callId else { throw EngineHostError.notReady }

        // Microtasks are drained by JavaScriptCore each time a native call returns, so a promise
        // chain settles without help. Timers are not: the loop below is what makes a `setTimeout`
        // in the engine (or in a dependency) run rather than hang. Bounded by "is there work left",
        // not by a wall clock, so a slow query is never cut off — only a genuine deadlock ends it.
        while true {
            let response = poll.call(withArguments: [callId])
            try throwPendingException(context)
            if let response, response.isString {
                return response.toString()
            }
            let ranTimer = runNextTimer.call(withArguments: [])
            try throwPendingException(context)
            if ranTimer?.toBool() != true {
                throw EngineHostError.deadlocked(requestJson.prefix(120).description)
            }
        }
    }

    /// Discards the context and every connection it opened. Called when the extension is asked to
    /// release resources; the next call rebuilds everything.
    func shutdown() {
        for database in openDatabases { database.close() }
        openDatabases.removeAll()
        context = nil
    }

    // MARK: - Setup

    private func requireContext() throws -> JSContext {
        if let context { return context }
        let started = DispatchTime.now()
        let created = try createContext()
        context = created
        startupMilliseconds = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000
        os_log(.info, "Yomitan engine started in %{public}.1f ms", startupMilliseconds)
        return created
    }

    private func createContext() throws -> JSContext {
        let resourceURL = bundleURL ?? Bundle(for: NativeEngineHost.self).url(
            forResource: Self.bundleResourceName,
            withExtension: Self.bundleResourceExtension
        )
        guard let url = resourceURL, let source = try? String(contentsOf: url, encoding: .utf8) else {
            throw EngineHostError.bundleMissing(bundleURL?.path ?? "\(Self.bundleResourceName).\(Self.bundleResourceExtension)")
        }
        let context = JSContext()!
        // Uncaught exceptions default to being swallowed with a console message that goes nowhere in
        // an appex. Store them instead, so `throwPendingException` can turn them into a real error.
        context.exceptionHandler = { context, exception in
            context?.exception = exception
        }
        install(host: NativeHostBridge(host: self), into: context)
        context.evaluateScript(source, withSourceURL: url)
        if let exception = context.exception {
            throw EngineHostError.evaluationFailed(exception.toString() ?? "unknown")
        }
        guard context.objectForKeyedSubscript("yomitanNativeReady")?.toBool() == true else {
            throw EngineHostError.notReady
        }
        return context
    }

    private func install(host: NativeHostBridge, into context: JSContext) {
        context.setObject(host, forKeyedSubscript: "yomitanNativeHost" as NSString)
    }

    /// Converts a stored JS exception into a Swift error and clears it, so one failed call cannot
    /// poison the next.
    private func throwPendingException(_ context: JSContext) throws {
        guard let exception = context.exception else { return }
        context.exception = nil
        let message = exception.toString() ?? "unknown"
        let stack = exception.objectForKeyedSubscript("stack")?.toString()
        throw EngineHostError.evaluationFailed(stack.map { "\(message)\n\($0)" } ?? message)
    }

    // MARK: - Host surface, called from JavaScript

    fileprivate func openDatabase(path: String) throws -> SqliteDatabaseBridge {
        // sqlite3_open_v2 creates the file but not the directories above it, and the container's
        // Application Support directory does not exist until something makes it.
        if path != ":memory:" {
            let directory = (path as NSString).deletingLastPathComponent
            if !directory.isEmpty {
                try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            }
        }
        let database = try SqliteDatabaseBridge(path: path)
        openDatabases.append(database)
        return database
    }

    fileprivate func resolveDatabasePath() -> String {
        databasePath
    }

    /// Runs one synchronous HTTP request through the injected fetcher and shapes the reply for JS.
    /// `body` is base64 both ways so arbitrary bytes (audio) survive the JSON-only bridge; text
    /// callers decode it in the `NativeResponse` shim.
    fileprivate func performFetch(_ spec: [String: Any]) -> [String: Any] {
        guard let url = spec["url"] as? String else { return ["error": "Missing url"] }
        let method = (spec["method"] as? String) ?? "GET"
        var headers: [String: String] = [:]
        if let rawHeaders = spec["headers"] as? [String: Any] {
            for (key, value) in rawHeaders where value is String {
                headers[key] = value as? String
            }
        }
        var body: Data?
        if let bodyBase64 = spec["bodyBase64"] as? String, !bodyBase64.isEmpty {
            body = Data(base64Encoded: bodyBase64)
        }
        let timeout = (spec["timeoutMs"] as? Double).map { $0 / 1000.0 } ?? 0

        let result = fetcher(FetchRequest(url: url, method: method, headers: headers, body: body, timeout: timeout))
        if let error = result.error {
            return ["error": error]
        }
        return [
            "status": result.status,
            "url": result.url,
            "headers": result.headers,
            "bodyBase64": result.body.base64EncodedString(),
        ]
    }

    /// Resolves a possibly-relative URL against a base, the way `new URL(url, base).href` does —
    /// Foundation's `URL(string:relativeTo:)` rather than a hand-written WHATWG parser.
    fileprivate func resolveUrl(_ url: String, _ base: String) -> String {
        if base.isEmpty { return URL(string: url)?.absoluteString ?? url }
        guard let baseUrl = URL(string: base) else { return URL(string: url)?.absoluteString ?? url }
        return URL(string: url, relativeTo: baseUrl)?.absoluteString ?? url
    }

    /// SHA-256 of the given base64 bytes, returned base64. Backs the one `crypto.subtle.digest`
    /// call the audio downloader makes (its jpod101 invalid-file check).
    ///
    /// `CommonCrypto` rather than `CryptoKit`: the app-extension target deploys back to macOS 10.14
    /// and CryptoKit's `SHA256` is 10.15+, so it fails to compile there (it built fine under the
    /// `test:jsc` harness only because `swiftc` used the host's newer deployment target).
    fileprivate func sha256Base64(_ base64: String) -> String {
        guard let data = Data(base64Encoded: base64) else { return "" }
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { buffer in
            _ = CC_SHA256(buffer.baseAddress, CC_LONG(data.count), &digest)
        }
        return Data(digest).base64EncodedString()
    }
}

// MARK: - The host object the bundle sees

@objc protocol NativeHostExports: JSExport {
    func openDatabase(_ path: String) -> JSValue
    func databasePath() -> String
    func log(_ level: String, _ message: String) -> Void
    func now() -> Double
    func fetch(_ spec: [String: Any]) -> [String: Any]
    func resolveUrl(_ url: String, _ base: String) -> String
    func sha256(_ base64: String) -> String
}

/// The entire platform surface the engine is allowed to assume — the Swift counterpart of
/// `NativeHost` in types/ext/native-bridge.d.ts.
///
/// Kept small. The database/log/clock functions plus three the audio downloader needs — a
/// synchronous `fetch`, and `resolveUrl`/`sha256` for the two web-platform bits (relative-URL
/// resolution, SHA-256) that are easy to get subtly wrong, so native does them correctly. Everything
/// else bare JavaScriptCore lacks (`TextEncoder`, `TextDecoder`, `console`, `setTimeout`, and the
/// audio shims `URL`/`URLSearchParams`/`crypto`/`AbortController`) is shimmed in JavaScript in
/// `native-core-main.js`/`native-web-shims.js`, where it can be unit-tested in node.
@objc final class NativeHostBridge: NSObject, NativeHostExports {
    private unowned let host: NativeEngineHost

    init(host: NativeEngineHost) {
        self.host = host
    }

    func openDatabase(_ path: String) -> JSValue {
        JSBridge.trapping(JSContext.current()!) {
            JSValue(object: try host.openDatabase(path: path), in: JSContext.current())
        }
    }

    func databasePath() -> String {
        host.resolveDatabasePath()
    }

    func log(_ level: String, _ message: String) {
        switch level {
        case "error": os_log(.error, "yomitan-engine: %{public}@", message)
        case "warn": os_log(.default, "yomitan-engine: %{public}@", message)
        case "debug": os_log(.debug, "yomitan-engine: %{public}@", message)
        default: os_log(.info, "yomitan-engine: %{public}@", message)
        }
    }

    func now() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
    }

    func fetch(_ spec: [String: Any]) -> [String: Any] {
        host.performFetch(spec)
    }

    func resolveUrl(_ url: String, _ base: String) -> String {
        host.resolveUrl(url, base)
    }

    func sha256(_ base64: String) -> String {
        host.sha256Base64(base64)
    }
}
