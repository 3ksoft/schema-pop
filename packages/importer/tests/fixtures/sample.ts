// Plain TS interface fixture for the typescript walker.

/** Lifecycle of a managed device. */
export type DeviceStatus = "Idle" | "Active" | "Error" | "Offline";

/** Severity of a log entry. */
export enum Severity {
	Info,
	Warn,
	Error,
}

/** Telemetry packet pushed every second. */
export interface Telemetry {
	/** Monotonic clock value (ms since boot). */
	uptime_ms: number;
	/** Device status snapshot. */
	status: DeviceStatus;
	/** Optional human-readable note. */
	note?: string;
	/** Tag bytes. */
	tags: number[];
}

/** Reading from a single sensor. */
export interface Reading {
	sensor_id: number;
	value: number;
	severity: Severity;
}

export type AnyEntry = Telemetry | Reading;
