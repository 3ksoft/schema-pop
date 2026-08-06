@interface Telemetry : NSObject
@property (nonatomic, assign) NSInteger uptime_ms;
@property (nonatomic, strong) NSString *status;
@property (assign) BOOL isActive;
@end

struct RawFrame {
    int length;
    float scale;
};

enum Status {
    StatusIdle,
    StatusActive
};

/// Device model
@interface Device : NSObject
/** Unique identifier */
@property (nonatomic) NSInteger deviceId;
@end