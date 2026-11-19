// SPDX-License-Identifier: GPL-2.0-or-later
//
// Selectable text over a picture: pointer handling, drawing, menu, copy.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk';
import Gtk from 'gi://Gtk';

import {_, pluginDir} from './i18n.js';
import {TextLayout} from './layout.js';
import {debug, recognize, readConfig, OcrUnavailableError} from './ocr.js';

Gio._promisify(Gtk.UriLauncher.prototype, 'launch', 'launch_finish');

/** Wait before starting OCR, so that arrowing through a folder stays cheap. */
const START_DELAY_MS = 250;
const DRAG_THRESHOLD = 4;

let iconPathAdded = false;
const ensureIcons = () => {
    if (iconPathAdded)
        return;
    const display = Gdk.Display.get_default();
    if (!display)
        return;
    Gtk.IconTheme.get_for_display(display).add_search_path(
        GLib.build_filenamev([pluginDir, 'icons']));
    iconPathAdded = true;
};

export class LiveText {
    /** @type {TextLayout|null} */ layout = null;
    /** Selection as word indices, [-1, -1] when empty. */
    first = -1;
    last = -1;
    #anchor = -1;
    #dragging = false;
    #pointer = null; // widget coordinates
    #hoveredDetection = null;
    #showAll = false;
    #startTimeout = 0;
    #toolbar = null;
    #showButton = null;
    #copyButton = null;
    #copyResetTimeout = 0;
    #popover = null;
    #stopped = false;

    /**
     * @param {Gtk.Picture} host the image renderer
     * @param {() => Gio.Cancellable} getCancellable
     */
    constructor(host, getCancellable) {
        this.host = host;
        this.getCancellable = getCancellable;
        ensureIcons();
        this.#setupControllers();
        this.#setupActions();
        this.#buildToolbar();
    }

    get toolbar() {
        return this.#toolbar;
    }

    get hasSelection() {
        return this.first >= 0 && this.last >= this.first;
    }

    get selectedText() {
        return this.hasSelection ? this.layout.textBetween(this.first, this.last) : '';
    }

    /** Called once the first frame is on screen. */
    start(texture, file, fileInfo) {
        if (this.#stopped || this.#startTimeout || readConfig().enabled === false)
            return;
        this.#startTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, START_DELAY_MS, () => {
            this.#startTimeout = 0;
            this.#run(texture, file, fileInfo);
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        this.#stopped = true;
        this.#closeMenu();
        if (this.#startTimeout) {
            GLib.source_remove(this.#startTimeout);
            this.#startTimeout = 0;
        }
        if (this.#copyResetTimeout) {
            GLib.source_remove(this.#copyResetTimeout);
            this.#copyResetTimeout = 0;
        }
    }

    async #run(texture, file, fileInfo) {
        const cancellable = this.getCancellable();
        if (cancellable.is_cancelled())
            return;
        try {
            const {tsv, scale} = await recognize(texture, file, fileInfo, cancellable);
            if (cancellable.is_cancelled())
                return;
            this.layout = TextLayout.fromTsv(tsv, scale);
            debug(`${this.layout.words.length} words, ${this.layout.lines.length} lines,`,
                `${this.layout.detections.length} detections`);
            if (GLib.getenv('NORI_DEBUG'))
                this.host.set_name(`nori-ready-${this.layout.words.length}`);
            if (!this.layout.isEmpty) {
                this.#toolbar.set_visible(true);
                // Screen readers get the recognised text as the image's description.
                this.host.update_property([Gtk.AccessibleProperty.DESCRIPTION], [this.layout.fullText]);
            }
            this.host.queue_draw();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || cancellable.is_cancelled())
                return;
            if (e instanceof OcrUnavailableError)
                debug(e.message);
            else
                console.warn('[nori] text recognition failed:', e.message);
        }
    }

    /* Geometry */

    /** Where the picture is drawn inside the widget (GtkPicture, SCALE_DOWN). */
    #contentRect() {
        const paintable = this.host.get_paintable();
        if (!paintable)
            return null;
        const pw = paintable.get_intrinsic_width();
        const ph = paintable.get_intrinsic_height();
        const W = this.host.get_width();
        const H = this.host.get_height();
        if (!pw || !ph || !W || !H)
            return null;
        const s = Math.min(W / pw, H / ph, 1);
        const w = pw * s, h = ph * s;
        return {x: (W - Math.ceil(w)) / 2, y: (H - Math.ceil(h)) / 2, s};
    }

