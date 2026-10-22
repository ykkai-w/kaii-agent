import AVFoundation
import Darwin
import Foundation
import Speech

// 本机听写助手。按住说话，边说边出字。
//
// 硬性要求：默认**只用设备上的识别模型**（requiresOnDeviceRecognition = true），
// 音频不出这台电脑。系统没装对应语言的本机模型时，如实报错说清楚，
// 而不是悄悄退回苹果的服务器识别——那样等于把用户说的话发出去了。
// 想走服务器要显式加 --allow-cloud，并且上层必须告诉用户。
//
// 输出协议：每行一个 JSON，便于 Electron 那边按行读、边读边显示。
//   {"type":"ready","on_device":true,"locale":"zh-CN"}
//   {"type":"partial","text":"今天天气"}
//   {"type":"final","text":"今天天气怎么样"}
//   {"type":"error","code":"no_permission","message":"…"}
//
// 停止方式（任一）：stdin 关闭或收到一行 stop、SIGINT/SIGTERM、
// 说完静了一段时间、到达 --max-seconds 上限。

private let defaultLocale = "zh-CN"
private let defaultMaxSeconds = 120.0
private let silenceStopSeconds = 2.5      // 说过话之后静这么久就收尾
private let silenceRmsThreshold: Float = 0.012

private func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]),
          let line = String(data: data, encoding: .utf8) else { return }
    // 一行一条并立即冲刷：上层是流式读的，攒着不发就没有"边说边出字"了。
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

private func fail(_ code: String, _ message: String) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(2)
}

// ── 参数 ──────────────────────────────────────────────────
private var localeIdentifier = defaultLocale
private var maxSeconds = defaultMaxSeconds
private var allowCloud = false

private var arguments = Array(CommandLine.arguments.dropFirst())
while let flag = arguments.first {
    arguments.removeFirst()
    switch flag {
    case "--locale":
        guard let value = arguments.first else { fail("bad_arguments", "--locale 后面要跟语言代码") }
        localeIdentifier = value
        arguments.removeFirst()
    case "--max-seconds":
        guard let value = arguments.first, let parsed = Double(value), parsed > 0, parsed <= 600 else {
            fail("bad_arguments", "--max-seconds 要是 1 到 600 之间的数字")
        }
        maxSeconds = parsed
        arguments.removeFirst()
    case "--allow-cloud":
        allowCloud = true
    default:
        fail("bad_arguments", "认不出这个参数：\(flag)")
    }
}

// ── 识别器 ────────────────────────────────────────────────
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
    fail("locale_unsupported", "系统不支持这个语言的语音识别：\(localeIdentifier)")
}
guard recognizer.isAvailable else {
    fail("recognizer_unavailable", "语音识别现在用不了。可能是系统还在准备，稍等一下再试。")
}

let onDevice = recognizer.supportsOnDeviceRecognition
if !onDevice && !allowCloud {
    fail(
        "no_on_device_model",
        "这台电脑上没有装 \(localeIdentifier) 的本机语音模型，"
            + "现在识别只能把声音发给苹果的服务器。"
            + "要用的话去「系统设置 → 键盘 → 听写」里把这个语言下载下来。"
    )
}

// ── 授权 ──────────────────────────────────────────────────
// 两道门：语音识别授权 + 麦克风授权。缺哪一道都要说清楚是哪一道。
private let authorizationGate = DispatchSemaphore(value: 0)
private var speechAuthorized = false
SFSpeechRecognizer.requestAuthorization { status in
    speechAuthorized = status == .authorized
    authorizationGate.signal()
}
if authorizationGate.wait(timeout: .now() + 30) == .timedOut {
    fail("permission_timeout", "等语音识别授权等太久了。再试一次，或者去「系统设置 → 隐私与安全性 → 语音识别」里看看。")
}
if !speechAuthorized {
    fail("no_speech_permission", "还没允许使用语音识别。去「系统设置 → 隐私与安全性 → 语音识别」里把 kaii 打开。")
}

private let microphoneGate = DispatchSemaphore(value: 0)
private var microphoneAuthorized = false
switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    microphoneAuthorized = true
    microphoneGate.signal()
case .notDetermined:
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        microphoneAuthorized = granted
        microphoneGate.signal()
    }
