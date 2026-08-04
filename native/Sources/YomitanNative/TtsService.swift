//
//  TtsService.swift
//  Yomitan Safari Extension
//
//  Native text-to-speech, over AVFoundation.
//
//  This is a *host* action, not an engine action: AVSpeechSynthesizer is AVFoundation, not
//  JavaScript, so it cannot live in the JSC engine — it sits in the message router beside
//  `ankiRequest`. It exists because Safari's `speechSynthesis.getVoices()` exposes only a single
//  voice (`Anna`) even when many are installed, so the extension cannot reach the good German voices
//  through Web Speech; rendering natively gives it the whole installed set, Enhanced/Premium
//  included (plan/audio-service.md).
//

import AVFoundation
import Foundation

enum TtsService {
    enum TtsError: Error, CustomStringConvertible {
        case timedOut
        case producedNothing

        var description: String {
            switch self {
            case .timedOut: return "TTS synthesis timed out"
            case .producedNothing: return "TTS synthesis produced no audio"
            }
        }
    }

    /// The installed voices, as the settings picker sees them. `AVSpeechSynthesisVoice.speechVoices()`
    /// is the whole set — every language and quality tier — where `speechSynthesis.getVoices()` in
    /// Safari returns one. Available since the appex's 10.14 floor.
    static func voices() -> [[String: Any]] {
        AVSpeechSynthesisVoice.speechVoices().map { voice in
            [
                "id": voice.identifier,
                "name": voice.name,
                "language": voice.language,
                "quality": qualityName(voice.quality),
            ]
        }
    }

    private static func qualityName(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        // `.premium` is macOS 13+; below that the enum has only default/enhanced.
        if #available(macOS 13.0, iOS 16.0, *), quality == .premium { return "premium" }
        return quality == .enhanced ? "enhanced" : "default"
    }

    /// Offline-renders `text` to a 16-bit-PCM WAV and calls `completion` with the bytes.
    ///
    /// **Must be called on the main queue.** `AVSpeechSynthesizer.write` delivers its buffers on the
    /// main run loop — a background `DispatchQueue` thread never receives them (measured) — so the
    /// synthesis is driven by the appex's live main run loop rather than a pumped or blocked one. The
    /// completion likewise fires on the main queue.
    ///
    /// `write` is macOS 10.15+, so the router guards this behind `#available` and falls back to the
    /// browser's `speechSynthesis` on the 10.14 floor.
    @available(macOS 10.15, iOS 13.0, *)
    static func synthesize(
        text: String,
        voiceId: String?,
        language: String?,
        rate: Float?,
        pitch: Float?,
        completion: @escaping (Result<Data, Error>) -> Void
    ) {
        let utterance = AVSpeechUtterance(string: text)
        // Prefer the requested voice by identifier; fall back to any voice for the term's language so
        // German text is not read by an English default when the stored id does not resolve.
        if let voiceId, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
            utterance.voice = voice
        } else if let language, let voice = AVSpeechSynthesisVoice(language: language) {
            utterance.voice = voice
        }
        if let rate { utterance.rate = rate }
        if let pitch { utterance.pitchMultiplier = pitch }

        let synthesizer = AVSpeechSynthesizer()
        // Hold the synthesizer alive across the async render; a local would be released the moment
        // this function returns, before the first buffer arrives.
        retain(synthesizer)

        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString).appendingPathExtension("wav")
        var outputFile: AVAudioFile?
        var finished = false

        let finish: (Result<Data, Error>) -> Void = { result in
            if finished { return }
            finished = true
            outputFile = nil // flush and close before the file is read
            release(synthesizer)
            try? FileManager.default.removeItem(at: outputURL)
            completion(result)
        }

        synthesizer.write(utterance) { buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else {
                finish(.failure(TtsError.producedNothing))
                return
            }
            // A final empty buffer signals completion.
            if pcm.frameLength == 0 {
                if let file = outputFile, let data = try? Data(contentsOf: file.url) {
                    finish(.success(data))
                } else {
                    finish(.failure(TtsError.producedNothing))
                }
                return
            }
            do {
                if outputFile == nil {
                    let format = pcm.format
                    outputFile = try AVAudioFile(forWriting: outputURL, settings: [
                        AVFormatIDKey: kAudioFormatLinearPCM,
                        AVSampleRateKey: format.sampleRate,
                        AVNumberOfChannelsKey: format.channelCount,
                        AVLinearPCMBitDepthKey: 16,
                        AVLinearPCMIsFloatKey: false,
                        AVLinearPCMIsBigEndianKey: false,
                    ])
                }
                try outputFile?.write(from: pcm)
            } catch {
                finish(.failure(error))
            }
        }

        // A guard against a render that never delivers its terminal buffer, so a stuck call cannot
        // leave the request hanging forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
            finish(.failure(TtsError.timedOut))
        }
    }

    // The synthesizers currently rendering, kept alive for the duration of the async write. Touched
    // only on the main queue (synthesis runs there), so it needs no lock.
    private static var active: [AVSpeechSynthesizer] = []
    private static func retain(_ synthesizer: AVSpeechSynthesizer) { active.append(synthesizer) }
    private static func release(_ synthesizer: AVSpeechSynthesizer) {
        active.removeAll { $0 === synthesizer }
    }
}
