/* SPDX-License-Identifier: GPL-2.0-or-later WITH GStreamer-exception-2008
 * SPDX-FileCopyrightText: 2011 Red Hat, Inc.
 *
 * Authors: Cosimo Cecchi <cosimoc@redhat.com>
 */

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import PapersDocument from 'gi://PapersDocument';
import PapersView from 'gi://PapersView';
// eslint-disable-next-line no-restricted-properties
const Format = imports.format;

import {Renderer, resolveRelativePath, setupActions} from 'resource:///org/gnome/NautilusPreviewer/plugin-api-1.js';
import {Connection} from './connection.js';

// Sushi installs gettext globals; outside it (tests) fall back to identity.
const _ = globalThis._ ?? (s => s);

let papersInitialized = false;

export const Klass = class PdfRenderer extends Adw.Bin {
    static {
        GObject.registerClass({
            GTypeName: 'NoriPdfView', // Sushi's own copy is registered in the same process
            Implements: [Renderer],
            Template: resolveRelativePath(import.meta.url, 'pdf.ui'),
            InternalChildren: [
                'model', 'view', 'toolbarBack', 'toolbarForward', 'pageLabel',
                'toolbar',
            ],
        }, this);
    }

    #loadJobId = new Connection('finished', job => this._onLoadJobFinished(job));

    constructor(file, _fileInfo, constructProperties = {}) {
        if (!papersInitialized) {
            PapersDocument.init();
            papersInitialized = true;
        }
        GObject.type_ensure(PapersView.View);

        super(constructProperties);

        this._loadFile(file);

        setupActions(this, 'pdf', [
            ['copy', () => this._view.copy()],
        ]);

        this.markInitialized();
    }

    stop() {
        this.#loadJobId.disconnect();
        this._job?.cancel();
        this._job = null;
    }

    get toolbar() {
        return this._toolbar;
    }

    _loadFile(file) {
        this._job = PapersView.JobLoad.new();
        this._job.set_uri(file.get_uri());

        this.#loadJobId.connect(this._job);
        this._job.scheduler_push_job(PapersView.JobPriority.PRIORITY_NONE);
    }

    _onLoadJobFinished(job) {
        this.#loadJobId.disconnect();
        this._job = null;

        if (this.cancellable.is_cancelled())
            return;

        const document = job.get_loaded_document();
        try {
            // the original C function has an out param for the error
            // which gets converted to an exception by GJS.
            job.is_succeeded();
        } catch (error) {
            this.markFailed(error);
            return;
        }

        this._model.set_document(document);

        this._updatePageLabel(this._model);
        this.markReady();
    }

    _goNextPage() {
        this._view.next_page();
    }

    _goPreviousPage() {
        this._view.previous_page();
    }

    _updatePageLabel(model) {
        const currentPage = model.get_page();
        const totalPages = model.document.get_n_pages();

        this._toolbarBack.set_sensitive(currentPage > 0);
        this._toolbarForward.set_sensitive(currentPage < totalPages - 1);
        this._pageLabel.set_text(Format.vprintf(_('%d of %d'), [currentPage + 1, totalPages]));
        this._pageLabel.set_visible(true);
    }
};
