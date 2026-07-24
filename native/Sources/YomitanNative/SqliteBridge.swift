//
//  SqliteBridge.swift
//  Yomitan Safari Extension
//
//  System libsqlite3, exposed to JavaScriptCore with the same handle interface the dictionary
//  backend already talks to.
//
//  The engine funnels every query through `openDictionaryDatabaseHandle`, which takes the sqlite3
//  module as an argument rather than importing it — a seam that already existed so node tests could
//  use `:memory:` and the OPFS worker could use the SAH-Pool. This file substitutes at exactly that
//  seam, which is why moving the engine into the app is a re-host and not a rewrite. The shape
//  implemented here is `SqliteDatabaseHandle`/`SqliteStatement` in types/ext/sqlite-wasm.d.ts; keep
//  the two in step.
//

import Foundation
import JavaScriptCore
import SQLite3

/// SQLite wants to be told that the bound bytes are its caller's and must be copied. The symbol
/// `SQLITE_TRANSIENT` is a macro and does not import into Swift.
private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Thrown for anything libsqlite3 reports. Converted to a JS exception at the boundary so the
/// engine sees a normal `Error` and its existing error handling applies unchanged.
struct SqliteError: Error, CustomStringConvertible {
    let code: Int32
    let message: String
    let context: String

    var description: String { "SQLite error \(code) in \(context): \(message)" }
}

// MARK: - Statement

@objc protocol SqliteStatementExports: JSExport {
    // Unnamed second parameters are deliberate: an Objective-C selector of `bind::` maps to the
    // JavaScript name `bind`, whereas `bind:value:` would arrive as `bindValue`. The JS side is
    // upstream-shaped code that calls `bind`, so the selector has to produce that name.
    func bind(_ a: JSValue, _ b: JSValue) -> JSValue
    func step() -> Bool
    func stepReset() -> JSValue
    func reset(_ alsoClearBinds: JSValue) -> JSValue
    func get(_ target: JSValue) -> JSValue
    // `finalize` collides with the deprecated `NSObject.finalize` from Objective-C's garbage
    // collector, which owns the selector. Overriding it is the only way to export that name, and the
    // name is not negotiable: the engine's statement cache calls `statement.finalize()`.
    func finalize()
}

/// One prepared statement. The engine holds these across calls (an LRU keyed by SQL text) because
/// re-preparing per lookup dominated the query cost — 434 candidates measured 9.44 ms re-prepared
/// against 1.52 ms held — so `finalize` really is the only thing that frees one.
@objc final class SqliteStatementBridge: NSObject, SqliteStatementExports {
    private var handle: OpaquePointer?
    private weak var database: SqliteDatabaseBridge?
    private let sql: String

    init(handle: OpaquePointer, database: SqliteDatabaseBridge, sql: String) {
        self.handle = handle
        self.database = database
        self.sql = sql
    }

    deinit {
        if let handle { sqlite3_finalize(handle) }
    }

    private func requireHandle() throws -> OpaquePointer {
        guard let handle else {
            throw SqliteError(code: SQLITE_MISUSE, message: "Statement has been finalized", context: sql)
        }
        return handle
    }

    /// `bind(index, value)` or `bind(valueOrArrayOrObject)`, matching the oo1 API the engine uses.
    /// Returns `self` so the `bind(...).stepReset()` chain in the insert paths keeps working.
    func bind(_ a: JSValue, _ b: JSValue) -> JSValue {
        JSBridge.trapping(JSContext.current()!) {
            let handle = try requireHandle()
            if b.isUndefined {
                try SqliteValue.bindAll(a, to: handle, sql: sql)
            } else {
                // The oo1 API is 1-based for the index form, as libsqlite3 is.
                try SqliteValue.bind(b, to: handle, at: Int32(a.toInt32()), sql: sql)
            }
            return JSValue(object: self, in: JSContext.current())
        }
    }

