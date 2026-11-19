// SPDX-License-Identifier: GPL-2.0-or-later
//
// Runs Tesseract on a decoded image and caches the TSV result per file.

import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_async', 'communicate_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const CACHE_VERSION = 1;
// Tesseract reads text best when x-height is around 20-30 px; small
// screenshots gain a lot from upscaling, big photos only lose time.
const UPSCALE_BELOW = 1400;
const DOWNSCALE_ABOVE = 3200;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export const debug = (...args) => {
    if (GLib.getenv('NORI_DEBUG'))
        console.log('[nori]', ...args);
};

let tesseractPath;
const findTesseract = () => {
    if (tesseractPath === undefined)
        tesseractPath = GLib.find_program_in_path('tesseract');
    return tesseractPath;
};

let languagesPromise = null;

/** Languages to pass to Tesseract, e.g. "fra+eng". Cached for the process lifetime. */
export const getLanguages = () => {
    languagesPromise ??= (async () => {
        const configured = readConfig().languages;
        const installed = await listInstalledLanguages();
        if (installed.length === 0)
            languagesPromise = null; // try again on the next image
        if (Array.isArray(configured)) {
            const usable = configured.filter(l => installed.includes(l));
            if (usable.length)
                return usable.join('+');
        }
        return pickDefaultLanguages(installed, GLib.get_language_names()).join('+');
    })();
    return languagesPromise;
};

// ISO 639-1 (locale) -> Tesseract code for the languages people most often ask for.
const LOCALE_TO_TESSERACT = {
    fr: 'fra', en: 'eng', de: 'deu', it: 'ita', es: 'spa', pt: 'por', nl: 'nld',
    pl: 'pol', sv: 'swe', da: 'dan', nb: 'nor', fi: 'fin', cs: 'ces', ru: 'rus',
    uk: 'ukr', el: 'ell', tr: 'tur', ja: 'jpn', zh: 'chi_sim', ko: 'kor', ar: 'ara',
};
const NOT_LANGUAGES = new Set(['osd', 'equ', 'snum']);

/**
 * Default: the session languages plus English, then any other installed
 * language when only a handful are installed (each one slows Tesseract down).
 * @param {string[]} installed
 * @param {string[]} localeNames
 */
export const pickDefaultLanguages = (installed, localeNames) => {
    const real = installed.filter(l => !NOT_LANGUAGES.has(l));
    const wanted = [];
    for (const name of localeNames) {
        const code = LOCALE_TO_TESSERACT[name.slice(0, 2)];
        if (code && real.includes(code) && !wanted.includes(code))
            wanted.push(code);
    }
    if (real.includes('eng') && !wanted.includes('eng'))
        wanted.push('eng');
    if (real.length <= 3)
        for (const l of real)
            if (!wanted.includes(l))
                wanted.push(l);
    return wanted.length ? wanted : real.slice(0, 1);
};

const listInstalledLanguages = async () => {
    const tesseract = findTesseract();
    if (!tesseract)
        return [];
    try {
        const proc = Gio.Subprocess.new([tesseract, '--list-langs'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [stdout] = await proc.communicate_async(null, null);
        return decoder.decode(stdout.toArray()).split('\n').slice(1)
            .map(l => l.trim()).filter(Boolean);
    } catch (e) {
        console.warn('[nori] cannot list Tesseract languages:', e.message);
        return [];
    }
};

const configDir = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'nori']);

/** ~/.config/nori/config.json, e.g. {"languages": ["fra", "eng"], "enabled": true} */
export const readConfig = () => {
    try {
        const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([configDir(), 'config.json']));
        const config = ok ? JSON.parse(decoder.decode(bytes)) : null;
        return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    } catch {
        return {};
    }
};

const cacheFile = key => Gio.File.new_for_path(GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'nori', 'ocr',
    `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, -1)}.tsv`,
]));

/** Cache key from the file identity: changing the file invalidates it. */
const cacheKey = (file, fileInfo, languages) => {
    const mtime = fileInfo?.get_modification_date_time()?.to_unix_usec() ?? 0;
    const size = fileInfo?.get_size() ?? 0;
    return `${CACHE_VERSION}|${file.get_uri()}|${mtime}|${size}|${languages}`;
};

export class OcrUnavailableError extends Error {}

/**
 * Recognise the text of `texture` (the frame on screen, so EXIF rotation and
 * every format Glycin decodes are already handled).
 *
 * @param {import('gi://Gdk').default.Texture} texture
 * @param {Gio.File} file
 * @param {Gio.FileInfo|null} fileInfo
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<{tsv: string, scale: number}>} scale: OCR px per image px
 */
