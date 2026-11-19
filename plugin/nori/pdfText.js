// SPDX-License-Identifier: GPL-2.0-or-later
//
// Gives scanned PDF pages an invisible text layer, the way OCRmyPDF does:
// each page without text is rendered (pdftoppm), read by Tesseract as a
// text-only PDF page, and laid over the original page (qpdf --overlay).
// The original file is left untouched; the result is a cached copy that
// Sushi's PDF view loads, so its own selection and copy just work.
//
// Long documents: pages are read nearest-first from the page on screen
// (which can change while reading), each finished page is cached on its
// own so that a later preview resumes, and a copy can be built at any time
// from the pages read so far.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {debug, getLanguages, readConfig} from './ocr.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_async', 'communicate_finish');
Gio._promisify(Gio.File.prototype, 'copy_async', 'copy_finish');

const CACHE_VERSION = 2;
const DPI = 300;
const DEFAULT_MAX_PAGES = 200;
const CACHE_LIMIT_BYTES = 500 * 1024 * 1024;
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

/**
 * Next page to read: the closest to `focus`, preferring the pages after it
 * (people read forward).
 * @param {Iterable<number>} pending @param {number} focus
 */
export const nextPage = (pending, focus) => {
    let best = null, bestScore = Infinity;
    for (const page of pending) {
        // Pages behind count double, and lose ties.
        const score = page >= focus ? page - focus : (focus - page) * 2 + 0.5;
        if (score < bestScore) {
            best = page;
            bestScore = score;
        }
    }
    return best;
};

const cacheRoot = () => Gio.File.new_for_path(
    GLib.build_filenamev([GLib.get_user_cache_dir(), 'nori', 'pdf']));

/** Delete the least recently used documents beyond the cache budget. */
const pruneCache = keep => {
    const root = cacheRoot();
    const entries = [];
    try {
        for (const info of root.enumerate_children('standard::name,standard::type,time::modified',
            Gio.FileQueryInfoFlags.NONE, null)) {
            const child = root.get_child(info.get_name());
            if (info.get_file_type() !== Gio.FileType.DIRECTORY) {
                child.delete(null); // leftovers from cache version 1
                continue;
            }
            let size = 0;
            for (const f of child.enumerate_children('standard::size', Gio.FileQueryInfoFlags.NONE, null))
                size += f.get_size();
            entries.push({dir: child, size, mtime: info.get_modification_date_time().to_unix()});
        }
    } catch {
        return;
    }
    let total = entries.reduce((s, e) => s + e.size, 0);
    for (const entry of entries.sort((a, b) => a.mtime - b.mtime)) {
        if (total <= CACHE_LIMIT_BYTES)
            break;
        if (entry.dir.equal(keep))
            continue;
        removeTree(entry.dir.get_path());
        total -= entry.size;
    }
};

export class PdfTextJob {
    /** @type {number[]} scanned pages to read (1-based) */ pages = [];
    /** @type {Set<number>} */ done = new Set();
    focus = 1;
    #tools;
    #languages;
    #dir; // cache folder of this document
    #tmp = null;
    #input = null;
    #builds = 0;

    /**
     * @param {Gio.File} file a local PDF
     * @param {Gio.FileInfo|null} fileInfo
     */
    constructor(file, fileInfo) {
        this.file = file;
        this.fileInfo = fileInfo;
    }

    get complete() {
        return this.pages.every(p => this.done.has(p));
    }

    get completeFile() {
        return this.#dir.get_child('complete.pdf');
    }

