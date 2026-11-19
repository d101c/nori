// SPDX-License-Identifier: GPL-2.0-or-later
//
// Gives scanned PDF pages an invisible text layer, the way OCRmyPDF does:
// each page without text is rendered (pdftoppm), read by Tesseract as a
// text-only PDF page, and laid over the original page (qpdf --overlay).
// The original pages are left untouched; the result is a cached copy that
// Sushi's PDF view then loads, so its own selection and copy just work.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {debug, getLanguages, readConfig} from './ocr.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_async', 'communicate_finish');

const CACHE_VERSION = 1;
const DPI = 300;
const DEFAULT_MAX_PAGES = 30;
/** A page with fewer visible characters than this is treated as a scan. */
const MIN_TEXT_CHARS = 20;

const decoder = new TextDecoder();

export class MissingToolError extends Error {}

const TOOLS = ['tesseract', 'pdftoppm', 'pdftotext', 'qpdf'];
const findTools = () => {
    const paths = {};
    for (const tool of TOOLS) {
        paths[tool] = GLib.find_program_in_path(tool);
        if (!paths[tool])
            throw new MissingToolError(`${tool} is not installed`);
    }
    return paths;
};

/**
 * @param {string[]} argv
 * @param {{stdin?: GLib.Bytes, cancellable: Gio.Cancellable, env?: Record<string,string>}} opts
 * @returns {Promise<GLib.Bytes>} stdout
 */
const run = async (argv, {stdin = null, cancellable, env = {}}) => {
    const launcher = new Gio.SubprocessLauncher({
        flags: (stdin ? Gio.SubprocessFlags.STDIN_PIPE : 0) |
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    for (const [k, v] of Object.entries(env))
        launcher.setenv(k, v, true);
    const proc = launcher.spawnv(argv);
    const cancelId = cancellable.connect(() => proc.force_exit());
    try {
        const [stdout, stderr] = await proc.communicate_async(stdin, cancellable);
        if (!proc.get_successful()) {
            const message = decoder.decode(stderr?.toArray() ?? new Uint8Array()).trim().split('\n').pop();
            throw new Error(`${GLib.path_get_basename(argv[0])} failed: ${message}`);
        }
        return stdout;
    } finally {
        cancellable.disconnect(cancelId);
    }
};

/** 1-based numbers of the pages that hold (almost) no text, from pdftotext output. */
export const findScannedPages = text => {
    const pages = text.split('\f');
    if (text.endsWith('\f'))
        pages.pop(); // pdftotext ends every page, the last one included, with a form feed
    return pages
        .map((page, i) => [i + 1, page.replace(/\s+/g, '').length])
        .filter(([, chars]) => chars < MIN_TEXT_CHARS)
        .map(([n]) => n);
};

const cacheFile = key => Gio.File.new_for_path(GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'nori', 'pdf',
    `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, -1)}.pdf`,
]));

/**
 * Returns a PDF with selectable text for `file`, or null when there is
 * nothing to do (every page already has text, or OCR is disabled).
 *
 * @param {Gio.File} file a local PDF
 * @param {Gio.FileInfo|null} fileInfo
 * @param {Gio.Cancellable} cancellable
 * @param {(done: number, total: number) => void} onProgress
 * @returns {Promise<Gio.File|null>}
 */
