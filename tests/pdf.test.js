// Run with: gjs -m tests/pdf.test.js  (needs tesseract + fra, poppler-utils, qpdf)
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {findScannedPages, makeSearchable} from '../plugin/nori/pdfText.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const fixture = name => Gio.File.new_for_path(GLib.build_filenamev([here, 'fixtures', name]));
const info = file => file.query_info('standard::*,time::modified', Gio.FileQueryInfoFlags.NONE, null);
const pdftotext = (file, page) => Gio.Subprocess.new(
    ['pdftotext', '-f', `${page}`, '-l', `${page}`, file.get_path(), '-'],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE).communicate_utf8(null, null)[1];
/** A copy under a new name, so that the cache does not answer. */
const freshCopy = name => {
    const copy = Gio.File.new_for_path(GLib.build_filenamev([GLib.Dir.make_tmp('nori-test-XXXXXX'), name]));
    fixture(name).copy(copy, Gio.FileCopyFlags.NONE, null, null);
    return copy;
};

let failures = 0, count = 0;
const test = async (name, fn) => {
    count++;
    try {
        await fn();
        print(`ok   ${name}`);
    } catch (e) {
        failures++;
        print(`FAIL ${name}\n     ${e.message}`);
    }
};
const ok = (cond, what) => {
    if (!cond)
        throw new Error(what);
};

await test('scanned pages from pdftotext output', () => {
    ok(JSON.stringify(findScannedPages('Some real text here, long enough.\f\f   \fx\f')) === '[2,3,4]', 'pages 2-4');
    ok(JSON.stringify(findScannedPages('')) === '[1]', 'empty single page');
    ok(JSON.stringify(findScannedPages('Some real text here, long enough.\f')) === '[]', 'all text');
});

await test('two scanned pages, one rotated, become selectable', async () => {
    const file = fixture('scan.pdf');
    const progress = [];
    const out = await makeSearchable(file, info(file), new Gio.Cancellable(), (d, t) => progress.push(`${d}/${t}`));
    ok(out, 'expected a searchable copy');
    ok(pdftotext(out, 1).includes('Total TTC : 418,35 CHF'), pdftotext(out, 1));
    ok(pdftotext(out, 1).includes('Genève'), 'accents');
    ok(pdftotext(out, 2).includes('portal.example.org'), pdftotext(out, 2));
    ok(progress[0] === '0/2' && progress.at(-1) === '2/2', progress.join(' '));
    // The original file is never modified.
    ok(pdftotext(file, 1).trim() === '', 'original untouched');
});

await test('second preview hits the cache', async () => {
    const file = fixture('scan.pdf');
    const t0 = Date.now();
    const out = await makeSearchable(file, info(file), new Gio.Cancellable());
    ok(out && Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
});

await test('mixed PDF: only the scanned page is read', async () => {
    const file = fixture('mixed.pdf');
    const progress = [];
    const out = await makeSearchable(file, info(file), new Gio.Cancellable(), (d, t) => progress.push(`${d}/${t}`));
    ok(progress.at(-1) === '1/1', progress.join(' '));
    const page1 = pdftotext(out, 1);
    ok(page1.split('This page has real text').length === 2, `text page duplicated: ${page1}`);
    ok(pdftotext(out, 2).includes('Genève'), pdftotext(out, 2));
});

await test('a PDF that already has text is left alone', async () => {
    const dir = GLib.Dir.make_tmp('nori-test-XXXXXX');
    const path = GLib.build_filenamev([dir, 'text.pdf']);
    Gio.Subprocess.new(['qpdf', '--empty', '--pages', fixture('mixed.pdf').get_path(), '1', '--', path],
        Gio.SubprocessFlags.NONE).wait_check(null);
    const file = Gio.File.new_for_path(path);
    ok(await makeSearchable(file, info(file), new Gio.Cancellable()) === null, 'expected null');
});

await test('cancelling stops the work', async () => {
    const file = freshCopy('mixed.pdf');
    const cancellable = new Gio.Cancellable();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    let threw = false;
    try {
        await makeSearchable(file, info(file), cancellable);
    } catch {
        threw = true;
    }
    ok(threw, 'expected an error after cancellation');
});

print(`\n${count - failures}/${count} passed`);
if (failures)
    imports.system.exit(1);
