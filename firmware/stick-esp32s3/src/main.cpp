/**
 * fpvsim stick: a USB joystick whose sticks are set over USB serial.
 *
 * The simulator sees an ordinary four-axis joystick, so nothing on its side
 * knows a program is flying. Axes are 16-bit — the stock Arduino gamepad is
 * 8-bit, a 0.8% step, which is coarser than any radio and would put a
 * staircase into every slow stick movement.
 *
 * Frame from the host, 12 bytes:
 *   0xA5 0x5A, int16 LE x4 (roll, pitch, throttle, yaw; -32767..32767),
 *   uint8 buttons, uint8 XOR of the 9 bytes before it (axes and buttons).
 * Axis order is AETR, as EdgeTX emits, so the sim's channel setup looks like
 * a radio's.
 *
 * Failsafe: no valid frame for 250 ms puts the throttle at the bottom and the
 * other sticks in the middle. A host that crashes mid-flight must not leave
 * the quad at full throttle.
 *
 * The host can also send "?\n" and gets back a line saying what this is, so
 * it can find the right serial port rather than guess.
 *
 * It is also an absolute-position mouse (Gilboa's call, 2026-11-08), so the
 * host can click the simulator's menus. "m X Y B\n" moves to X, Y
 * (0..32767 across the main display) with buttons B (bit 0 = left). The host
 * side only clicks inside the Velocidrone window while it is frontmost.
 */

#include <Arduino.h>
#include "USB.h"
#include "USBHID.h"

static USBHID HID;

static const uint8_t REPORT_ID = 1;
static const uint8_t DESCRIPTOR[] = {
  0x05, 0x01,        // Usage Page (Generic Desktop)
  0x09, 0x04,        // Usage (Joystick)
  0xA1, 0x01,        // Collection (Application)
  0x85, REPORT_ID,   //   Report ID
  0x05, 0x01,        //   Usage Page (Generic Desktop)
  0x09, 0x30,        //   Usage (X)   roll
  0x09, 0x31,        //   Usage (Y)   pitch
  0x09, 0x32,        //   Usage (Z)   throttle
  0x09, 0x33,        //   Usage (Rx)  yaw
  0x16, 0x01, 0x80,  //   Logical Minimum (-32767)
  0x26, 0xFF, 0x7F,  //   Logical Maximum (32767)
  0x75, 0x10,        //   Report Size (16)
  0x95, 0x04,        //   Report Count (4)
  0x81, 0x02,        //   Input (Data, Var, Abs)
  0x05, 0x09,        //   Usage Page (Button)
  0x19, 0x01,        //   Usage Minimum (1)
  0x29, 0x08,        //   Usage Maximum (8)
  0x15, 0x00,        //   Logical Minimum (0)
  0x25, 0x01,        //   Logical Maximum (1)
  0x75, 0x01,        //   Report Size (1)
  0x95, 0x08,        //   Report Count (8)
  0x81, 0x02,        //   Input (Data, Var, Abs)
  0xC0               // End Collection
};

struct __attribute__((packed)) Report {
  int16_t axis[4];
  uint8_t buttons;
};

static const uint8_t MOUSE_ID = 2;
static const uint8_t MOUSE_DESCRIPTOR[] = {
  0x05, 0x01, 0x09, 0x02, 0xA1, 0x01,  // Generic Desktop, Mouse, Application
  0x85, MOUSE_ID,
  0x09, 0x01, 0xA1, 0x00,              // Pointer, Physical
  0x05, 0x09, 0x19, 0x01, 0x29, 0x03,  // Buttons 1-3
  0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81, 0x02,
  0x95, 0x01, 0x75, 0x05, 0x81, 0x03,  // padding
  0x05, 0x01, 0x09, 0x30, 0x09, 0x31,  // X, Y
  0x16, 0x00, 0x00, 0x26, 0xFF, 0x7F,  // 0..32767
  0x75, 0x10, 0x95, 0x02, 0x81, 0x02,  // absolute
  0xC0, 0xC0
};

struct __attribute__((packed)) MouseReport {
  uint8_t buttons;
  uint16_t x;
  uint16_t y;
};

class Mouse : public USBHIDDevice {
public:
  Mouse() {
    static bool added = false;
    if (!added) {
      added = true;
      HID.addDevice(this, sizeof(MOUSE_DESCRIPTOR));
    }
  }
  uint16_t _onGetDescriptor(uint8_t *buffer) override {
    memcpy(buffer, MOUSE_DESCRIPTOR, sizeof(MOUSE_DESCRIPTOR));
    return sizeof(MOUSE_DESCRIPTOR);
  }
  bool send(const MouseReport &r) {
    return HID.SendReport(MOUSE_ID, &r, sizeof(r), 20);
  }
};