    /**
     * Find the scanned pages and what the cache already has.
     * @returns {Promise<boolean>} false when there is nothing to do
     */
    async prepare(cancellable) {
        const config = readConfig();
        if (config.enabled === false || config.pdf === false || !this.file.get_path())
            return false;
        this.#tools = findTools();
        this.#languages = await getLanguages();
        if (!this.#languages)
            throw new MissingToolError('no Tesseract language data installed');

        const mtime = this.fileInfo?.get_modification_date_time()?.to_unix_usec() ?? 0;
        const size = this.fileInfo?.get_size() ?? 0;
        const key = `${CACHE_VERSION}|${this.file.get_uri()}|${mtime}|${size}|${this.#languages}`;
        this.#dir = cacheRoot().get_child(GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, -1));

        if (this.completeFile.query_exists(null)) {
            touch(this.#dir);
            return true;
        }
        const text = decoder.decode((await run(
            [this.#tools.pdftotext, '-q', '-enc', 'UTF-8', this.file.get_path(), '-'], {cancellable})).toArray());
        const maxPages = Number.isInteger(config.maxPdfPages) ? config.maxPdfPages : DEFAULT_MAX_PAGES;
        this.pages = findScannedPages(text).slice(0, Math.max(0, maxPages));
        if (this.pages.length === 0)
            return false;
        GLib.mkdir_with_parents(this.#dir.get_path(), 0o700);
        touch(this.#dir);
        pruneCache(this.#dir);
        for (const page of this.pages) {
            if (this.#pageFile(page).query_exists(null))
                this.done.add(page);
        }
        return true;
    }

    #pageFile(page) {
        return this.#dir.get_child(`${page}.pdf`);
    }

    /**
     * Read the remaining pages, nearest to `focus` first.
     * @param {Gio.Cancellable} cancellable
     * @param {(page: number) => void} onPage after each page
     */
    async run(cancellable, onPage = () => {}) {
        const pending = new Set(this.pages.filter(p => !this.done.has(p)));
        if (pending.size === 0)
            return;
        const started = GLib.get_monotonic_time();
        // A few pages at a time, each Tesseract on one thread: faster than
        // one multi-threaded Tesseract per page on a laptop CPU.
        const workers = Math.max(1, Math.min(3, Math.floor(GLib.get_num_processors() / 2)));
        // Stop the other workers on the first failure.
        const local = new Gio.Cancellable();
        const parentId = cancellable.connect(() => local.cancel());
        const worker = async () => {
            while (pending.size && !local.is_cancelled()) {
                const page = nextPage(pending, this.focus);
                pending.delete(page);
                try {
                    await this.#readPage(page, local);
                } catch (e) {
                    local.cancel();
                    throw e;
                }
                this.done.add(page);
                onPage(page);
            }
        };
        const results = await Promise.allSettled(Array.from({length: workers}, worker));
        cancellable.disconnect(parentId);
        const failure = results.find(r => r.status === 'rejected');
        if (failure)
            throw failure.reason;
        if (cancellable.is_cancelled())
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'cancelled');
        debug(`pdf ${this.file.get_basename()}: ${this.pages.length} page(s) in`,
            `${((GLib.get_monotonic_time() - started) / 1000).toFixed(0)} ms`);
    }

    async #readPage(page, cancellable) {
        const image = await run([this.#tools.pdftoppm, '-r', `${DPI}`, '-gray', '-f', `${page}`, '-l', `${page}`,
            '-singlefile', this.file.get_path()], {cancellable});
        const pdf = await run([this.#tools.tesseract, 'stdin', 'stdout', '-l', this.#languages, '--dpi', `${DPI}`,
            '-c', 'textonly_pdf=1', '-c', 'tessedit_create_pdf=1'],
        {stdin: image, cancellable, env: {OMP_THREAD_LIMIT: '1'}});
        const part = this.#dir.get_child(`${page}.pdf.part`);
        GLib.file_set_contents(part.get_path(), pdf.toArray());
        part.move(this.#pageFile(page), Gio.FileCopyFlags.OVERWRITE, null, null);
    }

    /**
     * A copy of the document with the pages read so far laid over it.
     * Once every page is read it becomes complete.pdf, reused next time.
     * @returns {Promise<Gio.File|null>} null if no page is read yet
     */
    async build(cancellable) {
        if (this.completeFile.query_exists(null))
            return this.completeFile;
        const ready = this.pages.filter(p => this.done.has(p));
        if (ready.length === 0)
            return null;
        // Ubuntu confines qpdf with AppArmor: it may only touch *.pdf files in
        // /tmp or in non-hidden folders of the home directory (not ~/.cache,
        // not /data...). So it works on copies in a temporary folder.
        if (!this.#tmp) {
            this.#tmp = makeTmpDir();
            this.#input = GLib.build_filenamev([this.#tmp, 'input.pdf']);
            await this.file.copy_async(Gio.File.new_for_path(this.#input), Gio.FileCopyFlags.NONE,
                GLib.PRIORITY_DEFAULT, cancellable, null);
        }
        const argv = [this.#tools.qpdf, this.#input];
        for (const page of ready) {
            const copy = GLib.build_filenamev([this.#tmp, `${page}.pdf`]);
            if (!GLib.file_test(copy, GLib.FileTest.EXISTS))
                this.#pageFile(page).copy(Gio.File.new_for_path(copy), Gio.FileCopyFlags.NONE, null, null);
            argv.push('--overlay', copy, `--to=${page}`, '--');
        }
        const output = GLib.build_filenamev([this.#tmp, 'output.pdf']);
        argv.push(output);
        await run(argv, {cancellable});

        const complete = ready.length === this.pages.length;
        // Partial copies get a new name each time: the view may still be
        // showing the previous one.
        const target = complete ? this.completeFile : this.#dir.get_child(`partial-${++this.#builds}.pdf`);
        Gio.File.new_for_path(output).move(target, Gio.FileCopyFlags.OVERWRITE, cancellable, null);
        return target;
    }

    /** Remove temporary files and partial copies (call when the preview closes). */
    dispose() {
        if (this.#tmp)
            removeTree(this.#tmp);
        this.#tmp = null;
        if (!this.#dir)
            return;
        try {
            for (const info of this.#dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null)) {
                if (info.get_name().startsWith('partial-'))
                    this.#dir.get_child(info.get_name()).delete(null);
            }
        } catch {}
    }
}

/**
 * A temporary folder qpdf may use: AppArmor only allows /tmp and /var/tmp.
 * Also sweeps folders left behind by previews that were killed.
 */
const makeTmpDir = () => {
    const base = /^\/(var\/)?tmp(\/|$)/.test(GLib.get_tmp_dir()) ? GLib.get_tmp_dir() : '/tmp';
    const now = Date.now() / 1000;
    try {
        const root = Gio.File.new_for_path(base);
        for (const info of root.enumerate_children('standard::name,time::modified,owner::user',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)) {
            if (info.get_name().startsWith('nori-pdf-') &&
                info.get_attribute_string('owner::user') === GLib.get_user_name() &&
                now - info.get_modification_date_time().to_unix() > 3600)
                removeTree(root.get_child(info.get_name()).get_path());
        }
    } catch {}
    const path = GLib.build_filenamev([base, `nori-pdf-${GLib.uuid_string_random()}`]);
    if (GLib.mkdir_with_parents(path, 0o700) !== 0)
        throw new Error(`cannot create ${path}`);
    return path;
};

const touch = dir => {
    try {
        dir.set_attribute_uint64('time::modified', Math.floor(Date.now() / 1000),
            Gio.FileQueryInfoFlags.NONE, null);
    } catch {}
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

/**
 * Whole-document helper, used by tests: read every scanned page and return
 * the copy with text, or null if there is nothing to do.
 */
export const makeSearchable = async (file, fileInfo, cancellable, onProgress = () => {}) => {
    const job = new PdfTextJob(file, fileInfo);
    try {
        if (!await job.prepare(cancellable))
            return null;
        onProgress(job.done.size, job.pages.length);
        await job.run(cancellable, () => onProgress(job.done.size, job.pages.length));
        return await job.build(cancellable);
    } finally {
        job.dispose();
    }
};
