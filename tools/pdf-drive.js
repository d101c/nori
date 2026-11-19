// Drives Nori's PDF renderer outside Sushi: opens a PDF, jumps to a page
// after a delay, and logs (NORI_DEBUG=1) which pages are read and when the
// preview reloads. Exits once every scanned page is in the shown document.
//
//   GDK_BACKEND=broadway BROADWAY_DISPLAY=:8 NORI_DEBUG=1 \
//       gjs -m tools/pdf-drive.js FILE.pdf [JUMP_TO_PAGE] [AFTER_MS]

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {programArgs} from 'system';

Gio.Resource.load('/usr/share/gnome-sushi/org.gnome.NautilusPreviewer.src.gresource')._register();
Gio.Resource.load('/usr/share/gnome-sushi/org.gnome.NautilusPreviewer.data.gresource')._register();
Adw.init();
// Sushi's main installs gettext globals that its viewers use.
globalThis._ ??= s => s;

const [input, jump = '0', after = '1500'] = programArgs;
const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const plugin = await import(`file://${here}/../plugin/nori-pdf.js`);
const file = Gio.File.new_for_commandline_arg(input);
const info = file.query_info('standard::*,time::modified', Gio.FileQueryInfoFlags.NONE, null);
const renderer = new plugin.Klass(file, info);
const window = new Gtk.Window({child: renderer, default_width: 600, default_height: 800});
window.present();

const started = Date.now();
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
let finish;
const done = new Promise(resolve => (finish = resolve));

renderer.connect('ready', () => {
    print(`${stamp()} ready, ${renderer._inner._model.document.get_n_pages()} pages`);
    if (Number(jump) > 0) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, Number(after), () => {
            renderer._inner._model.set_page(Number(jump) - 1);
            print(`${stamp()} jumped to page ${jump}`);
            return GLib.SOURCE_REMOVE;
        });
    }
});
renderer.connect('failed', (_r, e) => {
    printerr(`failed: ${e.message}`);
    finish(1);
});
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
    const job = renderer._job;
    if (job?.pages.length && renderer._loaded?.size === job.pages.length) {
        print(`${stamp()} all ${job.pages.length} pages shown with text; on page ${renderer._inner._model.get_page() + 1}`);
        finish(0);
        return GLib.SOURCE_REMOVE;
    }
    if (Date.now() - started > 120000) {
        printerr('timed out');
        finish(1);
        return GLib.SOURCE_REMOVE;
    }
    return GLib.SOURCE_CONTINUE;
});

const status = await done;
imports.system.exit(status);