    func step() -> Bool {
        JSBridge.trapping(JSContext.current()!, fallback: false) {
            let handle = try requireHandle()
            let result = sqlite3_step(handle)
            switch result {
            case SQLITE_ROW: return true
            case SQLITE_DONE: return false
            default: throw self.error(result)
            }
        }
    }

    /// Step a write statement to completion and reset it for the next row — the shape every bulk
    /// insert loop uses.
    func stepReset() -> JSValue {
        JSBridge.trapping(JSContext.current()!) {
            let handle = try requireHandle()
            let result = sqlite3_step(handle)
            if result != SQLITE_DONE && result != SQLITE_ROW { throw self.error(result) }
            sqlite3_reset(handle)
            return JSValue(object: self, in: JSContext.current())
        }
    }

    func reset(_ alsoClearBinds: JSValue) -> JSValue {
        JSBridge.trapping(JSContext.current()!) {
            let handle = try requireHandle()
            sqlite3_reset(handle)
            // Held statements are rebound on their next use, so dropping the old bindings is what
            // stops a stale value surviving into a query that binds fewer parameters.
            if alsoClearBinds.isBoolean && alsoClearBinds.toBool() { sqlite3_clear_bindings(handle) }
            return JSValue(object: self, in: JSContext.current())
        }
    }

    /// `get(index)` returns one column; `get({})` collects the whole row keyed by column name, which
    /// is the form every read path in the engine uses.
    func get(_ target: JSValue) -> JSValue {
        JSBridge.trapping(JSContext.current()!) {
            let handle = try requireHandle()
            let context = JSContext.current()!
            if target.isNumber {
                return SqliteValue.column(handle, index: Int32(target.toInt32()), in: context)
            }
            let row = target.isObject ? target : JSValue(newObjectIn: context)!
            let count = sqlite3_column_count(handle)
            for index in 0..<count {
                let name = String(cString: sqlite3_column_name(handle, index))
                row.setValue(SqliteValue.column(handle, index: index, in: context), forProperty: name)
            }
            return row
        }
    }

    override func finalize() {
        guard let handle else { return }
        self.handle = nil
        sqlite3_finalize(handle)
    }

    private func error(_ code: Int32) -> SqliteError {
        SqliteError(code: code, message: database?.lastErrorMessage ?? "unknown", context: sql)
    }
}

// MARK: - Database

@objc protocol SqliteDatabaseExports: JSExport {
    func exec(_ sql: String) -> JSValue
    func prepare(_ sql: String) -> JSValue
    func selectValue(_ sql: String, _ bind: JSValue) -> JSValue
    func selectObject(_ sql: String, _ bind: JSValue) -> JSValue
    func selectObjects(_ sql: String, _ bind: JSValue) -> JSValue
    func transaction(_ callback: JSValue) -> JSValue
    func close()
}

/// One database connection. Instances are created by `NativeHost.openDatabase` and handed to the
/// engine as `sqlite3.oo1.DB`.
@objc final class SqliteDatabaseBridge: NSObject, SqliteDatabaseExports {
    private var handle: OpaquePointer?
    /// Nesting depth of `transaction()`. SQLite has no nested `BEGIN`, and the engine does nest
    /// (`finalizeImport` runs inside one), so only the outermost begins and commits.
    private var transactionDepth = 0

    var lastErrorMessage: String {
        guard let handle, let message = sqlite3_errmsg(handle) else { return "unknown" }
        return String(cString: message)
    }

    init(path: String) throws {
        super.init()
        var connection: OpaquePointer?
        // Serialized threading mode is not requested: the router funnels every call onto one queue,
        // so the connection is only ever touched from that queue. FULLMUTEX would buy nothing and
        // cost a lock on every statement in the hover path.
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
        let result = sqlite3_open_v2(path, &connection, flags, nil)
        guard result == SQLITE_OK, let connection else {
            let message = connection.map { String(cString: sqlite3_errmsg($0)) } ?? "unable to open database"
            if let connection { sqlite3_close_v2(connection) }
            throw SqliteError(code: result, message: message, context: "open \(path)")
        }
        handle = connection
        // A lookup that arrives while an install is still writing should wait briefly rather than
        // fail; the router serializes our own calls, but the main app may hold the file too.
        sqlite3_busy_timeout(connection, 5000)
    }

