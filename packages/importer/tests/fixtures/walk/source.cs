public class Telemetry {
    public int Uptime { get; set; }
    public string Status;
    private int hidden;
}

public record TelemetryRecord(int Uptime, string Status);

public enum Status { Idle, Active }

public class Data {
    public int[] Numbers { get; set; }
    public List<string> Labels;
}