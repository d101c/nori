// Run with: gjs -m tests/layout.test.js
import GLib from 'gi://GLib';
import {TextLayout} from '../plugin/nori/layout.js';
import {pickDefaultLanguages} from '../plugin/nori/ocr.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const fixture = name => new TextDecoder().decode(
    GLib.file_get_contents(GLib.build_filenamev([here, 'fixtures', name]))[1]);

let failures = 0, count = 0;
const test = (name, fn) => {
    count++;
    try {
        fn();
        print(`ok   ${name}`);
    } catch (e) {
        failures++;
        print(`FAIL ${name}\n     ${e.message}`);
    }
};
const eq = (actual, expected, what = '') => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${what} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const ok = (cond, what) => {
    if (!cond)
        throw new Error(what);
};

/** Minimal TSV: one entry per word, [text, x, y, w, h, line, conf?]. */
const tsv = words => ['level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    ...words.map(([text, x, y, w, h, line, conf = 95], i) =>
        `5\t1\t1\t1\t${line}\t${i + 1}\t${x}\t${y}\t${w}\t${h}\t${conf}\t${text}`)].join('\n');

const center = b => [b.x + b.w / 2, b.y + b.h / 2];
const kinds = layout => layout.detections.map(d => [d.kind, d.value]);

test('letter: lines and full text', () => {
    const layout = TextLayout.fromTsv(fixture('letter.x2.tsv'), 2);
    eq(layout.lines.length, 8, 'lines');
    ok(layout.fullText.includes('Total TTC : 418,35 CHF, payable à trente jours'), layout.fullText);
    ok(layout.fullText.includes('Main-d\'œuvre : 2 h 30 à 95,00 CHF'), 'œ ligature and accents');
});

test('letter: detects e-mail, phone and link, not reference numbers', () => {
    const found = kinds(TextLayout.fromTsv(fixture('letter.x2.tsv'), 2));
    ok(found.some(([k, v]) => k === 'email' && v === 'atelier@exemple.ch'), JSON.stringify(found));
    ok(found.some(([k, v]) => k === 'phone' && v === '022 781 45 90'), JSON.stringify(found));
    ok(found.some(([k, v]) => k === 'url' && v === 'https://www.exemple.ch/conditions'), JSON.stringify(found));
    eq(found.length, 3, 'only three detections');
});

test('dark screenshot: inverted text and bare domain', () => {
    const layout = TextLayout.fromTsv(fixture('dark.x2.tsv'), 2);
    eq(layout.lines.length, 4, 'lines');
    ok(kinds(layout).some(([k, v]) => k === 'url' && v === 'https://portal.example.org'), JSON.stringify(kinds(layout)));
    ok(!kinds(layout).some(([k]) => k === 'phone'), '15:30 and 1 284 are not phone numbers');
});

test('image without text gives an empty layout', () => {
    ok(TextLayout.fromTsv(fixture('notext.x2.tsv'), 2).isEmpty, 'expected no words');
});

test('low-confidence garbage lines are dropped', () => {
    const layout = TextLayout.fromTsv(tsv([
        ['Hello', 0, 0, 50, 10, 1], ['world', 60, 0, 50, 10, 1],
        ['~~', 0, 30, 20, 10, 2, 20], ['Jz', 30, 30, 20, 10, 2, 45], ['é1', 60, 30, 20, 10, 2, 40],
    ]));
    eq(layout.fullText, 'Hello world');
});

test('scale maps OCR pixels back to image pixels', () => {
    const layout = TextLayout.fromTsv(tsv([['Hi', 100, 40, 60, 20, 1]]), 2);
    eq(layout.words[0].box, {x: 50, y: 20, w: 30, h: 10});
});