    deinit {
        if let handle { sqlite3_close_v2(handle) }
    }

    private func requireHandle() throws -> OpaquePointer {
        guard let handle else {
            throw SqliteError(code: SQLITE_MISUSE, message: "Database is closed", context: "requireHandle")
        }
        return handle
    }

    func exec(_ sql: String) -> JSValue {
        JSBridge.trapping(JSContext.current()!) {
            let handle = try requireHandle()
            var errorMessage: UnsafeMutablePointer<CChar>?
            let result = sqlite3_exec(handle, sql, nil, nil, &errorMessage)
            if result != SQLITE_OK {
                let message = errorMessage.map { String(cString: $0) } ?? self.lastErrorMessage
                sqlite3_free(errorMessage)
                throw SqliteError(code: result, message: message, context: sql)
            }
            return JSValue(object: self, in: JSContext.current())
        }
    }

    func prepare(_ sql: String) -> JSValue {
        JSBridge.trapping(JSContext.current()!) {
            let handle = try requireHandle()
            var statement: OpaquePointer?
            let result = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
            guard result == SQLITE_OK, let statement else {
                throw SqliteError(code: result, message: self.lastErrorMessage, context: sql)
            }
            let bridge = SqliteStatementBridge(handle: statement, database: self, sql: sql)
            return JSValue(object: bridge, in: JSContext.current())
        }
    }

    func selectValue(_ sql: String, _ bind: JSValue) -> JSValue {
        JSBridge.trapping(JSContext.current()!) {
            let context = JSContext.current()!
            return try withStatement(sql, bind) { statement in
                sqlite3_step(statement) == SQLITE_ROW
                    ? SqliteValue.column(statement, index: 0, in: context)
                    : JSValue(undefinedIn: context)!
            }
        }
    }

    func selectObject(_ sql: String, _ bind: JSValue) -> JSValue {
        JSBridge.trapping(JSContext.current()!) {
            let context = JSContext.current()!
            return try withStatement(sql, bind) { statement in
                sqlite3_step(statement) == SQLITE_ROW
                    ? SqliteValue.row(statement, in: context)
                    : JSValue(undefinedIn: context)!
            }
        }
    }

    func selectObjects(_ sql: String, _ bind: JSValue) -> JSValue {
        JSBridge.trapping(JSContext.current()!) {
            let context = JSContext.current()!
            return try withStatement(sql, bind) { statement in
                let rows = JSValue(newArrayIn: context)!
                var index = 0
                while sqlite3_step(statement) == SQLITE_ROW {
                    rows.setValue(SqliteValue.row(statement, in: context), at: index)
                    index += 1
                }
                return rows
            }
        }
    }

    /// Runs `callback(this)` inside a transaction, committing on return and rolling back if the
    /// callback throws — the semantics the engine's bulk writes and `purge` depend on.
    func transaction(_ callback: JSValue) -> JSValue {
        JSBridge.trapping(JSContext.current()!) {
            let handle = try requireHandle()
            let context = JSContext.current()!
            let selfValue = JSValue(object: self, in: context)!
            let outermost = transactionDepth == 0
            if outermost { try execRaw(handle, "BEGIN") }
            transactionDepth += 1
            let result = callback.call(withArguments: [selfValue])
            transactionDepth -= 1
            // A JS exception inside the callback surfaces as the context's exception rather than as
            // a Swift throw, so it has to be checked explicitly — otherwise a failed batch would be
            // committed. The exception is left in place so it keeps propagating to the JS caller;
            // all that is added here is the rollback.
            if context.exception != nil {
                if outermost { try? execRaw(handle, "ROLLBACK") }
                return JSValue(undefinedIn: context)!
            }
            if outermost { try execRaw(handle, "COMMIT") }
            return result ?? JSValue(undefinedIn: context)!
        }
    }

