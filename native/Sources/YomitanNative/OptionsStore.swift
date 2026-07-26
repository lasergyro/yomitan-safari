//
//  OptionsStore.swift
//  Yomitan Safari Extension
//
//  The options/profile store, as a plain JSON file in the app container.
//
//  Options used to live in the extension's `chrome.storage.local`, which survives Safari's origin
//  rotation and so was never part of the OPFS blocker (plan/history/safari-opfs-blocker.md). They
//  move here for the *other* reason the engine did: so the logic — and now the settings the logic
//  reads — lives in the app process, which a standalone macOS app needs (plan/native-rewrite.md
//  → stage N4). The extension keeps every line of the versioned migration in `options-util.js`; the
//  host only owns the bytes.
//
//  Deliberately not the SQLite engine's concern: the dictionary database is replaced wholesale on
//  every install (DictionaryStore), and options must outlive that, so they cannot share its file.
//  This is a host action about a file, exactly like the installer above it.
//

import Foundation

enum OptionsStoreError: Error, CustomStringConvertible {
    case missingOptions

    var description: String {
        switch self {
        case .missingOptions: return "Options save was missing its payload"
        }
    }
}

enum OptionsStore {
    /// Beside the dictionary database, in the same container directory.
    static var path: String {
        (DictionaryStore.directory as NSString).appendingPathComponent("options.json")
    }

    /// The stored options JSON string, or `nil` if nothing has been saved yet — which the extension
    /// reads as "no options on this host", its cue to fall back to the legacy `chrome.storage.local`
    /// copy once (the one-time migration) and then to defaults.
    static func load() throws -> String? {
        let path = self.path
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return String(data: data, encoding: .utf8)
    }

    /// Writes the options JSON string atomically, creating the container directory if needed.
    ///
    /// `.atomic` writes to a sibling temp file and renames, so a crash or termination mid-write
    /// cannot truncate a working options file — the same guarantee the dictionary installer stages
    /// for, at a fraction of the size.
    @discardableResult
    static func save(_ json: String) throws -> Int {
        try FileManager.default.createDirectory(atPath: DictionaryStore.directory, withIntermediateDirectories: true)
        let data = Data(json.utf8)
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        return data.count
    }
}
