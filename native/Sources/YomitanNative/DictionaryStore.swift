//
//  DictionaryStore.swift
//  Yomitan Safari Extension
//
//  Where the dictionary database lives, and how a compiled one gets there.
//
//  This file is the whole answer to plan/history/safari-opfs-blocker.md. Safari regenerates the extension's
//  `safari-web-extension://<UUID>` origin on every launch, and OPFS is partitioned by origin, so an
//  imported dictionary was stranded on every restart. The app container is keyed by bundle
//  identifier, which does not rotate — so the file simply stays where it was put.
//

import Foundation

enum DictionaryStore {
    /// The database's directory inside the app-extension container.
    ///
    /// `Application Support` rather than `Caches`: this is user data that is expensive to recreate,
    /// and the system may evict caches under disk pressure — which would reproduce the exact failure
    /// this move exists to fix, only less predictably.
    ///
    /// **If the standalone app happens, this moves to an App Group container** so the app and the
    /// extension read one file rather than two. App Groups need a provisioning entitlement and the
    /// build currently signs with a free Personal Team, so that is verified before it is relied on,
    /// not after (plan/native-rewrite.md → Storage location).
    static var directory: String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("Yomitan", isDirectory: true).path
    }

    static var databasePath: String {
        (directory as NSString).appendingPathComponent("dictionaries.sqlite3")
    }

    /// Where an install is staged before it replaces the live database.
    static var stagingPath: String {
        (directory as NSString).appendingPathComponent("dictionaries.sqlite3.incoming")
    }
}

enum DictionaryInstallError: Error, CustomStringConvertible {
    case missingChunk
    case notStarted
    case badBase64
    case notADatabase(String)

    var description: String {
        switch self {
        case .missingChunk: return "Install chunk was missing its payload"
        case .notStarted: return "No install is in progress"
        case .badBase64: return "Install chunk was not valid base64"
        case .notADatabase(let detail): return "The uploaded file is not a usable dictionary database: \(detail)"
        }
    }
}

/// Receives a build-time-compiled `.sqlite3` in chunks and swaps it in atomically.
///
/// Staged rather than written in place, for one specific reason: a transfer that is interrupted
/// half-way — Safari terminating the app extension, the browser closing — would otherwise leave a
/// truncated file where a working database used to be, and the user would find their dictionaries
/// gone. The live database is only touched once the whole file has arrived and has been checked to
/// be a SQLite database with the expected schema version.
final class DictionaryInstaller {
    static let shared = DictionaryInstaller()

    private var handle: FileHandle?
    private var bytesWritten = 0

    private init() {}

    func begin() throws {
        abort()
        let directory = DictionaryStore.directory
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let path = DictionaryStore.stagingPath
        FileManager.default.createFile(atPath: path, contents: nil)
        handle = FileHandle(forWritingAtPath: path)
        bytesWritten = 0
        if handle == nil { throw DictionaryInstallError.notStarted }
    }

    @discardableResult
    func append(base64: String) throws -> Int {
        guard let handle else { throw DictionaryInstallError.notStarted }
        guard let data = Data(base64Encoded: base64) else { throw DictionaryInstallError.badBase64 }
        handle.write(data)
        bytesWritten += data.count
        return bytesWritten
    }

    /// Validates the staged file and moves it over the live database.
    @discardableResult
    func commit() throws -> Int {
        guard let handle else { throw DictionaryInstallError.notStarted }
        // `closeFile()`, not `close()`: the app-extension target deploys back to macOS 10.14 and the
        // throwing variant is 10.15+.
        handle.closeFile()
        self.handle = nil

        let staging = DictionaryStore.stagingPath
        try validate(path: staging)

        let destination = DictionaryStore.databasePath
        // SQLite's rollback journal and WAL belong to the file being replaced; leaving them behind
        // would let SQLite try to recover the *old* database's transaction into the new file.
        for suffix in ["-journal", "-wal", "-shm"] {
            try? FileManager.default.removeItem(atPath: destination + suffix)
        }
        if FileManager.default.fileExists(atPath: destination) {
            _ = try FileManager.default.replaceItemAt(
                URL(fileURLWithPath: destination),
                withItemAt: URL(fileURLWithPath: staging)
            )
        } else {
            try FileManager.default.moveItem(atPath: staging, toPath: destination)
        }
        return bytesWritten
    }

    func abort() {
        handle?.closeFile()
        handle = nil
        bytesWritten = 0
        try? FileManager.default.removeItem(atPath: DictionaryStore.stagingPath)
    }

    /// Checks the magic header and the schema version before anything is replaced.
    ///
    /// Cheap, and it catches the two mistakes that would otherwise present as a broken extension
    /// rather than a failed install: uploading the dictionary `.zip` by accident, and installing a
    /// database compiled by a build whose schema this app does not understand.
    private func validate(path: String) throws {
        guard let file = FileHandle(forReadingAtPath: path) else {
            throw DictionaryInstallError.notADatabase("could not be read back")
        }
        defer { file.closeFile() }
        let header = file.readData(ofLength: 100)
        guard header.count >= 100 else {
            throw DictionaryInstallError.notADatabase("file is too short")
        }
        guard header.prefix(16) == Data("SQLite format 3\0".utf8) else {
            throw DictionaryInstallError.notADatabase("missing the SQLite file header")
        }
        // `user_version` is a big-endian 32-bit integer at offset 60 of the header, which is where
        // the schema version lives (dictionary-sqlite-schema.js).
        let version = header.subdata(in: 60..<64).reduce(Int(0)) { ($0 << 8) | Int($1) }
        guard version == Self.expectedSchemaVersion else {
            throw DictionaryInstallError.notADatabase("schema version \(version), expected \(Self.expectedSchemaVersion)")
        }
    }

    /// Mirrors `DICTIONARY_SQLITE_SCHEMA_VERSION`. `test/native-host-shims.test.js` reads this
    /// literal out of the source and asserts it matches, so the two cannot drift silently -- a bump
    /// that missed this line would leave the installer rejecting every valid database.
    static let expectedSchemaVersion = 5
}
