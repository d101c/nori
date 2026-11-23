// SPDX-License-Identifier: GPL-2.0-or-later
//
// Nori: Sushi plugin that makes the text in previewed images selectable.
//
// It extends a copy of Sushi's image viewer (nori/vendor/image.js), as Sushi's
// maintainers recommend (sushi#179), so loading, animation and sizing behave
// like upstream while Nori only depends on the stable plugin API. If anything
// here fails to load, the module exports no content types and Sushi keeps
// using its built-in viewer.

import GObject from 'gi://GObject';

let Klass = null;
let contentTypes = [];

try {
    const Image = await import('./nori/vendor/image.js');
    const {LiveText} = await import('./nori/liveText.js');

    Klass = class NoriImageRenderer extends Image.Klass {
        static {
            GObject.registerClass(this);
        }

        constructor(file, fileInfo, constructProperties = {}) {
            super(file, fileInfo, constructProperties);
            this._noriFile = file;
            this._noriFileInfo = fileInfo;
        }

        /** @returns {LiveText|null} null if it could not be set up */
        get liveText() {
            if (this._liveText === undefined) {
                try {
                    this._liveText = new LiveText(this, () => this.cancellable);
                } catch (e) {
                    console.error(`[nori] text layer disabled: ${e}`);
                    this._liveText = null;
                }
            }
            return this._liveText;
        }

        async _loadFile(file) {
            await super._loadFile(file);
            // Sushi turns a rejection into an error page: from here on, a
            // failure must only cost the text layer, never the image.
            try {
                if (this._texture)
                    this.liveText?.start(this._texture, this._noriFile, this._noriFileInfo);
            } catch (e) {
                console.error(`[nori] text recognition not started: ${e}`);
            }
        }

        _handleClick(numClicks) {
            if (!this.liveText?.handleMultiClick(numClicks))
                super._handleClick(numClicks);
        }

        vfunc_snapshot(snapshot) {
            super.vfunc_snapshot(snapshot);
            try {
                this._liveText?.snapshot(snapshot);
            } catch (e) {
                console.error(`[nori] drawing failed: ${e}`);
            }
        }

        stop() {
            this._liveText?.stop();
            super.stop();
        }

        get toolbar() {
            return this.liveText?.toolbar ?? null;
        }
    };
    contentTypes = Image.contentTypes;
} catch (e) {
    console.error(`[nori] disabled, falling back to Sushi's image viewer: ${e}`);
}

export {Klass, contentTypes};