export const makeSearchable = async (file, fileInfo, cancellable, onProgress = () => {}) => {
    const config = readConfig();
    if (config.enabled === false || config.pdf === false)
        return null;
    const path = file.get_path();
    if (!path)
        return null;
    const tools = findTools();
    const languages = await getLanguages();
    if (!languages)
        throw new MissingToolError('no Tesseract language data installed');

    const mtime = fileInfo?.get_modification_date_time()?.to_unix_usec() ?? 0;
    const size = fileInfo?.get_size() ?? 0;
    const cached = cacheFile(`${CACHE_VERSION}|${file.get_uri()}|${mtime}|${size}|${languages}`);
    if (cached.query_exists(null)) {
        debug('pdf cache hit', file.get_uri());
        return cached;
    }

    const text = decoder.decode((await run(
        [tools.pdftotext, '-q', '-enc', 'UTF-8', path, '-'], {cancellable})).toArray());
    const maxPages = Number.isInteger(config.maxPdfPages) ? config.maxPdfPages : DEFAULT_MAX_PAGES;
    const pages = findScannedPages(text).slice(0, Math.max(0, maxPages));
    if (pages.length === 0)
        return null;

    const started = GLib.get_monotonic_time();
    const dir = GLib.Dir.make_tmp('nori-pdf-XXXXXX');
    try {
        // A few pages at a time, each Tesseract on one thread: faster than
        // one multi-threaded Tesseract per page on a laptop CPU.
        const workers = Math.max(1, Math.min(3, Math.floor(GLib.get_num_processors() / 2)));
        let done = 0;
        onProgress(0, pages.length);
        const queue = [...pages];
        const ocrPage = async (page, cancellable) => {
            const image = await run([tools.pdftoppm, '-r', `${DPI}`, '-gray', '-f', `${page}`, '-l', `${page}`,
                '-singlefile', path], {cancellable});
            const pdf = await run([tools.tesseract, 'stdin', 'stdout', '-l', languages, '--dpi', `${DPI}`,
                '-c', 'textonly_pdf=1', '-c', 'tessedit_create_pdf=1'],
            {stdin: image, cancellable, env: {OMP_THREAD_LIMIT: '1'}});
            GLib.file_set_contents(GLib.build_filenamev([dir, `${page}.pdf`]), pdf.toArray());
            onProgress(++done, pages.length);
        };
        // Stop the other workers on the first failure, and wait for all of
        // them before the temporary directory is removed.
        const local = new Gio.Cancellable();
        const parentId = cancellable.connect(() => local.cancel());
        const results = await Promise.allSettled(Array.from({length: workers}, async () => {
            try {
                while (queue.length && !local.is_cancelled())
                    await ocrPage(queue.shift(), local);
            } catch (e) {
                local.cancel();
                throw e;
            }
        }));
        cancellable.disconnect(parentId);
        const failure = results.find(r => r.status === 'rejected');
        if (failure)
            throw failure.reason;

        // One overlay clause per page: qpdf maps each text-only page onto its
        // original, keeping the original's rotation and boxes.
        // Ubuntu confines qpdf with AppArmor: it may only touch *.pdf files in
        // /tmp or in non-hidden folders of the home directory (not ~/.cache,
        // not /data...). So it works on copies in the temporary directory.
        const input = GLib.build_filenamev([dir, 'input.pdf']);
        const output = GLib.build_filenamev([dir, 'output.pdf']);
        file.copy(Gio.File.new_for_path(input), Gio.FileCopyFlags.NONE, cancellable, null);
        const argv = [tools.qpdf, input];
        for (const page of pages)
            argv.push('--overlay', GLib.build_filenamev([dir, `${page}.pdf`]), `--to=${page}`, '--');
        argv.push(output);
        await run(argv, {cancellable});
        GLib.mkdir_with_parents(cached.get_parent().get_path(), 0o700);
        Gio.File.new_for_path(output).move(cached, Gio.FileCopyFlags.OVERWRITE, cancellable, null);
        debug(`pdf ${file.get_basename()}: ${pages.length} page(s) in`,
            `${((GLib.get_monotonic_time() - started) / 1000).toFixed(0)} ms`);
        return cached;
    } finally {
        removeTree(dir);
    }
};

const removeTree = path => {
    const dir = Gio.File.new_for_path(path);
    try {
        for (const info of dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null))
            dir.get_child(info.get_name()).delete(null);
        dir.delete(null);
    } catch (e) {
        console.warn('[nori] cannot clean', path, e.message);
    }
};
