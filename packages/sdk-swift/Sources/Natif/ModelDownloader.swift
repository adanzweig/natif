import Foundation

/// Moves bytes from a URL to a local file. `URLSessionDownloadTransport` is the real one;
/// tests inject a fake.
public protocol DownloadTransport: Sendable {
    /// Downloads `url` (or continues from `resumeData`) and leaves the complete file at `destination`.
    /// On failure or cancellation, throws `DownloadInterrupted` carrying resume data when the
    /// transfer can be continued later.
    func download(from url: URL, resumeData: Data?, to destination: URL,
                  progress: @escaping @Sendable (_ written: Int64, _ expected: Int64) -> Void) async throws
}

public struct DownloadInterrupted: Error, Sendable {
    public var resumeData: Data?
    public var underlying: any Error
    public init(resumeData: Data?, underlying: any Error) {
        self.resumeData = resumeData
        self.underlying = underlying
    }
}

/// Where model files live: `<dir>/<id>.gguf`, with `<id>.gguf.part` while finishing and
/// `<id>.gguf.resume` holding URLSession resume data between attempts.
/// Only complete files (after the final rename) count as cached.
public struct ModelFiles: Sendable {
    public var directory: URL

    /// Default: Application Support/natif-models (excluded from iCloud backup).
    public static var defaultDirectory: URL {
        URL.applicationSupportDirectory.appending(path: "natif-models", directoryHint: .isDirectory)
    }

    public init(directory: URL = ModelFiles.defaultDirectory) { self.directory = directory }

    public func file(_ id: String) -> URL { directory.appending(path: "\(id).gguf") }
    public func partFile(_ id: String) -> URL { directory.appending(path: "\(id).gguf.part") }
    public func resumeFile(_ id: String) -> URL { directory.appending(path: "\(id).gguf.resume") }

    public func isComplete(_ id: String) -> Bool { FileManager.default.fileExists(atPath: file(id).path) }

    func ensureDirectory() throws {
        guard !FileManager.default.fileExists(atPath: directory.path) else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var dir = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
    }
}

/// Resumable, single-flight model downloads.
public actor ModelDownloader {
    public let files: ModelFiles
    private let transport: any DownloadTransport
    private var inFlight: [String: Task<URL, any Error>] = [:]

    public init(files: ModelFiles = ModelFiles(), transport: any DownloadTransport = URLSessionDownloadTransport()) {
        self.files = files
        self.transport = transport
    }

    /// Returns the complete file, downloading (or resuming) it first if needed.
    public func ensure(id: String, url: URL, onProgress: ProgressHandler?) async throws -> URL {
        if files.isComplete(id) { return files.file(id) }
        if let running = inFlight[id] { return try await running.value }
        let task = Task { try await self.run(id: id, url: url, onProgress: onProgress) }
        inFlight[id] = task
        defer { inFlight[id] = nil }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func run(id: String, url: URL, onProgress: ProgressHandler?) async throws -> URL {
        try files.ensureDirectory()
        let fm = FileManager.default
        let part = files.partFile(id)
        let resumeURL = files.resumeFile(id)
        try? fm.removeItem(at: part)
        let progress: @Sendable (Int64, Int64) -> Void = { written, expected in
            let f = expected > 0 ? min(1, Double(written) / Double(expected)) : 0
            onProgress?(LoadProgress(modelId: id, progress: f, phase: .download))
        }

        var resumeData = try? Data(contentsOf: resumeURL)
        while true {
            do {
                try await transport.download(from: url, resumeData: resumeData, to: part, progress: progress)
                break
            } catch let e as DownloadInterrupted {
                if let data = e.resumeData {
                    try? data.write(to: resumeURL, options: .atomic)
                } else {
                    try? fm.removeItem(at: resumeURL)
                    // Stale resume data (server file changed, temp file purged): start over once.
                    if resumeData != nil && !(e.underlying is CancellationError) && !Task.isCancelled {
                        resumeData = nil
                        continue
                    }
                }
                throw e.underlying
            }
        }
        try? fm.removeItem(at: resumeURL)
        let dest = files.file(id)
        try? fm.removeItem(at: dest)
        try fm.moveItem(at: part, to: dest)
        return dest
    }
}

// MARK: - URLSession transport

/// URLSession download task with progress and resume data. Resume data is produced on network
/// errors and on cancellation, so the next attempt continues where this one stopped.
public final class URLSessionDownloadTransport: DownloadTransport {
    private let configuration: URLSessionConfiguration

    public init(configuration: URLSessionConfiguration = .default) {
        self.configuration = configuration
    }

    public func download(from url: URL, resumeData: Data?, to destination: URL,
                         progress: @escaping @Sendable (Int64, Int64) -> Void) async throws {
        let delegate = DownloadDelegate(destination: destination, progress: progress)
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let task = resumeData.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: url)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, any Error>) in
                if delegate.start(cont) { task.resume() }
            }
        } onCancel: {
            delegate.markCancelled()
            task.cancel(byProducingResumeData: { data in
                delegate.finish(.failure(DownloadInterrupted(resumeData: data, underlying: CancellationError())))
            })
        }
    }
}

private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let destination: URL
    private let progress: @Sendable (Int64, Int64) -> Void
    private var continuation: CheckedContinuation<Void, any Error>?
    private var pending: Result<Void, any Error>?
    private var cancelled = false
    private var fileError: (any Error)?
    private var resumeOffset: Int64 = 0

    init(destination: URL, progress: @escaping @Sendable (Int64, Int64) -> Void) {
        self.destination = destination
        self.progress = progress
    }

    /// Returns false when the transfer already ended (cancelled before it started).
    func start(_ cont: CheckedContinuation<Void, any Error>) -> Bool {
        lock.lock()
        if let pending {
            lock.unlock()
            cont.resume(with: pending)
            return false
        }
        if cancelled {
            lock.unlock()
            cont.resume(throwing: DownloadInterrupted(resumeData: nil, underlying: CancellationError()))
            return false
        }
        continuation = cont
        lock.unlock()
        return true
    }

    func markCancelled() {
        lock.lock(); cancelled = true; lock.unlock()
    }

    func finish(_ result: Result<Void, any Error>) {
        lock.lock()
        guard let cont = continuation else {
            if pending == nil { pending = result }
            lock.unlock()
            return
        }
        continuation = nil
        lock.unlock()
        cont.resume(with: result)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didResumeAtOffset fileOffset: Int64, expectedTotalBytes: Int64) {
        lock.lock(); resumeOffset = fileOffset; lock.unlock()
        progress(fileOffset, expectedTotalBytes)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        progress(totalBytesWritten, totalBytesExpectedToWrite)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The temp file is deleted when this returns: move it now.
        if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            lock.lock(); fileError = NatifError.downloadFailed("HTTP \(http.statusCode)"); lock.unlock()
            return
        }
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: location, to: destination)
        } catch {
            lock.lock(); fileError = error; lock.unlock()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        lock.lock()
        let wasCancelled = cancelled
        let fe = fileError
        lock.unlock()
        if let error {
            // Our own cancel reports through cancel(byProducingResumeData:) instead.
            if wasCancelled && (error as? URLError)?.code == .cancelled { return }
            let data = (error as? URLError)?.downloadTaskResumeData
            finish(.failure(DownloadInterrupted(resumeData: data, underlying: error)))
        } else if let fe {
            finish(.failure(DownloadInterrupted(resumeData: nil, underlying: fe)))
        } else {
            finish(.success(()))
        }
    }
}
