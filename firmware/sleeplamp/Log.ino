// Argus Sleep Monitoring · Log.ino — LOG prints to Serial AND keeps the last
// LOG_RING_BYTES in RAM, so the server's `logs` command can upload them.
#include "types.h"

static char     ring[LOG_RING_BYTES];
static size_t   ringHead = 0;      // next write position
static bool     ringFull = false;
static portMUX_TYPE ringLock = portMUX_INITIALIZER_UNLOCKED;   // both cores print

size_t TeeLog::write(uint8_t c) { return write(&c, 1); }

size_t TeeLog::write(const uint8_t* b, size_t n) {
  Serial.write(b, n);
  portENTER_CRITICAL(&ringLock);
  for (size_t i = 0; i < n; i++) {
    ring[ringHead++] = (char)b[i];
    if (ringHead >= LOG_RING_BYTES) { ringHead = 0; ringFull = true; }
  }
  portEXIT_CRITICAL(&ringLock);
  return n;
}

// oldest -> newest copy of the ring
String TeeLog::snapshot() {
  static char copy[LOG_RING_BYTES];
  size_t len;
  portENTER_CRITICAL(&ringLock);
  if (ringFull) {
    size_t tail = LOG_RING_BYTES - ringHead;
    memcpy(copy, ring + ringHead, tail);
    memcpy(copy + tail, ring, ringHead);
    len = LOG_RING_BYTES;
  } else {
    memcpy(copy, ring, ringHead);
    len = ringHead;
  }
  portEXIT_CRITICAL(&ringLock);
  String out; out.reserve(len + 1);
  for (size_t i = 0; i < len; i++) out += copy[i];
  return out;
}
