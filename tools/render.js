// Renders Nori's image renderer to a PNG, without Sushi's window, to check
// drawing pixel by pixel and to make README screenshots. Also an end-to-end
// test of the OCR pipeline: exits 1 if no text is found.
//
//   gtk4-broadwayd :8 &
//   GDK_BACKEND=broadway BROADWAY_DISPLAY=:8 gjs -m tools/render.js IMAGE OUT.png [select-all|show-all|select:FIRST-LAST] ...

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Graphene from 'gi://Graphene';
import {programArgs} from 'system';

Gio.Resource.load('/usr/share/gnome-sushi/org.gnome.NautilusPreviewer.src.gresource')._register();
Gio.Resource.load('/usr/share/gnome-sushi/org.gnome.NautilusPreviewer.data.gresource')._register();

const [input, output, ...modes] = programArgs;
const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
// A nested GLib.MainLoop would starve promise jobs after the top-level
// awaits below; awaiting a promise lets gjs spin its own loop.
let finish;
const done = new Promise(resolve => (finish = resolve));
const loop = {quit: () => finish()};
let status = 0;

Adw.init();
const plugin = await import(`file://${here}/../plugin/nori-image.js`);
if (!plugin.Klass) {
    printerr('plugin failed to load');
    imports.system.exit(2);
}

const file = Gio.File.new_for_commandline_arg(input);
const info = file.query_info('standard::*,time::modified', Gio.FileQueryInfoFlags.NONE, null);
const renderer = new plugin.Klass(file, info);
renderer.connect('failed', (_r, error) => {
    printerr(`renderer failed: ${error.message}`);
    status = 1;
    loop.quit();
});
const window = new Gtk.Window({child: renderer, default_width: 1, default_height: 1});
window.present();

const started = Date.now();
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    const live = renderer._liveText;
    if (!live?.layout) {
        if (Date.now() - started > 30000) {
            printerr('timed out waiting for OCR');
            status = 1;
            loop.quit();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }
    print(`${live.layout.words.length} words, ${live.layout.lines.length} lines, ` +
        `${live.layout.detections.length} detections`);
    if (live.layout.isEmpty)
        status = 1;
    for (const mode of modes) {
        if (mode === 'show-all')
            renderer.activate_action('nori.toggle-show-all', null);
        else if (mode === 'select-all')
            renderer.activate_action('nori.select-all', null);
        else if (mode.startsWith('select:'))
            [live.first, live.last] = mode.slice(7).split('-').map(Number);
    }
    renderer.queue_draw();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        try {
            save(renderer, output);
        } catch (e) {
            printerr(e);
            status = 1;
        }
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    return GLib.SOURCE_REMOVE;
});

const save = (widget, path) => {
    // Without a Broadway client the frame clock never ticks, so lay the
    // widget out by hand at the image's own size.
    const paintable = widget.get_paintable();
    const w = paintable.get_intrinsic_width(), h = paintable.get_intrinsic_height();
    widget.allocate(w, h, -1, null);
    const snapshot = new Gtk.Snapshot();
    widget.get_parent().snapshot_child(widget, snapshot);
    const node = snapshot.to_node();
    if (!node)
        throw new Error(`nothing drawn (widget ${w}x${h}, mapped: ${widget.get_mapped()})`);
    const texture = window.get_renderer().render_texture(node,
        new Graphene.Rect({origin: new Graphene.Point({x: 0, y: 0}), size: new Graphene.Size({width: w, height: h})}));
    texture.save_to_png(path);
    print(`saved ${path} (${w}x${h})`);
};

await done;
imports.system.exit(status);
