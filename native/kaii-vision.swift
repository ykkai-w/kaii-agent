import CoreGraphics
import Darwin
import Foundation
import ImageIO
import Vision

private let ocrLineLimit = 80
private let classificationLimit = 15

private struct BoundingBox: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

private struct OCRLine: Codable {
    let text: String
    let confidence: Double
    let boundingBox: BoundingBox

    enum CodingKeys: String, CodingKey {
        case text
        case confidence
        case boundingBox = "bounding_box"
    }
}

private struct OCRResult: Codable {
    let text: String
    let lines: [OCRLine]
    let truncated: Bool
}

private struct Classification: Codable {
    let label: String
    let confidence: Double
}

private struct ImageResult: Codable {
    let ok: Bool
    let width: Int
    let height: Int
    let ocr: OCRResult
    let classifications: [Classification]
}

private struct ErrorDetail: Codable {
    let code: String
    let message: String
}

private struct ErrorResult: Codable {
    let ok: Bool
    let error: ErrorDetail
}

private enum CLIError: Error {
    case usage
    case pathMustBeAbsolute
    case notAFile
    case unreadableImage
}

private func rounded(_ value: Float) -> Double {
    (Double(value) * 1_000_000).rounded() / 1_000_000
}

private func rounded(_ value: CGFloat) -> Double {
    (Double(value) * 1_000_000).rounded() / 1_000_000
}

private func encodeJSON<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
}

private func writeJSON<T: Encodable>(_ value: T) throws {
    let data = try encodeJSON(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

private func terminate(code: String, message: String, status: Int32 = 2) -> Never {
    let payload = ErrorResult(ok: false, error: ErrorDetail(code: code, message: message))
    if let data = try? encodeJSON(payload) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    } else {
        let fallback = #"{"error":{"code":"encoding_failure","message":"Unable to encode error response."},"ok":false}"#
        FileHandle.standardOutput.write(Data((fallback + "\n").utf8))
    }
    exit(status)
}

private func exifOrientation(from source: CGImageSource) -> CGImagePropertyOrientation {
    guard
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let rawValue = properties[kCGImagePropertyOrientation] as? NSNumber,
        let orientation = CGImagePropertyOrientation(rawValue: rawValue.uint32Value)
    else {
        return .up
    }
    return orientation
}

private func run() throws {
    guard CommandLine.arguments.count == 2 else {
        throw CLIError.usage
    }

    let path = CommandLine.arguments[1]
    guard path.hasPrefix("/") else {
        throw CLIError.pathMustBeAbsolute
    }

    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
        throw CLIError.notAFile
    }

    let imageURL = URL(fileURLWithPath: path, isDirectory: false) as CFURL
    guard
        let source = CGImageSourceCreateWithURL(imageURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        throw CLIError.unreadableImage
    }

    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = .accurate
    textRequest.usesLanguageCorrection = true
    textRequest.automaticallyDetectsLanguage = true
    textRequest.minimumTextHeight = 0.01

    let classifyRequest = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(
        cgImage: image,
        orientation: exifOrientation(from: source),
        options: [:]
    )
    try handler.perform([textRequest, classifyRequest])

    let observations = textRequest.results ?? []
    let orderedObservations = observations.sorted { lhs, rhs in
        let verticalDelta = lhs.boundingBox.midY - rhs.boundingBox.midY
        if abs(verticalDelta) > 0.015 {
            return verticalDelta > 0
        }
        return lhs.boundingBox.minX < rhs.boundingBox.minX
    }

    var allRecognizedLineCount = 0
    var lines: [OCRLine] = []
    lines.reserveCapacity(min(orderedObservations.count, ocrLineLimit))

    for observation in orderedObservations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { continue }
        allRecognizedLineCount += 1
        guard lines.count < ocrLineLimit else { continue }

        let box = observation.boundingBox
        lines.append(
            OCRLine(
                text: text,
                confidence: rounded(candidate.confidence),
                boundingBox: BoundingBox(
                    x: rounded(box.origin.x),
                    y: rounded(box.origin.y),
                    width: rounded(box.size.width),
                    height: rounded(box.size.height)
                )
            )
        )
    }

    let labels = (classifyRequest.results ?? [])
        .prefix(classificationLimit)
        .map { observation in
            Classification(
                label: observation.identifier,
                confidence: rounded(observation.confidence)
            )
        }

    let payload = ImageResult(
        ok: true,
        width: image.width,
        height: image.height,
        ocr: OCRResult(
            text: lines.map(\.text).joined(separator: "\n"),
            lines: lines,
            truncated: allRecognizedLineCount > ocrLineLimit
        ),
        classifications: labels
    )
    try writeJSON(payload)
}

do {
    try run()
} catch CLIError.usage {
    terminate(code: "usage", message: "Usage: kaii-vision /absolute/path/to/image")
} catch CLIError.pathMustBeAbsolute {
    terminate(code: "path_not_absolute", message: "The image path must be absolute.")
} catch CLIError.notAFile {
    terminate(code: "not_a_file", message: "The image path does not identify a file.")
} catch CLIError.unreadableImage {
    terminate(code: "unreadable_image", message: "The file could not be decoded as an image.")
} catch {
    terminate(code: "vision_failed", message: String(describing: error))
}