default:
    microphoneGate.signal()
}
if microphoneGate.wait(timeout: .now() + 30) == .timedOut {
    fail("permission_timeout", "等麦克风授权等太久了。再试一次。")
}
if !microphoneAuthorized {
    fail("no_microphone_permission", "还没允许使用麦克风。去「系统设置 → 隐私与安全性 → 麦克风」里把 kaii 打开。")
}

// ── 录音与识别 ────────────────────────────────────────────
private let engine = AVAudioEngine()
private let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.requiresOnDeviceRecognition = !allowCloud || onDevice

private let stateQueue = DispatchQueue(label: "io.github.ykkaiw.kaii.speech.state")
private var latestText = ""
private var heardAnything = false
private var lastLoudAt = Date()
private var finished = false

private func finish(_ reason: String) {
    // 可能被多个路径同时触发（静音、超时、信号、stdin 关闭），只放行第一个。
    var alreadyDone = false
    stateQueue.sync {
        alreadyDone = finished
        finished = true
    }
    if alreadyDone { return }

    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    request.endAudio()

    // 给识别器一点时间把最后一句吐完整，但不无限等。
    let deadline = Date().addingTimeInterval(1.5)
    while Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }

    var text = ""
    stateQueue.sync { text = latestText }
    emit(["type": "final", "text": text, "reason": reason])
    exit(text.isEmpty ? 3 : 0)
}

private var task: SFSpeechRecognitionTask?
task = recognizer.recognitionTask(with: request) { result, error in
    if let result {
        let text = result.bestTranscription.formattedString
        stateQueue.sync {
            latestText = text
            if !text.isEmpty { heardAnything = true }
        }
        emit(["type": "partial", "text": text])
        if result.isFinal { finish("recognizer_final") }
        return
    }
    if let error {
        var alreadyDone = false
        stateQueue.sync { alreadyDone = finished }
        if alreadyDone { return }
        // 一个字都没听到就报错，多半是没说话或者没选对输入设备，说人话提示。
        var text = ""
        stateQueue.sync { text = latestText }
        if text.isEmpty {
            emit([
                "type": "error",
                "code": "no_speech",
                "message": "没听到说话。看看菜单栏里的输入设备选对了没有。",
                "detail": error.localizedDescription,
            ])
            exit(4)
        }
        finish("recognizer_error")
    }
}

private let inputNode = engine.inputNode
private let format = inputNode.outputFormat(forBus: 0)
guard format.channelCount > 0, format.sampleRate > 0 else {
    fail("no_input_device", "找不到可用的麦克风。看看系统设置里的输入设备。")
}

inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)

    // 自己算音量做静音判断。不这么做的话，用户说完就得手动点停止，
    // 每次听写都多一步，日常用起来很烦。
    guard let channel = buffer.floatChannelData?[0] else { return }
    let count = Int(buffer.frameLength)
    guard count > 0 else { return }
    var sum: Float = 0
    for index in 0..<count {
        let sample = channel[index]
        sum += sample * sample
    }
    let rms = (sum / Float(count)).squareRoot()
    if rms > silenceRmsThreshold {
        stateQueue.sync { lastLoudAt = Date() }
    }
}

engine.prepare()
do {
    try engine.start()
} catch {
    fail("audio_start_failed", "打不开麦克风：\(error.localizedDescription)")
}

emit(["type": "ready", "on_device": request.requiresOnDeviceRecognition, "locale": localeIdentifier])

// ── 几种收尾方式 ──────────────────────────────────────────
private let signalSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
signalSource.setEventHandler { finish("signal") }
signalSource.resume()
signal(SIGINT, SIG_IGN)

private let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
termSource.setEventHandler { finish("signal") }
termSource.resume()
signal(SIGTERM, SIG_IGN)

// 上层想停就关掉 stdin（或者写一行 stop）。父进程意外退出时 stdin 也会关，
// 这样助手不会变成孤儿进程一直占着麦克风。
DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
        if line.trimmingCharacters(in: .whitespaces).lowercased() == "stop" { break }
    }
    finish("stdin_closed")
}

private let startedAt = Date()
private let ticker = Timer(timeInterval: 0.25, repeats: true) { _ in
    if Date().timeIntervalSince(startedAt) >= maxSeconds { finish("max_seconds") }
    var spoke = false
    var quietFor = 0.0
    stateQueue.sync {
        spoke = heardAnything
        quietFor = Date().timeIntervalSince(lastLoudAt)
    }
    if spoke && quietFor >= silenceStopSeconds { finish("silence") }
}
RunLoop.main.add(ticker, forMode: .default)
RunLoop.main.run()
