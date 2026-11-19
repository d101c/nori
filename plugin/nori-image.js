// SPDX-License-Identifier: GPL-2.0-or-later
//
// Nori: Sushi plugin that makes the text in previewed images selectable.
//
// It extends Sushi's own image renderer, so loading, animation and sizing stay
// exactly as upstream. If anything here fails to load, the module exports no
// content types and Sushi keeps using its built-in renderer.

import GObject from 'gi://GObject';

let Klass;
let contentTypes;

try {
    const Image = await import('resource:///org/gnome/NautilusPreviewer/js/viewers/image.js');
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

        get liveText() {
            this._liveText ??= new LiveText(this, () => this.cancellable);
            return this._liveText;
        }

        async _loadFile(file) {
            await super._loadFile(file);
            if (this._texture)
                this.liveText.start(this._texture, this._noriFile, this._noriFileInfo);
        }

        _handleClick(numClicks) {
            if (!this.liveText.handleMultiClick(numClicks))
                super._handleClick(numClicks);
        }

        vfunc_snapshot(snapshot) {
            super.vfunc_snapshot(snapshot);
            this._liveText?.snapshot(snapshot);
        }

        stop() {
            this._liveText?.stop();
            super.stop();
        }

        get toolbar() {
            return this.liveText.toolbar;
        }
    };
    contentTypes = Image.contentTypes;
} catch (e) {
    console.error(`[nori] disabled, falling back to Sushi's image viewer: ${e}`);
}

export {Klass, contentTypes};
