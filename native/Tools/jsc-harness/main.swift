//
//  main.swift
//  jsc-harness
//
//  Runs the engine bundle in a real JSContext, outside any app.
//
//  This is layer 2 of plan/native-rewrite.md → Testing, and it is the gate that route C actually
//  needs: vitest proves the engine is correct in node, but it cannot prove that the *bundled* engine
//  starts in JavaScriptCore, that every platform shim it reaches for exists, or that the SQLite
//  binding behaves like the WASM one. Those are exactly the failures that would otherwise be found
//  only inside an app extension, with no console attached.
//
//  Built and driven by `npm run test:jsc` (dev/bin/test-native-core.js). Deliberately a CLI rather
//  than an XCTest bundle so it runs from the same `npm test` a contributor already types, with no
//  Xcode project in the loop.
//
//  Usage:
//    jsc-harness --bundle <core.js> [--database <path>] [--request <json>]... [--startup]
//
//  Each --request is answered on stdout as one line of JSON, in order, so the caller can diff them
//  against what vitest produced for the same calls.
//

import Foundation

private struct Options {
    var bundle: String?
    var database = ":memory:"
    var requests: [String] = []
    var reportStartup = false
}

private func parseArguments() -> Options {
    var options = Options()
    var arguments = Array(CommandLine.arguments.dropFirst())
    while !arguments.isEmpty {
        let flag = arguments.removeFirst()
        switch flag {
        case "--bundle":
            options.bundle = arguments.isEmpty ? nil : arguments.removeFirst()
        case "--database":
            options.database = arguments.isEmpty ? ":memory:" : arguments.removeFirst()
        case "--request":
            if !arguments.isEmpty { options.requests.append(arguments.removeFirst()) }
        case "--startup":
            options.reportStartup = true
        default:
            FileHandle.standardError.write(Data("jsc-harness: unknown argument \(flag)\n".utf8))
            exit(2)
        }
    }
    return options
}

private func requireBundle(_ path: String?) -> String {
    guard let path else { fail("--bundle is required") }
    return path
}

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("jsc-harness: \(message)\n".utf8))
    exit(1)
}

private let options = parseArguments()
private let bundlePath = requireBundle(options.bundle)

private let host = NativeEngineHost(databasePath: options.database, bundleURL: URL(fileURLWithPath: bundlePath))

for request in options.requests {
    do {
        let response = try host.invoke(requestJson: request)
        print(response)
    } catch {
        // Reported in the engine's own envelope shape so the caller has one thing to parse, whether
        // the failure came from the engine or from the host around it.
        let message = "\(error)".replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n")
        print("{\"error\":{\"message\":\"\(message)\",\"name\":\"EngineHostError\"}}")
    }
}

if options.reportStartup {
    // Printed last and to stderr so it never contaminates the response stream a test is diffing.
    FileHandle.standardError.write(Data(String(format: "startupMilliseconds=%.1f\n", host.startupMilliseconds).utf8))
}
