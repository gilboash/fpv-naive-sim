/**
 * Betaflight Blackbox binary decoder.
 *
 * Written rather than shelled out to because `blackbox_decode` is not
 * installable here and the alternative was a manual export from the Explorer
 * GUI for every log, forever. The whole project's convention is that
 * verification should not need a human in the loop, and a pipeline with a
 * mandatory GUI step in the middle does not meet it.
 *
 * The format: a plain-text header describing the fields, then a stream of
 * frames. 'I' frames carry absolute values, 'P' frames carry differences
 * against a prediction, 'S' frames carry slowly-changing state, 'E' frames are
 * events. Every field declares its own predictor and its own variable-length
 * encoding, both listed in the header, so the decoder is a loop over those two
 * tables rather than anything bespoke per field.
 *
 * Reference: betaflight/src/main/blackbox/blackbox_fielddefs.h and the
 * blackbox-tools decoder. Encodings and predictors are numbered as they are
 * there; the names below are theirs.
 */

// Predictors
const PRED_ZERO = 0;
const PRED_PREVIOUS = 1;
const PRED_STRAIGHT_LINE = 2;
const PRED_AVERAGE_2 = 3;
const PRED_MINTHROTTLE = 4;
const PRED_MOTOR_0 = 5;
const PRED_INC = 6;
const PRED_1500 = 8;
const PRED_VBATREF = 9;
const PRED_MINMOTOR = 11;

// Encodings
const ENC_SIGNED_VB = 0;
const ENC_UNSIGNED_VB = 1;
const ENC_NEG_14BIT = 3;
const ENC_TAG8_8SVB = 6;
const ENC_TAG2_3S32 = 7;
const ENC_TAG8_4S16 = 8;
const ENC_NULL = 9;

export interface BlackboxHeader {
  /** Every `H key:value` line, verbatim. */
  raw: Map<string, string>;
  fieldNames: string[];
  fieldSigned: number[];
  iPredictor: number[];
  iEncoding: number[];
  pPredictor: number[];
  pEncoding: number[];
  sNames: string[];
  sSigned: number[];
  sPredictor: number[];
  sEncoding: number[];
}

export interface DecodedLog {
  header: BlackboxHeader;
  fieldNames: string[];
  /** One array per field, all the same length. */
  columns: Float64Array[];
  frames: number;
  /** Frames the decoder had to skip to regain sync. */
  desyncs: number;
  craftName: string;
  firmware: string;
}

class Reader {
  pos: number;
  // Not a parameter property: strip-only mode cannot compile those, and this
  // directory has to run under `node --experimental-strip-types`.
  readonly buf: Uint8Array;

  constructor(buf: Uint8Array, start = 0) {
    this.buf = buf;
    this.pos = start;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw new RangeError('eof');
    return this.buf[this.pos++]!;
  }

  peek(): number {
    return this.pos < this.buf.length ? this.buf[this.pos]! : -1;
  }

  unsignedVB(): number {
    let result = 0;
    for (let shift = 0; shift < 32; shift += 7) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
    }
    return result >>> 0;
  }

  signedVB(): number {
    const u = this.unsignedVB();
    // Zigzag.
    return (u >>> 1) ^ -(u & 1);
  }
}

const signExtend = (v: number, bits: number): number => {
  const shift = 32 - bits;
  return (v << shift) >> shift;
};

function readTag2_3S32(r: Reader, out: number[]): void {
  const lead = r.byte();
  switch (lead >> 6) {
    case 0:
      out[0] = signExtend((lead >> 4) & 0x03, 2);
      out[1] = signExtend((lead >> 2) & 0x03, 2);
      out[2] = signExtend(lead & 0x03, 2);
      break;
    case 1: {
      out[0] = signExtend(lead & 0x0f, 4);
      const b = r.byte();
      out[1] = signExtend(b >> 4, 4);
      out[2] = signExtend(b & 0x0f, 4);
      break;
    }
    case 2:
      out[0] = signExtend(lead & 0x3f, 6);
      out[1] = signExtend(r.byte() & 0x3f, 6);
      out[2] = signExtend(r.byte() & 0x3f, 6);
      break;
    default: {
      // Per-field widths, two selector bits each, low field first.
      let sel = lead;
      for (let i = 0; i < 3; i++) {
        switch (sel & 0x03) {
          case 0:
            out[i] = signExtend(r.byte(), 8);
            break;
          case 1: {
            const a = r.byte();
            out[i] = signExtend(a | (r.byte() << 8), 16);
            break;
          }
          case 2: {
            const a = r.byte();
            const b = r.byte();
            out[i] = signExtend(a | (b << 8) | (r.byte() << 16), 24);
            break;
          }
          default: {
            const a = r.byte();
            const b = r.byte();
            const c = r.byte();
            out[i] = (a | (b << 8) | (c << 16) | (r.byte() << 24)) | 0;
            break;
          }
        }
        sel >>= 2;
      }
    }
  }
}

