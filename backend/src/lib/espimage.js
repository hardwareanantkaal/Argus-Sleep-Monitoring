// Checks on uploaded ESP firmware images (API.md 9.2 and 9.22).
// Every ESP image (bootloader or app) starts with the magic byte 0xE9.
const MAGIC = 0xe9;

// Where the 2nd-stage bootloader sits in a full-flash image.
const BOOTLOADER_OFFSET = { ESP32: 0x1000, 'ESP32-S2': 0x1000, 'ESP32-S3': 0x0, 'ESP32-C3': 0x0, 'ESP32-C6': 0x0 };
const APP_OFFSET = 0x10000; // app0 in all our partition tables (partitions.csv)
const FLASH_SIZES = { '2MB': 2 << 20, '4MB': 4 << 20, '8MB': 8 << 20, '16MB': 16 << 20 };

const isEspImage = (buf) => buf.length > 0x20 && buf[0] === MAGIC;

// Returns null when fine, or an error code + message.
function checkFactoryImage(chip, merged, otaBin, flashSize) {
  if (chip === 'ESP8266') return { code: 'NOT_NEEDED', message: 'ESP8266 needs no factory image: its .bin is written at 0x0 as is' };
  const off = BOOTLOADER_OFFSET[chip];
  if (off === undefined) return { code: 'NOT_FACTORY_IMAGE', message: `Unknown chip ${chip}` };
  if (merged.length > FLASH_SIZES[flashSize]) return { code: 'NOT_FACTORY_IMAGE', message: `Image is bigger than ${flashSize}` };
  if (merged.length <= off || merged[off] !== MAGIC) {
    return { code: 'NOT_FACTORY_IMAGE', message: `No bootloader at 0x${off.toString(16)}. Upload the *.ino.merged.bin built for ${chip}` };
  }
  const app = merged.subarray(APP_OFFSET, APP_OFFSET + otaBin.length);
  if (app.length !== otaBin.length || !app.equals(otaBin)) {
    return { code: 'IMAGE_MISMATCH', message: 'The app inside this image is not the same build as the OTA .bin of this version' };
  }
  return null;
}

// Guess the flash size from a merged image padded to the whole flash (Arduino does this).
function guessFlashSize(len) {
  return Object.keys(FLASH_SIZES).find((k) => FLASH_SIZES[k] === len) || '4MB';
}

module.exports = { isEspImage, checkFactoryImage, guessFlashSize, FLASH_SIZES };
