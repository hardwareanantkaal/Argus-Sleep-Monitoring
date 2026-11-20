// The two Argus products (migrations 013/014). One place for names, hardware models and chips,
// so the station, registration, firmware and device pages agree.
import type { Product } from './types';

export const PRODUCTS: [Product, string][] = [['sleep', 'Sleep monitor'], ['fall', 'Fall detector']];
export const productLabel = (p: Product | undefined | null) => (p === 'fall' ? 'Fall detector' : 'Sleep monitor');
/** Hardware models per product: ARG-S* = sleep monitor (C1001), ARG-F* = fall detector (IWR6843AOP). */
export const HW_BY_PRODUCT: Record<Product, string[]> = { sleep: ['ARG-S1 rev B', 'ARG-S1 rev A'], fall: ['ARG-F1 rev A'] };
/** Chips each product is built on. The fall detector needs the ESP32-S3 (PSRAM, two UARTs for the radar). */
export const CHIPS_BY_PRODUCT: Record<Product, string[]> = {
  sleep: ['ESP32-S3', 'ESP32', 'ESP32-C3', 'ESP32-C6', 'ESP8266'],
  fall: ['ESP32-S3'],
};
export const productOfHw = (hw: string): Product => (hw.startsWith('ARG-F') ? 'fall' : 'sleep');