class Stick : public USBHIDDevice {
public:
  Stick() {
    static bool added = false;
    if (!added) {
      added = true;
      HID.addDevice(this, sizeof(DESCRIPTOR));
    }
  }
  uint16_t _onGetDescriptor(uint8_t *buffer) override {
    memcpy(buffer, DESCRIPTOR, sizeof(DESCRIPTOR));
    return sizeof(DESCRIPTOR);
  }
  bool send(const Report &r) {
    return HID.SendReport(REPORT_ID, &r, sizeof(r), 2);
  }
};

// One mode at a time. The prebuilt TinyUSB has a single HID interface
// (CFG_TUD_HID = 1), and a HID interface has one primary usage: joystick
// first and macOS ignored the mouse, mouse first and Velocidrone (Unity
// picks joysticks by primary usage) lost the controller. So the board is a
// joystick, or — for a few menu clicks — a mouse, and "M1"/"M0" restarts it
// into the other. The mode survives the restart in RTC memory.
static const uint32_t MODE_MAGIC = 0x5eed0000;
RTC_NOINIT_ATTR static uint32_t modeWord;
static bool mouseMode() { return modeWord == (MODE_MAGIC | 1); }
static Stick *stick = nullptr;
static Mouse *mouse = nullptr;

// Registration has to happen during static initialisation, before main():
// with CDC on boot the core starts USB before setup() runs, and a device
// added in setup() leaves an empty report descriptor — no joystick, no
// mouse, "Controller not found". Learned by doing it in setup() first.
struct Registrar {
  Registrar() {
    if ((modeWord & 0xffff0000) != MODE_MAGIC) modeWord = MODE_MAGIC;  // power-on: joystick
    if (mouseMode()) mouse = new Mouse();
    else stick = new Stick();
  }
};
static Registrar registrar;
static Report current;
static uint32_t lastFrame = 0;
static uint32_t lastSend = 0;
static uint32_t frames = 0;
static uint32_t bad = 0;

static void failsafe() {
  current.axis[0] = 0;
  current.axis[1] = 0;
  current.axis[2] = -32767;
  current.axis[3] = 0;
  current.buttons = 0;
}

void setup() {
  failsafe();
  USB.productName("fpvsim stick");
  USB.manufacturerName("fpvsim");
  HID.begin();
  Serial.begin(115200);
  USB.begin();
}

static uint8_t buf[12];
static uint8_t have = 0;
static char line[32];
static uint8_t lineLen = 0;

void loop() {
  bool changed = false;
  while (Serial.available()) {
    uint8_t b = Serial.read();
    if (have == 0) {
      if (b == 0xA5) {
        buf[have++] = b;
        continue;
      }
      // Text commands, only between frames.
      if (b == '\n') {
        line[lineLen] = 0;
        if (strcmp(line, "?") == 0) {
          Serial.printf("fpvsim-stick 3 mode=%s frames=%lu bad=%lu\n", mouseMode() ? "mouse" : "joystick",
                        (unsigned long)frames, (unsigned long)bad);
        } else if (line[0] == 'M' && (line[1] == '0' || line[1] == '1')) {
          bool want = line[1] == '1';
          if (want != mouseMode()) {
            modeWord = MODE_MAGIC | (want ? 1 : 0);
            Serial.printf("ok restarting as %s\n", want ? "mouse" : "joystick");
            Serial.flush();
            delay(50);
            ESP.restart();
          }
          Serial.printf("ok already %s\n", want ? "mouse" : "joystick");
        } else if (line[0] == 'm' && mouse) {
          unsigned x = 0, y = 0, b = 0;
          if (sscanf(line + 1, "%u %u %u", &x, &y, &b) == 3) {
            MouseReport r = {(uint8_t)(b & 7), (uint16_t)(x > 32767 ? 32767 : x), (uint16_t)(y > 32767 ? 32767 : y)};
            mouse->send(r);
            Serial.printf("ok m %u %u %u\n", x, y, b);
          }
        }
        lineLen = 0;
      } else if (lineLen < sizeof(line) - 1) {
        line[lineLen++] = (char)b;
      }
      continue;
    }
    if (have == 1 && b != 0x5A) {
      have = (b == 0xA5) ? 1 : 0;
      continue;
    }
    buf[have++] = b;
    if (have < sizeof(buf)) continue;
    have = 0;
    uint8_t x = 0;
    for (int i = 2; i < 11; i++) x ^= buf[i];
    if (x != buf[11]) {
      bad++;
      continue;
    }
    for (int i = 0; i < 4; i++) current.axis[i] = (int16_t)(buf[2 + 2 * i] | (buf[3 + 2 * i] << 8));
    current.buttons = buf[10];
    lastFrame = millis();
    frames++;
    changed = true;
  }
  uint32_t now = millis();
  if (lastFrame != 0 && now - lastFrame > 250) {
    failsafe();
    lastFrame = 0;
    changed = true;
  }
  // Send on every new frame, and at least every 10 ms so the host OS never
  // sees a stale device.
  if (changed || now - lastSend >= 10) {
    if (stick && stick->send(current)) lastSend = now;
    else if (!stick) lastSend = now;
  }
}