    func close() {
        guard let handle else { return }
        self.handle = nil
        sqlite3_close_v2(handle)
    }

    // MARK: Helpers

    private func execRaw(_ handle: OpaquePointer, _ sql: String) throws {
        let result = sqlite3_exec(handle, sql, nil, nil, nil)
        if result != SQLITE_OK {
            throw SqliteError(code: result, message: lastErrorMessage, context: sql)
        }
    }

    /// Prepares, binds, runs `body`, and always finalizes. Used by the `select*` convenience methods,
    /// which — unlike the hot read paths — compile a statement per call by design.
    private func withStatement<T>(_ sql: String, _ bind: JSValue, _ body: (OpaquePointer) throws -> T) throws -> T {
        let handle = try requireHandle()
        var statement: OpaquePointer?
        let result = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard result == SQLITE_OK, let statement else {
            throw SqliteError(code: result, message: lastErrorMessage, context: sql)
        }
        defer { sqlite3_finalize(statement) }
        if !bind.isUndefined && !bind.isNull {
            try SqliteValue.bindAll(bind, to: statement, sql: sql)
        }
        return try body(statement)
    }
}

// MARK: - Value marshalling

/// Converts between SQLite's value space and JavaScript's.
///
/// The only interesting case is BLOB. The engine's payloads are `Uint8Array`, and this is the one
/// place where a wrong conversion would be silent — a BLOB read back as a string would decompress to
/// garbage rather than fail — so both directions go through typed-array memory directly.
enum SqliteValue {
    static func bindAll(_ value: JSValue, to statement: OpaquePointer, sql: String) throws {
        if value.isArray {
            let count = Int(value.forProperty("length").toInt32())
            for index in 0..<count {
                try bind(value.atIndex(index), to: statement, at: Int32(index + 1), sql: sql)
            }
            return
        }
        if value.isObject {
            // Named parameters (`$name`). The engine does not use them today, but the interface
            // documents them, and silently binding nothing would be a very quiet way to fail.
            guard let names = value.toDictionary() as? [String: Any] else { return }
            for (name, _) in names {
                let index = sqlite3_bind_parameter_index(statement, ":\(name)")
                if index > 0 { try bind(value.forProperty(name), to: statement, at: index, sql: sql) }
            }
            return
        }
        try bind(value, to: statement, at: 1, sql: sql)
    }

    static func bind(_ value: JSValue, to statement: OpaquePointer, at index: Int32, sql: String) throws {
        let result: Int32
        if value.isNull || value.isUndefined {
            result = sqlite3_bind_null(statement, index)
        } else if value.isBoolean {
            result = sqlite3_bind_int64(statement, index, value.toBool() ? 1 : 0)
        } else if value.isNumber {
            let number = value.toDouble()
            // Integers must not be stored as REAL: `dictionary_id` and `sequence` are compared and
            // indexed as integers, and a REAL 3.0 does not equal an INTEGER 3 in a strict index seek.
            if number.rounded() == number && abs(number) < 9_007_199_254_740_992 {
                result = sqlite3_bind_int64(statement, index, Int64(number))
            } else {
                result = sqlite3_bind_double(statement, index, number)
            }
        } else if let bytes = typedArrayBytes(value) {
            result = bytes.isEmpty
                ? sqlite3_bind_zeroblob(statement, index, 0)
                : bytes.withUnsafeBytes { sqlite3_bind_blob(statement, index, $0.baseAddress, Int32(bytes.count), sqliteTransient) }
        } else {
            result = sqlite3_bind_text(statement, index, value.toString(), -1, sqliteTransient)
        }
        if result != SQLITE_OK {
            throw SqliteError(code: result, message: "failed to bind parameter \(index)", context: sql)
        }
    }