test('hit-testing: word under pointer, nearest word while dragging', () => {
    const layout = TextLayout.fromTsv(tsv([
        ['one', 0, 0, 30, 10, 1], ['two', 40, 0, 30, 10, 1],
        ['three', 0, 20, 50, 10, 2], ['four', 60, 20, 40, 10, 2],
    ]));
    eq(layout.wordAt(...center(layout.words[1].box)), 1);
    eq(layout.wordAt(200, 200), -1, 'far away');
    eq(layout.wordAt(35, 5), 0, 'gap between words picks a neighbour');
    eq(layout.nearestWord(500, 25), 3, 'past the end of line 2');
    eq(layout.nearestWord(-50, -50), 0, 'before the first word');
    eq(layout.lineRange(2), [2, 3]);
});

test('selection text and boxes follow lines', () => {
    const layout = TextLayout.fromTsv(tsv([
        ['one', 0, 0, 30, 10, 1], ['two', 40, 2, 30, 8, 1],
        ['three', 0, 20, 50, 12, 2], ['four', 60, 20, 40, 10, 2],
    ]));
    eq(layout.textBetween(1, 2), 'two\nthree');
    const boxes = layout.selectionBoxes(1, 3);
    eq(boxes.length, 2);
    eq(boxes[0], {x: 40, y: 0, w: 30, h: 10}, 'uses the line height');
    eq(boxes[1], {x: 0, y: 20, w: 100, h: 12});
});

test('blocks are separated by a blank line', () => {
    const t = tsv([['A', 0, 0, 10, 10, 1], ['B', 0, 50, 10, 10, 1]]).split('\n');
    t[2] = t[2].replace(/^5\t1\t1/, '5\t1\t2'); // second word in block 2
    eq(TextLayout.fromTsv(t.join('\n')).fullText, 'A\n\nB');
});

test('detections glue words split around @ and strip trailing punctuation', () => {
    const layout = TextLayout.fromTsv(tsv([
        ['Write', 0, 0, 40, 10, 1], ['to', 50, 0, 20, 10, 1], ['jane.doe', 80, 0, 60, 10, 1],
        ['@example.com.', 140, 0, 90, 10, 1], ['or', 240, 0, 20, 10, 1], ['+41', 270, 0, 30, 10, 1],
        ['22', 305, 0, 20, 10, 1], ['345', 330, 0, 30, 10, 1], ['67', 365, 0, 20, 10, 1], ['89', 390, 0, 20, 10, 1],
    ]));
    const email = layout.detections.find(d => d.kind === 'email');
    eq([email.value, email.first, email.last], ['jane.doe@example.com', 2, 3]);
    const phone = layout.detections.find(d => d.kind === 'phone');
    eq([phone.value, phone.first, phone.last], ['+41 22 345 67 89', 5, 9]);
    eq(layout.detectionAt(3), email);
    eq(layout.detectionAt(0), null);
});

test('not phone numbers: dates, prices, references', () => {
    for (const text of ['2026-1142', '19.11.2026', '1 284 files', '418,35 CHF', 'pompe 00620774', '978 2 07 036024 5']) {
        const layout = TextLayout.fromTsv(tsv(text.split(' ').map((w, i) => [w, i * 60, 0, 50, 10, 1])));
        ok(!layout.detections.some(d => d.kind === 'phone'), `${text} -> ${JSON.stringify(kinds(layout))}`);
    }
});

test('default languages: session language plus English', () => {
    eq(pickDefaultLanguages(['eng', 'osd'], ['en_US.UTF-8', 'en_US', 'en', 'C']), ['eng']);
    eq(pickDefaultLanguages(['eng', 'fra', 'osd'], ['en_US', 'en', 'C']), ['eng', 'fra']);
    eq(pickDefaultLanguages(['deu', 'eng', 'fra', 'ita', 'spa', 'osd'], ['fr_CH', 'fr', 'C']), ['fra', 'eng']);
    eq(pickDefaultLanguages(['osd'], ['C']), []);
});

print(`\n${count - failures}/${count} passed`);
if (failures)
    imports.system.exit(1);
