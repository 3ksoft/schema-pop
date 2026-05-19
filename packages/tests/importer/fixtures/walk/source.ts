interface Telemetry {
	uptime_ms: number;
	status: string;
	tags: number[];
}

interface I {
	x: number;
	note?: string;
}

type Mode = "Idle" | "Active" | "Error" | "Offline";

enum Severity {
	Info,
	Warn,
	Error,
}

type Reading = { sensor_id: number; value: number };

/** Telemetry packet. */
interface TelemetryDoc {
	/** Monotonic clock. */
	uptime_ms: number;
	status: string;
}

type Either = Foo | Bar;

interface ArrayTest {
	xs: Array<number>;
}

export interface Exported {
	x: number;
}
