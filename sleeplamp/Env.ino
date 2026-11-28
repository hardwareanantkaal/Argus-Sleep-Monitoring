// Argus Sleep Monitoring · Env.ino — no environment sensor in this build (C1001 radar
// only). Kept as an empty task stub: argus.ino's envTask() spawn line
// stays commented out, and nothing in types.h/Api.ino references temp/
// humidity fields anymore. This file exists only so the entry point in
// types.h has a definition if the task is ever re-enabled.
#include "types.h"
#include "config.h"

void envTask(void*) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}