    #toImage(x, y) {
        const r = this.#contentRect();
        return r ? [(x - r.x) / r.s, (y - r.y) / r.s] : [NaN, NaN];
    }

    #wordAtPointer() {
        if (!this.layout || !this.#pointer)
            return -1;
        return this.layout.wordAt(...this.#toImage(...this.#pointer));
    }

    /* Input */

    #setupControllers() {
        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_c, x, y) => this.#onMotion(x, y));
        motion.connect('leave', () => {
            this.#pointer = null;
            this.#setHoveredDetection(null);
        });
        this.host.add_controller(motion);

        const drag = new Gtk.GestureDrag({button: Gdk.BUTTON_PRIMARY});
        drag.connect('drag-begin', (_g, x, y) => {
            this.#pointer = [x, y];
            this.#anchor = this.#wordAtPointer();
            this.#dragging = false;
        });
        drag.connect('drag-update', (gesture, dx, dy) => {
            if (this.#anchor < 0)
                return;
            const [, sx, sy] = gesture.get_start_point();
            if (!this.#dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD)
                return;
            if (!this.#dragging) {
                this.#dragging = true;
                // Only now, so that the image's double-click still reaches the click gesture.
                gesture.set_state(Gtk.EventSequenceState.CLAIMED);
            }
            const focus = this.layout.nearestWord(...this.#toImage(sx + dx, sy + dy));
            this.#select(Math.min(this.#anchor, focus), Math.max(this.#anchor, focus));
        });
        drag.connect('drag-end', (_g, dx, dy) => {
            if (!this.#dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD)
                this.#onPlainClick();
            this.#dragging = false;
        });
        this.host.add_controller(drag);

        const secondary = new Gtk.GestureClick({button: Gdk.BUTTON_SECONDARY});
        secondary.connect('pressed', (gesture, _n, x, y) => {
            if (!this.layout || this.layout.isEmpty)
                return;
            gesture.set_state(Gtk.EventSequenceState.CLAIMED);
            this.#pointer = [x, y];
            const id = this.#wordAtPointer();
            // Right-clicking outside the selection selects the word under the pointer.
            if (id >= 0 && !(id >= this.first && id <= this.last))
                this.#select(id, id);
            this.#popupMenu(x, y, id);
        });
        this.host.add_controller(secondary);

        const shortcuts = new Gtk.ShortcutController({scope: Gtk.ShortcutScope.MANAGED});
        for (const [trigger, action] of [['<Control>c', 'nori.copy'], ['<Control>a', 'nori.select-all']]) {
            shortcuts.add_shortcut(new Gtk.Shortcut({
                trigger: Gtk.ShortcutTrigger.parse_string(trigger),
                action: Gtk.ShortcutAction.parse_string(`action(${action})`),
            }));
        }
        this.host.add_controller(shortcuts);
    }

    /** Double and triple clicks; returns false to let the image handle them. */
    handleMultiClick(numClicks) {
        const id = this.#wordAtPointer();
        if (id < 0)
            return false;
        if (numClicks === 2)
            this.#select(id, id);
        else if (numClicks >= 3)
            this.#select(...this.layout.lineRange(id));
        return true;
    }

    #onPlainClick() {
        const id = this.#wordAtPointer();
        const detection = id >= 0 ? this.layout.detectionAt(id) : null;
        if (detection && !(this.hasSelection && id >= this.first && id <= this.last)) {
            this.#select(detection.first, detection.last);
            this.#popupMenu(...this.#pointer, id);
            return;
        }
        if (id < 0 || !(id >= this.first && id <= this.last))
            this.#select(-1, -1);
    }

    #onMotion(x, y) {
        this.#pointer = [x, y];
        const id = this.#wordAtPointer();
        const detection = id >= 0 ? this.layout.detectionAt(id) : null;
        this.#setHoveredDetection(detection);
        this.host.set_cursor_from_name(detection ? 'pointer' : id >= 0 ? 'text' : null);
    }

    #setHoveredDetection(detection) {
        if (detection === this.#hoveredDetection)
            return;
        this.#hoveredDetection = detection;
        this.host.queue_draw();
    }

    #select(first, last) {
        if (first === this.first && last === this.last)
            return;
        this.first = first;
        this.last = last;
        this.host.queue_draw();
        if (GLib.getenv('NORI_DEBUG'))
            debug('selection:', JSON.stringify(this.selectedText));
    }

    /* Actions and menu */

    #setupActions() {
        const group = new Gio.SimpleActionGroup();
        const add = (name, callback, type = null) => {
            const action = new Gio.SimpleAction({name, parameter_type: type});
            action.connect('activate', (_a, param) => callback(param?.unpack()));
            group.add_action(action);
        };
        add('copy', () => this.#copy(this.selectedText));
        add('copy-all', () => this.#copy(this.layout?.fullText ?? '', true));
        add('select-all', () => {
            if (this.layout && !this.layout.isEmpty)
                this.#select(0, this.layout.words.length - 1);
        });
        add('copy-value', value => this.#copy(value), new GLib.VariantType('s'));
        add('open-uri', uri => this.#launch(uri), new GLib.VariantType('s'));
        add('toggle-show-all', () => this.#setShowAll(!this.#showAll));
        this.host.insert_action_group('nori', group);
        this.#actions = group;
    }

    #actions = null;

    #popupMenu(x, y, id) {
        const menu = new Gio.Menu();
        const detection = id >= 0 ? this.layout.detectionAt(id) : null;
        if (detection) {
            const section = new Gio.Menu();
            const value = new GLib.Variant('s', detection.value);
            if (detection.kind === 'url') {
                section.append_item(itemWithTarget(_('Open Link'), 'nori.open-uri', value));
                section.append_item(itemWithTarget(_('Copy Link'), 'nori.copy-value', value));
            } else if (detection.kind === 'email') {
                section.append_item(itemWithTarget(_('Send Email'), 'nori.open-uri',
                    new GLib.Variant('s', `mailto:${detection.value}`)));
                section.append_item(itemWithTarget(_('Copy Email Address'), 'nori.copy-value', value));
            } else {
                section.append_item(itemWithTarget(_('Copy Phone Number'), 'nori.copy-value', value));
            }
            menu.append_section(null, section);
        }
        const edit = new Gio.Menu();
        if (this.hasSelection)
            edit.append(_('Copy'), 'nori.copy');
        edit.append(_('Select All Text'), 'nori.select-all');
        edit.append(_('Copy All Text'), 'nori.copy-all');
        menu.append_section(null, edit);

        this.#closeMenu();
        const popover = Gtk.PopoverMenu.new_from_model(menu);
        popover.set_parent(this.host);
        popover.set_has_arrow(false);
        popover.set_halign(Gtk.Align.START);
        const rect = new Gdk.Rectangle({x: Math.round(x), y: Math.round(y), width: 1, height: 1});
        popover.set_pointing_to(rect);
        popover.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this.#popover === popover)
                this.#closeMenu();
            return GLib.SOURCE_REMOVE;
        }));
        this.#popover = popover;
        popover.popup();
    }

    #closeMenu() {
        const popover = this.#popover;
        this.#popover = null;
        if (popover?.get_parent()) {
            popover.popdown();
            popover.unparent();
        }
    }

    #copy(text, fromButton = false) {
        if (!text)
            return;
        this.host.get_clipboard().set(text);
        debug('copied:', JSON.stringify(text));
        if (fromButton)
            this.#flashCopied();
    }

    #flashCopied() {
        this.#copyButton.set_icon_name('object-select-symbolic');
        if (this.#copyResetTimeout)
            GLib.source_remove(this.#copyResetTimeout);
        this.#copyResetTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
            this.#copyButton.set_icon_name('edit-copy-symbolic');
            this.#copyResetTimeout = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    #launch(uri) {
        new Gtk.UriLauncher({uri}).launch(this.host.get_root(), null)
            .catch(e => console.warn('[nori] cannot open', uri, e.message));
    }

    #setShowAll(on) {
        this.#showAll = on;
        this.#showButton.set_active(on);
        this.host.queue_draw();
    }

    #buildToolbar() {
        this.#showButton = new Gtk.ToggleButton({
            icon_name: 'nori-live-text-symbolic',
            tooltip_text: _('Show Text'),
            css_classes: ['circular', 'flat'],
        });
        this.#showButton.connect('toggled', b => {
            if (b.active !== this.#showAll)
                this.#setShowAll(b.active);
        });
        this.#copyButton = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy All Text'),
            action_name: 'nori.copy-all',
            css_classes: ['circular', 'flat'],
        });
        for (const [button, label] of [[this.#showButton, _('Show Text')], [this.#copyButton, _('Copy All Text')]])
            button.update_property([Gtk.AccessibleProperty.LABEL], [label]);

        this.#toolbar = new Gtk.Box({
            halign: Gtk.Align.END,
            valign: Gtk.Align.END,
            spacing: 6,
            visible: false,
            css_classes: ['osd', 'pill-osd'],
        });
        // The toolbar is not inside the picture: give it the actions too.
        this.#toolbar.insert_action_group('nori', this.#actions);
        this.#toolbar.append(this.#showButton);
        this.#toolbar.append(this.#copyButton);
    }

    /* Drawing */

    /** @param {Gtk.Snapshot} snapshot */
    snapshot(snapshot) {
        if (!this.layout || this.layout.isEmpty)
            return;
        const r = this.#contentRect();
        if (!r)
            return;
        const toWidget = b => new Graphene.Rect({
            origin: new Graphene.Point({x: r.x + b.x * r.s, y: r.y + b.y * r.s}),
            size: new Graphene.Size({width: b.w * r.s, height: b.h * r.s}),
        });
        const pad = b => ({x: b.x - b.h * 0.15, y: b.y - b.h * 0.12, w: b.w + b.h * 0.3, h: b.h * 1.24});
        const accent = Adw.StyleManager.get_default().get_accent_color_rgba();

        if (this.#showAll) {
            // Dim everything except the text, which stays as is.
            const whole = new Graphene.Rect({
                origin: new Graphene.Point({x: r.x, y: r.y}),
                size: new Graphene.Size({
                    width: this.host.get_width() - 2 * r.x,
                    height: this.host.get_height() - 2 * r.y,
                }),
            });
            snapshot.push_mask(Gsk.MaskMode.INVERTED_ALPHA);
            for (const line of this.layout.lines)
                appendRounded(snapshot, toWidget(pad(line.box)), 4, rgba(0, 0, 0, 1));
            snapshot.pop();
            snapshot.append_color(rgba(0, 0, 0, 0.55), whole);
            snapshot.pop();
            for (const line of this.layout.lines)
                appendRoundedBorder(snapshot, toWidget(pad(line.box)), 4, rgba(1, 1, 1, 0.9));
        }

        if (this.hasSelection) {
            const color = rgba(accent.red, accent.green, accent.blue, 0.38);
            for (const box of this.layout.selectionBoxes(this.first, this.last))
                appendRounded(snapshot, toWidget(pad(box)), 3, color);
        }

        const underlined = this.#showAll ? this.layout.detections
            : this.#hoveredDetection ? [this.#hoveredDetection] : [];
        for (const d of underlined) {
            for (const box of this.layout.selectionBoxes(d.first, d.last)) {
                const rect = toWidget(box);
                const thickness = Math.max(1.5, rect.get_height() * 0.07);
                snapshot.append_color(rgba(accent.red, accent.green, accent.blue, 1), new Graphene.Rect({
                    origin: new Graphene.Point({x: rect.get_x(), y: rect.get_y() + rect.get_height() + thickness / 2}),
                    size: new Graphene.Size({width: rect.get_width(), height: thickness}),
                }));
            }
        }
    }
}

const rgba = (red, green, blue, alpha) => new Gdk.RGBA({red, green, blue, alpha});

const appendRounded = (snapshot, rect, radius, color) => {
    const rounded = new Gsk.RoundedRect();
    rounded.init_from_rect(rect, radius);
    snapshot.push_rounded_clip(rounded);
    snapshot.append_color(color, rect);
    snapshot.pop();
};

const appendRoundedBorder = (snapshot, rect, radius, color) => {
    const rounded = new Gsk.RoundedRect();
    rounded.init_from_rect(rect, radius);
    snapshot.append_border(rounded, [1, 1, 1, 1], [color, color, color, color]);
};

const itemWithTarget = (label, action, target) => {
    const item = Gio.MenuItem.new(label, null);
    item.set_action_and_target_value(action, target);
    return item;
};

GObject.type_ensure(Gtk.PopoverMenu.$gtype);
