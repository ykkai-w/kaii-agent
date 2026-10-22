import Darwin
import Foundation
import PDFKit

// 本机 PDF 取字助手。只做一件事：把 PDF 的文本层抽出来，按页输出。
// 不联网、不写文件、不改动原件；扫描件没有文本层时如实说明，由上层决定是否走 OCR。

private let maxCharacters = 400_000
private let maxPages = 2000

private struct PageText: Codable {
    let page: Int
    let text: String
}

private struct DocumentResult: Codable {
    let ok: Bool
    let kind: String
    let pageCount: Int
    let characters: Int
    let truncated: Bool
    let hasTextLayer: Bool
    let title: String?
    let pages: [PageText]

    enum CodingKeys: String, CodingKey {
        case ok
        case kind
        case pageCount = "page_count"
        case characters
        case truncated
        case hasTextLayer = "has_text_layer"
        case title
        case pages
    }
}

private struct ErrorBody: Codable {
    let code: String
    let message: String
}

private struct ErrorResult: Codable {
    let ok: Bool
    let error: ErrorBody
}

private enum CLIError: Error {
    case usage
    case pathMustBeAbsolute
    case notAFile
    case unreadableDocument
    case encrypted
}

private func writeJSON<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = try encoder.encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func terminate(code: String, message: String) -> Never {
    let payload = ErrorResult(ok: false, error: ErrorBody(code: code, message: message))
    if let data = try? JSONEncoder().encode(payload) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
    exit(1)
}

private func normalize(_ raw: String) -> String {
    // PDF 抽出来的文本经常带一堆连续空行和行尾空格，先压平再交给模型，省上下文。
    let unified = raw.replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
        .replacingOccurrences(of: "\u{00a0}", with: " ")
    let lines = unified.split(separator: "\n", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespaces) }
    var output: [String] = []
    var blankRun = 0
    for line in lines {
        if line.isEmpty {
            blankRun += 1
            if blankRun > 1 { continue }
        } else {
            blankRun = 0
        }
        output.append(line)
    }
    return output.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

private func run() throws {
    let arguments = CommandLine.arguments
    guard arguments.count == 2 else { throw CLIError.usage }
    let rawPath = arguments[1]
    guard rawPath.hasPrefix("/") else { throw CLIError.pathMustBeAbsolute }

    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: rawPath, isDirectory: &isDirectory), !isDirectory.boolValue else {
        throw CLIError.notAFile
    }

    let url = URL(fileURLWithPath: rawPath)
    guard let document = PDFDocument(url: url) else { throw CLIError.unreadableDocument }
    if document.isEncrypted && !document.unlock(withPassword: "") { throw CLIError.encrypted }

    let pageCount = document.pageCount
    var pages: [PageText] = []
    var characters = 0
    var truncated = false

    for index in 0..<min(pageCount, maxPages) {
        guard let page = document.page(at: index) else { continue }
        let text = normalize(page.string ?? "")
        if text.isEmpty { continue }
        if characters + text.count > maxCharacters {
            let room = max(0, maxCharacters - characters)
            if room > 0 {
                pages.append(PageText(page: index + 1, text: String(text.prefix(room))))
                characters += room
            }
            truncated = true
            break
        }
        pages.append(PageText(page: index + 1, text: text))
        characters += text.count
    }
    if pageCount > maxPages { truncated = true }

    let title = document.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String

    try writeJSON(DocumentResult(
        ok: true,
        kind: "pdf",
        pageCount: pageCount,
        characters: characters,
        truncated: truncated,
        hasTextLayer: characters > 0,
        title: title?.isEmpty == false ? title : nil,
        pages: pages
    ))
}

do {
    try run()
} catch CLIError.usage {
    terminate(code: "usage", message: "Usage: kaii-doc /absolute/path/to/file.pdf")
} catch CLIError.pathMustBeAbsolute {
    terminate(code: "path_not_absolute", message: "The document path must be absolute.")
} catch CLIError.notAFile {
    terminate(code: "not_a_file", message: "The document path does not identify a file.")
} catch CLIError.unreadableDocument {
    terminate(code: "unreadable_document", message: "The file could not be opened as a PDF.")
} catch CLIError.encrypted {
    terminate(code: "encrypted", message: "The PDF is password protected.")
} catch {
    terminate(code: "extract_failed", message: String(describing: error))
}
