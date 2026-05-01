#![no_std]
#![no_main]
#![feature(type_alias_impl_trait)]

use embassy_executor::Spawner;
use embassy_net::{Config, Stack, StackResources};
use embassy_time::{Duration, Instant, Timer};
use esp_backtrace as _;
use esp_hal::{
    clock::ClockControl, gpio::{Input, PullUp}, peripherals::Peripherals, prelude::*, rtc_cntl::Rtc,
};
use esp_wifi::{initialize, EspWifiInitFor};
use static_cell::make_static;

mod schema;
use schema::v1_0::{BatteryInfo, GpioState, SystemStatus, WsMessage};

// GPIO piny do monitorowania
const GPIO_PINS: &[usize] = &[0, 1, 2, 3, 4, 5, 6, 7];

#[main]
async fn main(spawner: Spawner) {
    let peripherals = Peripherals::take();
    let system = peripherals.SYSTEM.split();
    let clocks = ClockControl::max(system.clock_control).freeze();

    // LED status (wbudowany WS2812 na GPIO8)
    // TODO: init WS2812, kolor = niebieski = boot, zielony = connected

    // Init inputs
    let io = peripherals.IO.split();
    let mut inputs: [Input<'_>; 8] = [
        Input::new(io.pins.gpio0, PullUp),
        Input::new(io.pins.gpio1, PullUp),
        Input::new(io.pins.gpio2, PullUp),
        Input::new(io.pins.gpio3, PullUp),
        Input::new(io.pins.gpio4, PullUp),
        Input::new(io.pins.gpio5, PullUp),
        Input::new(io.pins.gpio6, PullUp),
        Input::new(io.pins.gpio7, PullUp),
    ];

    // WiFi init (jak wcześniej)
    let timer = esp_hal::timer::TimerGroup::new(peripherals.TIMG0, &clocks).timer0;
    let init = initialize(
        EspWifiInitFor::Wifi,
        timer,
        esp_hal::rng::Rng::new(peripherals.RNG),
        system.radio_clock_control,
        &clocks,
    ).unwrap();

    let wifi = peripherals.WIFI;
    let (wifi_interface, controller) = 
        esp_wifi::wifi::new_with_mode(&init, wifi, esp_wifi::wifi::WifiStaDevice).unwrap();

    let config = Config::dhcpv4(Default::default());
    let stack = &*make_static!(Stack::new(
        wifi_interface,
        config,
        make_static!(StackResources::<3>::new()),
        1234u64,
    ));

    spawner.spawn(net_task(stack)).unwrap();
    spawner.spawn(connection_task(controller)).unwrap();
    spawner.spawn(gpio_task(stack, inputs)).unwrap();
    spawner.spawn(battery_task(stack)).unwrap();
}

#[embassy_executor::task]
async fn gpio_task(
    stack: &'static Stack<WifiDevice<'static>>,
    mut inputs: [Input<'_>; 8],
) {
    let mut last_state: u8 = 0;
    
    loop {
        // Odczytaj stan wszystkich pinów
        let mut current: u8 = 0;
        for (i, pin) in inputs.iter().enumerate() {
            if pin.is_high() {
                current |= 1 << i;
            }
        }
        
        let changed = current ^ last_state;
        
        if changed != 0 {
            let msg = WsMessage::GpioState(GpioState {
                pins: current,
                changed_mask: changed,
                timestamp_ms: Instant::now().as_millis() as u32,
            });
            send_message(stack, &msg).await;
            last_state = current;
        }
        
        Timer::after(Duration::from_millis(10)).await; // debounce + poll rate
    }
}

#[embassy_executor::task]
async fn battery_task(stack: &'static Stack<WifiDevice<'static>>) {
    let mut adc = esp_hal::adc::Adc::new(peripherals.ADC, &clocks);
    let mut pin = esp_hal::adc::Atten::Atten11dB; // pełny zakres 0-3.3V
    
    loop {
        // Odczyt ADC (symulacja baterii)
        let raw: u16 = adc.read(&mut pin).unwrap_or(0);
        let voltage = (raw as u32 * 3300 / 4095) as u16; // mV
        
        let msg = WsMessage::BatteryInfo(BatteryInfo {
            voltage,
            level_percent: ((voltage.saturating_sub(3000)) / 12).min(100) as u8, // crude Li-ion %
        });
        send_message(stack, &msg).await;
        
        Timer::after(Duration::from_secs(5)).await;
    }
}

async fn send_message(stack: &Stack<WifiDevice<'_>>, msg: &WsMessage) {
    // TODO: TCP socket pool lub queue
    // Na razie: otwórz socket, wyślij, zamknij (brutalne ale działa)
}