import Foundation
import Testing
@testable import Natif

/// Scripted transport: each attempt either fails (optionally with resume data) or writes the file.
actor FakeTransport: DownloadTransport {
    enum Step { case fail(resume: Data?), succeed(Data) }
    var steps: [Step]
    var receivedResume: [Data?] = []
    init(_ steps: [Step]) { self.steps = steps }

    func download(from url: URL, resumeData: Data?, to destination: URL,
                  progress: @escaping @Sendable (Int64, Int64) -> Void) async throws {
        receivedResume.append(resumeData)
        let step = steps.removeFirst()
        switch step {
        case .fail(let resume):
            progress(50, 100)
            throw DownloadInterrupted(resumeData: resume, underlying: URLError(.networkConnectionLost))
        case .succeed(let data):
            progress(100, 100)
            try data.write(to: destination)
        }
    }
}

private func tempFiles() -> ModelFiles {
    ModelFiles(directory: FileManager.default.temporaryDirectory.appending(path: "benatif-tests-\(UUID().uuidString)"))
}

@Suite struct DownloadTests {
    let url = URL(string: "https://example.test/Qwen3-1.7B-Q8_0.gguf")!

    @Test func persistsResumeDataAndResumesNextTime() async throws {
        let files = tempFiles()
        let transport = FakeTransport([.fail(resume: Data("resume-1".utf8)), .succeed(Data("weights".utf8))])
        let d = ModelDownloader(files: files, transport: transport)
        let progress = Box<[Double]>([])

        await #expect(throws: URLError.self) {
            _ = try await d.ensure(id: "m", url: url) { p in progress.mutate { $0.append(p.progress) } }
        }
        #expect(!files.isComplete("m"))
        #expect(try Data(contentsOf: files.resumeFile("m")) == Data("resume-1".utf8))

        let file = try await d.ensure(id: "m", url: url, onProgress: nil)
        #expect(await transport.receivedResume == [nil, Data("resume-1".utf8)])
        #expect(try Data(contentsOf: file) == Data("weights".utf8))
        #expect(files.isComplete("m"))
        #expect(!FileManager.default.fileExists(atPath: files.resumeFile("m").path))
        #expect(!FileManager.default.fileExists(atPath: files.partFile("m").path))
        #expect(progress.value == [0.5])

        // Complete files are not downloaded again.
        _ = try await d.ensure(id: "m", url: url, onProgress: nil)
        #expect(await transport.receivedResume.count == 2)
    }

    @Test func staleResumeDataRestartsFromScratchOnce() async throws {
        let files = tempFiles()
        try files.ensureDirectory()
        try Data("stale".utf8).write(to: files.resumeFile("m"))
        let transport = FakeTransport([.fail(resume: nil), .succeed(Data("w".utf8))])
        _ = try await ModelDownloader(files: files, transport: transport).ensure(id: "m", url: url, onProgress: nil)
        #expect(await transport.receivedResume == [Data("stale".utf8), nil])
        #expect(files.isComplete("m"))
    }

    @Test func llamaEngineResolvesGGUFAndDownloadsWithoutLoading() async throws {
        let files = tempFiles()
        let transport = FakeTransport([.succeed(Data("gguf".utf8))])
        let engine = LlamaEngine(options: LlamaEngineOptions(files: files, transport: transport))
        let spec = ModelCatalog.bundled.model("qwen3-1.7b")!
        let id = try #require(engine.resolveModelId(spec, device: iPhone))
        #expect(id == "Qwen3-1.7B-Q8_0")
        #expect(engine.resolveModelId(ModelCatalog.bundled.model("gemma-4-e2b")!, device: iPhone) == nil)
        #expect(await engine.isCached(id) == false)
        let phases = Box<[LoadProgress.Phase]>([])
        try await engine.download(id) { p in phases.mutate { $0.append(p.phase) } }
        #expect(await engine.isCached(id))
        #expect(phases.value == [.download, .ready])
        try await engine.deleteModel(id)
        #expect(await engine.isCached(id) == false)
    }

    @Test func utf8SplitKeepsMultibyteCharactersWhole() {
        let bytes = Array("añ😀".utf8)
        let (c1, r1) = splitCompleteUTF8(Array(bytes.prefix(2)))
        #expect(c1 == [0x61] && r1.count == 1)
        let (c2, r2) = splitCompleteUTF8(Array(bytes.prefix(5)))
        #expect(String(decoding: c2, as: UTF8.self) == "añ" && r2.count == 2)
        #expect(splitCompleteUTF8(bytes).complete == bytes)
    }
}