export const recognize = async (texture, file, fileInfo, cancellable) => {
    const tesseract = findTesseract();
    if (!tesseract)
        throw new OcrUnavailableError('tesseract is not installed');
    const languages = await getLanguages();
    if (!languages)
        throw new OcrUnavailableError('no Tesseract language data installed');

    const key = cacheKey(file, fileInfo, languages);
    const cached = cacheFile(key);
    try {
        const [bytes] = await cached.load_contents_async(cancellable);
        const text = decoder.decode(bytes);
        const nl = text.indexOf('\n');
        const scale = Number(text.slice(0, nl));
        if (nl > 0 && Number.isFinite(scale) && scale > 0 && text.startsWith('level\t', nl + 1)) {
            debug('cache hit', file.get_uri());
            return {scale, tsv: text.slice(nl + 1)};
        }
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
    }

    const started = GLib.get_monotonic_time();
    const {image, scale} = encodeForOcr(texture);
    const encoded = GLib.get_monotonic_time();
    const proc = Gio.Subprocess.new(
        // '-c' rather than the 'tsv' config file, which is missing from
        // custom TESSDATA_PREFIX directories.
        [tesseract, 'stdin', 'stdout', '-l', languages, '--psm', '3',
            '-c', 'tessedit_create_tsv=1', '-c', 'tessedit_create_txt=0'],
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
        Gio.SubprocessFlags.STDERR_SILENCE);
    const cancelId = cancellable.connect(() => proc.force_exit());
    let stdout;
    try {
        [stdout] = await proc.communicate_async(image, cancellable);
    } finally {
        cancellable.disconnect(cancelId);
    }
    if (!proc.get_successful())
        throw new Error(`tesseract exited with status ${proc.get_exit_status()}`);
    const tsv = decoder.decode(stdout.toArray());
    if (!tsv.startsWith('level\t'))
        throw new Error('tesseract did not produce TSV output');
    debug(`ocr ${file.get_basename()} ${languages} x${scale.toFixed(2)}:`,
        `${((encoded - started) / 1000).toFixed(0)} ms encode,`,
        `${((GLib.get_monotonic_time() - encoded) / 1000).toFixed(0)} ms tesseract`);

    storeCache(cached, `${scale}\n${tsv}`);
    return {tsv, scale};
};

/** Best effort: a cache that cannot be written only costs a re-run. */
const storeCache = (file, content) => {
    try {
        file.get_parent().make_directory_with_parents(null);
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
    }
    file.replace_contents_bytes_async(new GLib.Bytes(encoder.encode(content)), null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null)
        .catch(e => console.warn('[nori] cannot write OCR cache:', e.message));
};

/**
 * Uncompressed PPM for Tesseract, resized when the image is far from the size
 * Tesseract reads best. Going through raw pixels avoids GTK's PNG encoder,
 * which takes seconds on a camera photo.
 */
const encodeForOcr = texture => {
    const w = texture.get_width();
    const h = texture.get_height();
    const longest = Math.max(w, h);
    let scale = 1;
    if (longest < UPSCALE_BELOW)
        scale = 2;
    else if (longest > DOWNSCALE_ABOVE)
        scale = DOWNSCALE_ABOVE / longest;

    const alpha = hasAlpha(texture);
    const downloader = Gdk.TextureDownloader.new(texture);
    downloader.set_format(alpha ? Gdk.MemoryFormat.R8G8B8A8 : Gdk.MemoryFormat.R8G8B8);
    const [bytes, stride] = downloader.download_bytes();
    let pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(bytes, GdkPixbuf.Colorspace.RGB, alpha, 8, w, h, stride);
    const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));
    const interp = scale > 1 ? GdkPixbuf.InterpType.HYPER : GdkPixbuf.InterpType.BILINEAR;
    if (alpha) {
        // Transparent pixels are usually black: put the image on white, or
        // dark text on a transparent background would vanish.
        pixbuf = dropAlpha(pixbuf.composite_color_simple(sw, sh, interp, 255, 1024, 0xffffff, 0xffffff));
    } else if (scale !== 1) {
        pixbuf = pixbuf.scale_simple(sw, sh, interp);
    }
    return {image: toPpm(pixbuf), scale};
};

const OPAQUE_FORMATS = new Set(['B8G8R8X8', 'X8R8G8B8', 'R8G8B8X8', 'X8B8G8R8', 'R8G8B8', 'B8G8R8',
    'R16G16B16', 'R16G16B16_FLOAT', 'R32G32B32_FLOAT', 'G8', 'G16']);
const hasAlpha = texture => {
    const format = texture.get_format?.();
    const name = Object.keys(Gdk.MemoryFormat).find(k => Gdk.MemoryFormat[k] === format);
    return !name || !OPAQUE_FORMATS.has(name);
};

/** RGBA -> RGB in C (a JS loop over millions of pixels would stall the UI). */
const dropAlpha = pixbuf => {
    const w = pixbuf.get_width(), h = pixbuf.get_height();
    const texture = Gdk.MemoryTexture.new(w, h, Gdk.MemoryFormat.R8G8B8A8,
        pixbuf.read_pixel_bytes(), pixbuf.get_rowstride());
    const downloader = Gdk.TextureDownloader.new(texture);
    downloader.set_format(Gdk.MemoryFormat.R8G8B8);
    const [bytes, stride] = downloader.download_bytes();
    return GdkPixbuf.Pixbuf.new_from_bytes(bytes, GdkPixbuf.Colorspace.RGB, false, 8, w, h, stride);
};

/** @param {GdkPixbuf.Pixbuf} pixbuf RGB, no alpha @returns {GLib.Bytes} */
export const toPpm = pixbuf => {
    const w = pixbuf.get_width(), h = pixbuf.get_height();
    const rowstride = pixbuf.get_rowstride();
    const src = pixbuf.read_pixel_bytes().toArray();
    const header = encoder.encode(`P6\n${w} ${h}\n255\n`);
    const out = new Uint8Array(header.length + w * h * 3);
    out.set(header);
    for (let y = 0; y < h; y++)
        out.set(src.subarray(y * rowstride, y * rowstride + w * 3), header.length + y * w * 3);
    return new GLib.Bytes(out);
};