function readTag8_4S16(r: Reader, out: number[]): void {
  let selector = r.byte();
  let nibbleBuf = 0;
  let haveNibble = false;
  for (let i = 0; i < 4; i++) {
    switch (selector & 0x03) {
      case 0:
        out[i] = 0;
        break;
      case 1: // 4 bit
        if (!haveNibble) {
          nibbleBuf = r.byte();
          out[i] = signExtend(nibbleBuf >> 4, 4);
          haveNibble = true;
        } else {
          out[i] = signExtend(nibbleBuf & 0x0f, 4);
          haveNibble = false;
        }
        break;
      case 2: // 8 bit
        if (!haveNibble) {
          out[i] = signExtend(r.byte(), 8);
        } else {
          // Straddles a nibble: low half of the buffer, high half of the next
          // byte, and the next byte becomes the buffer.
          const b = r.byte();
          out[i] = signExtend((((nibbleBuf & 0x0f) << 4) | (b >> 4)) & 0xff, 8);
          nibbleBuf = b;
        }
        break;
      default: {
        // 16 bit, big-endian — unlike everything else in this format.
        if (!haveNibble) {
          const a = r.byte();
          out[i] = signExtend((a << 8) | r.byte(), 16);
        } else {
          const a = r.byte();
          const b = r.byte();
          out[i] = signExtend((((nibbleBuf & 0x0f) << 12) | (a << 4) | (b >> 4)) & 0xffff, 16);
          nibbleBuf = b;
        }
        break;
      }
    }
    selector >>= 2;
  }
}

function readTag8_8SVB(r: Reader, out: number[], count: number): void {
  if (count === 1) {
    out[0] = r.signedVB();
    return;
  }
  let header = r.byte();
  for (let i = 0; i < count; i++) {
    out[i] = header & 0x01 ? r.signedVB() : 0;
    header >>= 1;
  }
}

// ------------------------------------------------------------------- header

const HEADER_MAGIC = 'H Product:Blackbox flight data recorder';

function parseHeader(text: string): { header: BlackboxHeader; bytesConsumed: number } {
  const raw = new Map<string, string>();
  let pos = 0;
  let consumed = 0;
  while (pos < text.length) {
    if (text[pos] !== 'H') break;
    const nl = text.indexOf('\n', pos);
    if (nl < 0) break;
    const line = text.slice(pos + 2, nl);
    const colon = line.indexOf(':');
    if (colon > 0) raw.set(line.slice(0, colon), line.slice(colon + 1));
    pos = nl + 1;
    consumed = pos;
  }

  const nums = (key: string): number[] =>
    (raw.get(key) ?? '')
      .split(',')
      .filter((s) => s.length > 0)
      .map(Number);

  return {
    header: {
      raw,
      fieldNames: (raw.get('Field I name') ?? '').split(',').filter((s) => s.length),
      fieldSigned: nums('Field I signed'),
      iPredictor: nums('Field I predictor'),
      iEncoding: nums('Field I encoding'),
      pPredictor: nums('Field P predictor'),
      pEncoding: nums('Field P encoding'),
      sNames: (raw.get('Field S name') ?? '').split(',').filter((s) => s.length),
      sSigned: nums('Field S signed'),
      sPredictor: nums('Field S predictor'),
      sEncoding: nums('Field S encoding'),
    },
    bytesConsumed: consumed,
  };
}

// -------------------------------------------------------------------- decode

