class Telemetry:
    uptime_ms: int
    status: str

class TelemetryAssign:
    uptime_ms: int = 0
    status: str = "ok"

class Data:
    tags: list[int]
    note: Optional[str]
    other: int | None

class Status(Enum):
    Idle = 1
    Active = 2

class Device:
    """Represents a connected device."""
    id: int
    """Unique ID."""