    static func column(_ statement: OpaquePointer, index: Int32, in context: JSContext) -> JSValue {
        switch sqlite3_column_type(statement, index) {
        case SQLITE_NULL:
            return JSValue(nullIn: context)
        case SQLITE_INTEGER:
            return JSValue(double: Double(sqlite3_column_int64(statement, index)), in: context)
        case SQLITE_FLOAT:
            return JSValue(double: sqlite3_column_double(statement, index), in: context)
        case SQLITE_BLOB:
            let count = Int(sqlite3_column_bytes(statement, index))
            return makeUint8Array(count: count, in: context) { destination in
                if count > 0, let source = sqlite3_column_blob(statement, index) {
                    memcpy(destination, source, count)
                }
            }
        default:
            guard let text = sqlite3_column_text(statement, index) else { return JSValue(nullIn: context) }
            return JSValue(object: String(cString: text), in: context)
        }
    }

    static func row(_ statement: OpaquePointer, in context: JSContext) -> JSValue {
        let row = JSValue(newObjectIn: context)!
        for index in 0..<sqlite3_column_count(statement) {
            let name = String(cString: sqlite3_column_name(statement, index))
            row.setValue(column(statement, index: index, in: context), forProperty: name)
        }
        return row
    }

    /// `Data` view of a `Uint8Array`, or nil when the value is not a typed array.
    ///
    /// The Objective-C `JSValue` typed-array conveniences are not in the public SDK, so this goes
    /// through the C API. Worth knowing: the length is the *element* count, which happens to equal
    /// the byte count only because the engine's blobs are always `Uint8Array`.
    private static func typedArrayBytes(_ value: JSValue) -> Data? {
        guard value.isObject, let context = value.context else { return nil }
        let contextRef = context.jsGlobalContextRef
        var exception: JSValueRef?
        let type = JSValueGetTypedArrayType(contextRef, value.jsValueRef, &exception)
        guard type != kJSTypedArrayTypeNone, type != kJSTypedArrayTypeArrayBuffer else { return nil }
        guard let object = JSValueToObject(contextRef, value.jsValueRef, &exception) else { return nil }
        let length = JSObjectGetTypedArrayByteLength(contextRef, object, &exception)
        guard length > 0 else { return Data() }
        guard let pointer = JSObjectGetTypedArrayBytesPtr(contextRef, object, &exception) else { return nil }
        return Data(bytes: pointer, count: length)
    }

    /// Allocates a `Uint8Array` in the context and lets `fill` write into its backing store directly,
    /// which is the only way to hand a large blob to JavaScript without copying it twice.
    private static func makeUint8Array(count: Int, in context: JSContext, fill: (UnsafeMutableRawPointer) -> Void) -> JSValue {
        let contextRef = context.jsGlobalContextRef
        var exception: JSValueRef?
        guard let object = JSObjectMakeTypedArray(contextRef, kJSTypedArrayTypeUint8Array, count, &exception) else {
            return JSValue(nullIn: context)
        }
        if count > 0, let pointer = JSObjectGetTypedArrayBytesPtr(contextRef, object, &exception) {
            fill(pointer)
        }
        return JSValue(jsValueRef: object, in: context)
    }
}

// MARK: - Error trapping

/// Turns a Swift throw into a JavaScript exception at the bridge boundary.
///
/// A Swift error cannot propagate through a `JSExport` method, and returning a sentinel would let a
/// failed write look like a successful one. Setting `context.exception` is what makes the engine's
/// own `try`/`catch` — which is written against a WASM build that throws — behave identically here.
enum JSBridge {
    /// The context is taken as an argument rather than looked up here so that every call site is
    /// forced to be inside a JSExport method, where `JSContext.current()` is guaranteed non-nil.
    static func trapping(_ context: JSContext, _ body: () throws -> JSValue) -> JSValue {
        do {
            return try body()
        } catch {
            context.exception = JSValue(newErrorFromMessage: "\(error)", in: context)
            return JSValue(undefinedIn: context)
        }
    }

    static func trapping<T>(_ context: JSContext, fallback: T, _ body: () throws -> T) -> T {
        do {
            return try body()
        } catch {
            context.exception = JSValue(newErrorFromMessage: "\(error)", in: context)
            return fallback
        }
    }
}