/** Decode the first (or `session`-th) flight in a .BBL file. */
export function decodeBlackbox(buf: Uint8Array, session = 0): DecodedLog {
  const asLatin1 = new TextDecoder('latin1').decode(buf);

  // A .BBL can hold several flights back to back, each with its own header.
  const starts: number[] = [];
  let idx = asLatin1.indexOf(HEADER_MAGIC);
  while (idx >= 0) {
    starts.push(idx);
    idx = asLatin1.indexOf(HEADER_MAGIC, idx + 1);
  }
  if (starts.length === 0) throw new Error('no Blackbox header found');
  const start = starts[Math.min(session, starts.length - 1)]!;
  const end = session + 1 < starts.length ? starts[session + 1]! : buf.length;

  const { header, bytesConsumed } = parseHeader(asLatin1.slice(start, end));
  const nFields = header.fieldNames.length;
  if (nFields === 0) throw new Error('header declares no fields');

  const minthrottle = Number(header.raw.get('minthrottle') ?? 1000);
  const vbatref = Number(header.raw.get('vbatref') ?? 0);
  const motorOutput = (header.raw.get('motorOutput') ?? '0,2047').split(',').map(Number);
  const minmotor = motorOutput[0] ?? 0;

  const r = new Reader(buf, start + bytesConsumed);

  // Two frames of history: the straight-line and average-2 predictors need it.
  const prev = new Int32Array(nFields);
  const prev2 = new Int32Array(nFields);
  const current = new Int32Array(nFields);
  const out: number[][] = Array.from({ length: nFields }, () => []);
  const tmp: number[] = [0, 0, 0, 0, 0, 0, 0, 0];

  let frames = 0;
  let desyncs = 0;
  let haveI = false;

  const predict = (kind: number, i: number, isP: boolean): number => {
    switch (kind) {
      case PRED_ZERO:
        return 0;
      case PRED_PREVIOUS:
        return prev[i]!;
      case PRED_STRAIGHT_LINE:
        return 2 * prev[i]! - prev2[i]!;
      case PRED_AVERAGE_2:
        return (prev[i]! + prev2[i]!) >> 1;
      case PRED_MINTHROTTLE:
        return minthrottle;
      case PRED_MOTOR_0: {
        const m = header.fieldNames.indexOf('motor[0]');
        return m >= 0 ? current[m]! : 0;
      }
      case PRED_INC:
        return prev[i]! + 1;
      case PRED_1500:
        return 1500;
      case PRED_VBATREF:
        return vbatref;
      case PRED_MINMOTOR:
        return minmotor;
      default:
        return isP ? prev[i]! : 0;
    }
  };

  const readFrame = (isP: boolean): void => {
    const enc = isP ? header.pEncoding : header.iEncoding;
    const pred = isP ? header.pPredictor : header.iPredictor;
    let i = 0;
    while (i < nFields) {
      const e = enc[i] ?? ENC_SIGNED_VB;
      let raw: number;
      switch (e) {
        case ENC_SIGNED_VB:
          raw = r.signedVB();
          break;
        case ENC_UNSIGNED_VB:
          raw = r.unsignedVB();
          break;
        case ENC_NEG_14BIT:
          raw = -signExtend(r.unsignedVB(), 14);
          break;
        case ENC_NULL:
          raw = 0;
          break;
        case ENC_TAG2_3S32: {
          readTag2_3S32(r, tmp);
          for (let k = 0; k < 3 && i + k < nFields; k++) {
            current[i + k] = tmp[k]! + predict(pred[i + k] ?? 0, i + k, isP);
          }
          i += 3;
          continue;
        }
        case ENC_TAG8_4S16: {
          readTag8_4S16(r, tmp);
          for (let k = 0; k < 4 && i + k < nFields; k++) {
            current[i + k] = tmp[k]! + predict(pred[i + k] ?? 0, i + k, isP);
          }
          i += 4;
          continue;
        }
        case ENC_TAG8_8SVB: {
          // Runs to the end of the consecutive group with this encoding, max 8.
          let n = 0;
          while (n < 8 && i + n < nFields && enc[i + n] === ENC_TAG8_8SVB) n++;
          readTag8_8SVB(r, tmp, n);
          for (let k = 0; k < n; k++) {
            current[i + k] = tmp[k]! + predict(pred[i + k] ?? 0, i + k, isP);
          }
          i += n;
          continue;
        }
        default:
          raw = r.signedVB();
          break;
      }
      current[i] = raw + predict(pred[i] ?? 0, i, isP);
      i++;
    }
  };

  const skipSlowFrame = (): void => {
    for (let i = 0; i < header.sNames.length; i++) {
      const e = header.sEncoding[i] ?? ENC_SIGNED_VB;
      if (e === ENC_UNSIGNED_VB) r.unsignedVB();
      else if (e === ENC_SIGNED_VB) r.signedVB();
      else if (e === ENC_NEG_14BIT) r.unsignedVB();
      else if (e === ENC_TAG2_3S32) {
        readTag2_3S32(r, tmp);
        i += 2;
      } else if (e === ENC_TAG8_4S16) {
        readTag8_4S16(r, tmp);
        i += 3;
      }
    }
  };

  while (!r.eof && r.pos < end) {
    const mark = r.pos;
    const type = r.byte();
    let isIFrame = false;
    try {
      if (type === 0x49 /* I */) {
        readFrame(false);
        haveI = true;
        isIFrame = true;
      } else if (type === 0x50 /* P */) {
        if (!haveI) {
          desyncs++;
          continue;
        }
        readFrame(true);
      } else if (type === 0x53 /* S */) {
        skipSlowFrame();
        continue;
      } else if (type === 0x45 /* E */) {
        const ev = r.byte();
        // Payload length depends on the event. Guessing wrong desyncs the rest
        // of the file, so the common ones are decoded and anything unknown
        // falls back to scanning for the next frame marker.
        if (ev === 0xff) break; // log end
        else if (ev === 0) r.unsignedVB(); // sync beep: time
        else if (ev === 14) {
          // Logging resumed: iteration and time, and the history restarts.
          r.unsignedVB();
          r.unsignedVB();
          haveI = false;
        } else if (ev === 15) r.unsignedVB(); // disarm: reason
        else if (ev === 30) {
          r.unsignedVB(); // flight mode flags
          r.unsignedVB(); // last flags
        } else {
          while (!r.eof) {
            const p = r.peek();
            if (p === 0x49 || p === 0x50) break;
            r.byte();
          }
        }
        continue;
      } else {
        desyncs++;
        continue;
      }
    } catch {
      break; // ran off the end mid-frame
    }

    // Time must not go backwards. A frame that says it did is a desync, and
    // accepting it silently corrupts every straight-line prediction after it.
    const tIdx = 1;
    if (frames > 0 && current[tIdx]! < prev[tIdx]!) {
      desyncs++;
      r.pos = mark + 1;
      continue;
    }

    for (let i = 0; i < nFields; i++) out[i]!.push(current[i]!);
    if (isIFrame) {
      // An I frame is a restart: both history slots hold it. Leaving the older
      // slot at its previous contents makes the very next straight-line
      // prediction nonsense — for `time` that meant a jump to roughly twice the
      // timestamp, and every frame after it byte-scanned looking for sync.
      prev.set(current);
      prev2.set(current);
    } else {
      prev2.set(prev);
      prev.set(current);
    }
    frames++;
  }

  return {
    header,
    fieldNames: header.fieldNames,
    columns: out.map((a) => Float64Array.from(a)),
    frames,
    desyncs,
    craftName: header.raw.get('Craft name') ?? '',
    firmware: header.raw.get('Firmware revision') ?? '',
  };
}

/**
 * Parse only the header of a session. Cheap: a tune is a few dozen text lines
 * at the front of the file, and decoding a 16 MB frame stream to read them
 * would be absurd.
 */
export function readHeaderOnly(buf: Uint8Array, session = 0): BlackboxHeader {
  const text = new TextDecoder('latin1').decode(buf.subarray(0, Math.min(buf.length, 1 << 20)));
  const starts: number[] = [];
  let i = text.indexOf(HEADER_MAGIC);
  while (i >= 0) {
    starts.push(i);
    i = text.indexOf(HEADER_MAGIC, i + 1);
  }
  if (starts.length === 0) throw new Error('no Blackbox header found');
  const start = starts[Math.min(session, starts.length - 1)]!;
  return parseHeader(text.slice(start)).header;
}

/** How many separate flights the file holds. */
export function countSessions(buf: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(buf);
  let n = 0;
  let i = text.indexOf(HEADER_MAGIC);
  while (i >= 0) {
    n++;
    i = text.indexOf(HEADER_MAGIC, i + 1);
  }
  return n;
}
