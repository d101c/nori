// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pure text-layout model built from Tesseract TSV output: words in reading
// order, grouped into lines and blocks, plus hit-testing, selection text and
// data detection. No GTK here, so it runs under plain `gjs -m` in tests.

const MIN_WORD_CONFIDENCE = 30;
const MIN_LINE_CONFIDENCE = 55;

/**
 * @typedef {{x: number, y: number, w: number, h: number}} Box
 * @typedef {{text: string, box: Box, conf: number, line: number, index: number}} Word
 * @typedef {{words: number[], box: Box, block: number, par: number}} Line
 * @typedef {{kind: 'url'|'email'|'phone', value: string, first: number, last: number}} Detection
 */

/** @param {Box[]} boxes @returns {Box} */
export const unionBox = boxes => {
    const x = Math.min(...boxes.map(b => b.x));
    const y = Math.min(...boxes.map(b => b.y));
    const r = Math.max(...boxes.map(b => b.x + b.w));
    const bottom = Math.max(...boxes.map(b => b.y + b.h));
    return {x, y, w: r - x, h: bottom - y};
};

/** Is `s` noise rather than a word: lone punctuation or box-drawing glyphs. */
const isNoise = s => !/[\p{L}\p{N}]/u.test(s) && s.length < 3;

export class TextLayout {
    /** @type {Word[]} */ words = [];
    /** @type {Line[]} */ lines = [];
    /** @type {Detection[]} */ detections = [];

    /**
     * @param {string} tsv Tesseract TSV (with header row)
     * @param {number} [scale] factor between OCR pixels and image pixels
     */
    static fromTsv(tsv, scale = 1) {
        const layout = new TextLayout();
        const groups = new Map();
        for (const row of tsv.split('\n').slice(1)) {
            const c = row.split('\t');
            if (c.length < 12 || c[0] !== '5')
                continue;
            const text = c.slice(11).join('\t').trim();
            const conf = Number(c[10]);
            if (!text || conf < MIN_WORD_CONFIDENCE)
                continue;
            const key = `${c[2]}.${c[3]}.${c[4]}`; // block.par.line
            if (!groups.has(key))
                groups.set(key, {block: Number(c[2]), par: Number(c[3]), raw: []});
            groups.get(key).raw.push({
                text, conf,
                box: {
                    x: Number(c[6]) / scale, y: Number(c[7]) / scale,
                    w: Number(c[8]) / scale, h: Number(c[9]) / scale,
                },
            });
        }

        for (const {block, par, raw} of groups.values()) {
            const meaningful = raw.filter(w => !isNoise(w.text));
            if (meaningful.length === 0)
                continue;
            const meanConf = meaningful.reduce((s, w) => s + w.conf, 0) / meaningful.length;
            if (meanConf < MIN_LINE_CONFIDENCE)
                continue;
            const lineIndex = layout.lines.length;
            const ids = raw.map(w => {
                const word = {...w, line: lineIndex, index: layout.words.length};
                layout.words.push(word);
                return word.index;
            });
            layout.lines.push({words: ids, box: unionBox(raw.map(w => w.box)), block, par});
        }
        layout.detections = detect(layout);
        return layout;
    }

    get isEmpty() {
        return this.words.length === 0;
    }

    /** Word whose box contains (x, y), in image pixels. @returns {number} -1 if none */
    wordAt(x, y) {
        for (const line of this.lines) {
            const b = line.box;
            const slack = b.h * 0.25;
            if (y < b.y - slack || y > b.y + b.h + slack || x < b.x - slack || x > b.x + b.w + slack)
                continue;
            // Inside the line band: take the word horizontally closest.
            return this.#closestInLine(line, x);
        }
        return -1;
    }

    /**
     * Word nearest to (x, y) in reading order, used while dragging so that the
     * selection keeps following the pointer between lines and past line ends.
     * @returns {number}
     */
    nearestWord(x, y) {
        if (this.isEmpty)
            return -1;
        let best = null;
        for (const line of this.lines) {
            const b = line.box;
            const dy = y < b.y ? b.y - y : y > b.y + b.h ? y - (b.y + b.h) : 0;
            const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
            const d = dy * 4 + dx; // vertical distance matters more
            if (!best || d < best.d)
                best = {d, line};
        }
        return this.#closestInLine(best.line, x);
    }

