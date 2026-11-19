// SPDX-License-Identifier: GPL-2.0-or-later
//
// Nori for PDFs: scanned pages get an invisible text layer in the
// background, then the preview reloads that copy at the same page, so
// Sushi's own selection and Ctrl+C work on scans too.
//
// Sushi's PDF viewer is built from a GtkBuilder template, which GJS does not
// let us subclass, so this wraps it instead. If anything fails to load, the
// module exports no content types and Sushi keeps its own PDF viewer.

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import PapersView from 'gi://PapersView';

let Klass = null;
let contentTypes = [];

const PDF = 'application/pdf';

try {
    const {Renderer} = await import('resource:///org/gnome/NautilusPreviewer/plugin-api-1.js');
    const Pdf = await import('resource:///org/gnome/NautilusPreviewer/js/viewers/pdf.js');
    const {_} = await import('./nori/i18n.js');
    const {debug} = await import('./nori/ocr.js');
    const {makeSearchable, MissingToolError} = await import('./nori/pdfText.js');

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
                this.markReady();
                this.#start();
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
            this._job?.cancel();
            this._job = null;
            this.#hideProgress();
        }

        #start() {
            if (this.cancellable.is_cancelled())
                return;
            makeSearchable(this._file, this._fileInfo, this.cancellable,
                (done, total) => this.#showProgress(done, total))
                .then(searchable => {
                    this.#hideProgress();
                    if (searchable && !this.cancellable.is_cancelled())
                        this.#reload(searchable);
                })
                .catch(e => {
                    this.#hideProgress();
                    if (this.cancellable.is_cancelled())
                        return;
                    if (e instanceof MissingToolError)
                        debug(e.message);
                    else
                        console.warn('[nori] PDF text recognition failed:', e.message);
                });
        }

        /** Swap in the copy with text, at the page the reader is on. */
        #reload(file) {
            const job = PapersView.JobLoad.new();
            job.set_uri(file.get_uri());
            const id = job.connect('finished', () => {
                job.disconnect(id);
                this._job = null;
                if (this.cancellable.is_cancelled())
                    return;
                try {
                    job.is_succeeded();
                } catch (e) {
                    console.warn('[nori] cannot load the PDF with text:', e.message);
                    return;
                }
                const model = this._inner._model;
                const page = model.get_page();
                model.set_document(job.get_loaded_document());
                model.set_page(page);
                this._inner._updatePageLabel?.(model);
                debug('pdf reloaded with text layer');
            });
            this._job = job;
            job.scheduler_push_job(PapersView.JobPriority.PRIORITY_NONE);
        }

        #showProgress(done, total) {
            const toolbar = this._inner.toolbar;
            if (!toolbar)
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
