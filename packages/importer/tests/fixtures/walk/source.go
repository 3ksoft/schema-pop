package main

type Telemetry struct {
    Uptime int
    Status string
    hidden int
}

type DeviceId uint32

type Config struct {
    Items []int
    Matrix [16]byte
    Ref *Config
}