    #closestInLine(line, x) {
        let best = line.words[0], bestD = Infinity;
        for (const id of line.words) {
            const b = this.words[id].box;
            const d = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
            if (d < bestD) {
                best = id;
                bestD = d;
            }
        }
        return best;
    }

    /** @returns {[number, number]} first and last word of the line holding `id` */
    lineRange(id) {
        const words = this.lines[this.words[id].line].words;
        return [words[0], words[words.length - 1]];
    }

    /** Plain text for words first..last, with line and block breaks. */
    textBetween(first, last) {
        if (first < 0 || last < first)
            return '';
        let out = '';
        let prev = null;
        for (let i = first; i <= last; i++) {
            const word = this.words[i];
            if (prev) {
                if (word.line === prev.line)
                    out += ' ';
                else if (this.lines[word.line].block !== this.lines[prev.line].block)
                    out += '\n\n';
                else
                    out += '\n';
            }
            out += word.text;
            prev = word;
        }
        return out;
    }

    get fullText() {
        return this.textBetween(0, this.words.length - 1);
    }

    /** One box per line covering words first..last, for drawing a selection. */
    selectionBoxes(first, last) {
        const boxes = [];
        let current = null;
        for (let i = first; i <= last && i >= 0; i++) {
            const word = this.words[i];
            if (!current || current.line !== word.line) {
                current = {line: word.line, boxes: []};
                boxes.push(current);
            }
            current.boxes.push(word.box);
        }
        return boxes.map(entry => {
            const lineBox = this.lines[entry.line].box;
            const u = unionBox(entry.boxes);
            // Use the line's full height so that a selection does not jump
            // up and down with ascenders and descenders.
            return {x: u.x, y: lineBox.y, w: u.w, h: lineBox.h};
        });
    }

    /** @returns {Detection|null} */
    detectionAt(id) {
        return this.detections.find(d => id >= d.first && id <= d.last) ?? null;
    }
}

const URL_RE = /\b(?:https?:\/\/[^\s<>"]+|www\.[^\s<>"]+\.[^\s<>"]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|ch|fr|de|it|be|eu|uk|info|gov|edu)(?:\/[^\s<>"]*)?)/giu;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
// International (+41 22 781 45 90) or national (022 781 45 90, 06 12 34 56 78)
const PHONE_RE = /(?:\+\d{1,3}[\s.]?)?(?:\(0\)[\s.]?)?\d{2,4}(?:[\s.-]?\d{2,4}){2,4}/g;

/** Strip trailing punctuation that OCR glues to URLs and e-mails. */
const trimTail = s => s.replace(/[.,;:!?)\]}'"»]+$/u, '');

/** @param {TextLayout} layout @returns {Detection[]} */
const detect = layout => {
    const found = [];
    for (const line of layout.lines) {
        // Rebuild the line with a char -> word map.
        let text = '';
        const owner = [];
        line.words.forEach((id, n) => {
            // OCR often splits addresses around '@' and '/': glue them back.
            const prev = n > 0 ? layout.words[line.words[n - 1]].text : '';
            if (n > 0 && !/[@/]$/.test(prev) && !/^[@/]/.test(layout.words[id].text)) {
                text += ' ';
                owner.push(id);
            }
            for (const _ of layout.words[id].text) {
                text += _;
                owner.push(id);
            }
        });
        const chars = [...text];
        const toWords = (start, len) => {
            // `start`/`len` are UTF-16 indices from RegExp; convert to code points.
            const cpStart = [...text.slice(0, start)].length;
            const cpEnd = cpStart + [...text.slice(start, start + len)].length - 1;
            return [owner[cpStart], owner[Math.min(cpEnd, chars.length - 1)]];
        };
        const taken = [];
        const push = (kind, value, index, length) => {
            const [first, last] = toWords(index, length);
            if (taken.some(([a, b]) => first <= b && last >= a))
                return;
            taken.push([first, last]);
            found.push({kind, value, first, last});
        };

        for (const m of text.matchAll(EMAIL_RE))
            push('email', trimTail(m[0]), m.index, trimTail(m[0]).length);
        for (const m of text.matchAll(URL_RE)) {
            const value = trimTail(m[0]);
            if (value.includes('@'))
                continue;
            push('url', /^https?:/i.test(value) ? value : `https://${value}`, m.index, value.length);
        }
        for (const m of text.matchAll(PHONE_RE)) {
            const digits = m[0].replace(/\D/g, '');
            // Avoid dates, prices and reference numbers: real numbers have 9-15 digits
            // and are written with separators or a leading + / 0.
            if (digits.length < 9 || digits.length > 15 || !/^[+0(]/.test(m[0]) || !/[\s.-]/.test(m[0]))
                continue;
            push('phone', m[0].trim(), m.index, m[0].trimEnd().length);
        }
    }
    return found.sort((a, b) => a.first - b.first);
};
