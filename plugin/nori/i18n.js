// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Gettext from 'gettext';

const DOMAIN = 'nori';
const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
Gettext.bindtextdomain(DOMAIN, GLib.build_filenamev([here, 'locale']));

export const _ = msgid => Gettext.dgettext(DOMAIN, msgid);
export const pluginDir = here;
