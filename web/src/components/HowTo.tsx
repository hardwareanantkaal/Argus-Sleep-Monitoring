'use client';

// "How to" info button (18 Nov feedback): an (i) icon that opens the steps a
// user must follow to finish Wi-Fi setup, recalibration or the placement check.

import { useState } from 'react';
import { Icon } from './Icon';

export function HowTo({ label, steps, done }: { label: string; steps: React.ReactNode[]; done?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="howto">
      <button type="button" className="howto-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="info" size={16} /> {label}
      </button>
      {open && (
        <div className="howto-box" role="note">
          <ol>{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          {done && <p className="howto-done"><Icon name="check" size={14} /> {done}</p>}
        </div>
      )}
    </div>
  );
}

// Shared texts, so the device page and settings say exactly the same thing.
export const WIFI_STEPS = [
  <>Press <b>Start config</b> (or <b>Change Wi-Fi network</b>). The sensor opens its own Wi-Fi called <b>Argus-Setup</b>.</>,
  <>On your phone, open Wi-Fi settings and join <b>Argus-Setup</b> (password <b>12345678</b>).</>,
  <>The setup page opens by itself. If it doesn&apos;t, open a browser and go to <b>192.168.4.1/wifi</b>.</>,
  <>Pick your home Wi-Fi (2.4 GHz) from the list, type its password and press <b>Save &amp; Reboot</b>.</>,
  <>The sensor restarts and joins your Wi-Fi. Reconnect your phone to your home Wi-Fi.</>,
  <>Sensor offline and no app access? Unplug and plug it in <b>5 times quickly</b> (within 10 s each) to open Argus-Setup.</>,
];
export const WIFI_DONE = 'Done when the device shows Online again (about 1 minute).';

export const RECAL_STEPS = [
  <>Make sure <b>nobody is in bed</b> and nobody stands in front of the sensor.</>,
  <>Press <b>Recalibrate sensor</b>. The radar resets for about 11 seconds (its light goes off, then on).</>,
  <>Lie down in your <b>normal sleeping position</b>, chest facing the sensor, <b>60–100 cm</b> away.</>,
  <>Stay still and breathe normally for about 1 minute while the checks turn green.</>,
];
export const RECAL_DONE = 'Done when all four checks are green (presence, still, breathing, heart rate).';

export const PLACE_STEPS = [
  <>Place the sensor beside the bed at about mattress height, <b>facing your chest</b>, <b>60–100 cm</b> away.</>,
  <>Use the supplied <b>5 V adapter</b> (not a laptop USB port), so the radar gets clean power.</>,
  <>Keep fans, curtains and other people out of the sensor&apos;s view where you can.</>,
  <>Press <b>Run check</b>, lie down and stay still. If a check stays grey, adjust the angle or distance and wait a few seconds.</>,
];
export const PLACE_DONE = 'Done when the signal score is 100 (all four checks green).';
