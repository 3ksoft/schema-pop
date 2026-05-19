<?php
class Telemetry {
    public int $uptime_ms;
    public string $status;
}

class I {
    public ?string $note;
}

enum Severity { case Info; case Warn; case Error; }