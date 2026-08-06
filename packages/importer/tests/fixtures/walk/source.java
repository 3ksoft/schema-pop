public class Telemetry {
    public int uptime_ms;
    public String status;
}

public record TelemetryRecord(int uptime_ms, String status) {}

public enum Severity { Info, Warn, Error }

class I { public List<String> xs; }