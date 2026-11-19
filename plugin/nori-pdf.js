// SPDX-License-Identifier: GPL-2.0-or-later
//
// Nori for PDFs: scanned pages get an invisible text layer in the
// background, and the preview swaps in the copy with text, so Sushi's own
// selection and Ctrl+C work on scans too.
//
// Long documents: pages are read from the one on screen outwards, following
// the reader; the preview reloads as soon as the page being looked at has
// its text (at most every few seconds, never during a selection, keeping
// the scroll position), and once more at the end.
//
// Sushi's PDF viewer is built from a GtkBuilder template, which GJS does not
// let us subclass, so this wraps it instead. If anything fails to load, the
// module exports no content types and Sushi keeps its own PDF viewer.

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import PapersView from 'gi://PapersView';

let Klass = null;
let contentTypes = [];

const PDF = 'application/pdf';
const DEBOUNCE_MS = 600;
const MIN_RELOAD_INTERVAL_MS = 4000;

try {
    const {Renderer} = await import('resource:///org/gnome/NautilusPreviewer/plugin-api-1.js');
    const Pdf = await import('resource:///org/gnome/NautilusPreviewer/js/viewers/pdf.js');
    const {_} = await import('./nori/i18n.js');
    const {debug} = await import('./nori/ocr.js');
    const {PdfTextJob, MissingToolError} = await import('./nori/pdfText.js');

    Klass = class NoriPdfRenderer extends Adw.Bin {
        static {
            GObject.registerClass({Implements: [Renderer]}, this);
        }

        constructor(file, fileInfo, constructProperties = {}) {
            super(constructProperties);
            this._file = file;
            this._fileInfo = fileInfo;
            this._inner = new Pdf.Klass(file, fileInfo);
            this.set_child(this._inner);
            this._inner.connect('failed', (_r, error) => this.markFailed(error));
            this._inner.connect('ready', () => {
                try {
                    this.markReady();
                } finally {
                    this.#start();
                }
            });
            this.markInitialized();
        }

        get resizePolicy() {
            return this._inner.resizePolicy;
        }

        get topBarStyle() {
            return this._inner.topBarStyle;
        }

        get toolbar() {
            return this._inner.toolbar;
        }

        stop() {
            this._loadJob?.cancel();
            this._loadJob = null;
            for (const id of [this._reloadTimeout, this._restoreTimeout]) {
                if (id)
                    GLib.source_remove(id);
            }
            this._reloadTimeout = this._restoreTimeout = 0;
            if (this._pageChangedId)
                this._inner._model.disconnect(this._pageChangedId);
            this._pageChangedId = 0;
            this.#hideProgress();
            this._job?.dispose();
        }

        async #start() {
            const model = this._inner._model;
            const job = new PdfTextJob(this._file, this._fileInfo);
            this._job = job;
            this._loaded = new Set();
            this._lastReload = 0;
            try {
                if (!await job.prepare(this.cancellable) || this.cancellable.is_cancelled())
                    return;
                if (job.complete) {
                    this.#reloadNow();
                    return;
                }
                job.focus = model.get_page() + 1;
                this._pageChangedId = model.connect('page-changed', () => {
                    job.focus = model.get_page() + 1;
                    if (this.#visiblePages().some(p => job.done.has(p) && !this._loaded.has(p)))
                        this.#requestReload();
                });
                this.#showProgress(job.done.size, job.pages.length);
                if (job.done.size) // pages read during an earlier preview
                    this.#requestReload();
                await job.run(this.cancellable, page => {
                    debug(`pdf page ${page} read (page on screen: ${job.focus})`);
                    this.#showProgress(job.done.size, job.pages.length);
                    if (this.#visiblePages().includes(page))
                        this.#requestReload();
                });
                this.#hideProgress();
                this.#requestReload({final: true});
            } catch (e) {
                this.#hideProgress();
                if (this.cancellable.is_cancelled())
                    return;
                if (e instanceof MissingToolError)
                    debug(e.message);
                else
                    console.warn('[nori] PDF text recognition failed:', e.message);
            }
        }

        /** The page on screen and its neighbours, 1-based. */
        #visiblePages() {
            const page = this._inner._model.get_page() + 1;
            return [page - 1, page, page + 1, page + 2];
        }

        /**
         * Reload soon, but not too often (each reload redraws the document),
         * and never under a selection the reader is making.
         */
        #requestReload({final = false} = {}) {
            if (final)
                this._finalWanted = true;
            if (this._reloadTimeout || this._loadJob || this._building)
                return;
            const sinceLast = GLib.get_monotonic_time() / 1000 - this._lastReload;
            const delay = this._finalWanted ? DEBOUNCE_MS
                : Math.max(DEBOUNCE_MS, MIN_RELOAD_INTERVAL_MS - sinceLast);
            this._reloadTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._reloadTimeout = 0;
                if (this._inner._view.has_selection())
                    this.#requestReload(); // try again once the selection is gone
                else
                    this.#reloadNow();
                return GLib.SOURCE_REMOVE;
            });
        }

        async #reloadNow() {
            const job = this._job;
            const pages = job.complete ? new Set(job.pages) : new Set(job.done);
            if (this._loaded.size && [...pages].every(p => this._loaded.has(p)))
                return;
            let file;
            this._building = true;
            try {
                file = await job.build(this.cancellable);
            } catch (e) {
                if (!this.cancellable.is_cancelled())
                    console.warn('[nori] cannot build the PDF with text:', e.message);
                return;
            } finally {
                this._building = false;
            }
            if (!file || this.cancellable.is_cancelled())
                return;
            const loadJob = PapersView.JobLoad.new();
            loadJob.set_uri(file.get_uri());
            const id = loadJob.connect('finished', () => {
                loadJob.disconnect(id);
                this._loadJob = null;
                if (this.cancellable.is_cancelled())
                    return;
                try {
                    loadJob.is_succeeded();
                } catch (e) {
                    console.warn('[nori] cannot load the PDF with text:', e.message);
                    return;
                }
                this.#swapDocument(loadJob.get_loaded_document());
                this._loaded = pages;
                this._lastReload = GLib.get_monotonic_time() / 1000;
                debug(`pdf reloaded: ${pages.size}/${job.pages.length || pages.size} pages with text`);
                // Pages that finished during this reload.
                const missing = [...job.done].filter(p => !this._loaded.has(p));
                if (missing.length && (this._finalWanted || missing.some(p => this.#visiblePages().includes(p))))
                    this.#requestReload();
            });
            this._loadJob = loadJob;
            loadJob.scheduler_push_job(PapersView.JobPriority.PRIORITY_NONE);
        }

        /** Replace the document, keeping the page and the scroll position. */
        #swapDocument(document) {
            const model = this._inner._model;
            const view = this._inner._view;
            const vadjustment = view.get_vadjustment();
            const hadjustment = view.get_hadjustment();
            const top = vadjustment?.get_value() ?? 0;
            const left = hadjustment?.get_value() ?? 0;
            const page = model.get_page();
            model.set_document(document);
            model.set_page(page);
            this._inner._updatePageLabel?.(model);
            // The view lays the new document out over the next frames.
            if (this._restoreTimeout)
                GLib.source_remove(this._restoreTimeout);
            this._restoreTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                this._restoreTimeout = 0;
                vadjustment?.set_value(top);
                hadjustment?.set_value(left);
                return GLib.SOURCE_REMOVE;
            });
        }

        #showProgress(done, total) {
            const toolbar = this._inner.toolbar;
            if (!toolbar || done >= total)
                return;
            if (!this._spinner) {
                this._spinner = new Adw.Spinner({margin_start: 6, margin_end: 6});
                toolbar.append(this._spinner);
            }
            // Translators: progress while reading a scanned PDF, e.g. "2 of 5 pages"
            const label = _('Recognizing text: %d of %d pages')
                .replace('%d', `${done}`).replace('%d', `${total}`);
            this._spinner.set_tooltip_text(label);
            this._spinner.update_property([Gtk.AccessibleProperty.LABEL], [label]);
        }

        #hideProgress() {
            this._spinner?.get_parent()?.remove(this._spinner);
            this._spinner = null;
        }
    };
    if (Pdf.contentTypes.includes(PDF))
        contentTypes = [PDF];
} catch (e) {
    console.error(`[nori] PDF support disabled, falling back to Sushi's viewer: ${e}`);
}

export {Klass, contentTypes};
