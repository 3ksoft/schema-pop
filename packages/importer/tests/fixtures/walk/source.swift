struct Telemetry {
    var uptimeMs: Int
    let status: String
}

class Config {
    var items: [Int]
    var note: String?
    var fallback: Optional<Bool>
}

enum Status { case Idle; case Active }

typealias DeviceId = UInt32