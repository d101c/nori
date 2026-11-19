#!/usr/bin/env bash
# Runs a throwaway Sushi on a private D-Bus session, rendered by GTK Broadway
# (http://127.0.0.1:$((8080 + DISPLAY_NUM))), with this checkout installed as
# the only user plugin. The desktop's own previewer is never touched.
#
#   tools/sandbox.sh start        start broadwayd + D-Bus + Sushi
#   tools/sandbox.sh show FILE    preview FILE
#   tools/sandbox.sh stop
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
num=${NORI_BROADWAY:-7}
state=${XDG_RUNTIME_DIR:-/tmp}/nori-sandbox
mkdir -p "$state"

start() {
    stop >/dev/null 2>&1 || true
    data="$state/data"; mkdir -p "$data/sushi"
    ln -sfn "$here/plugin" "$data/sushi/plugins-1"
    gtk4-broadwayd ":$num" >"$state/broadwayd.log" 2>&1 &
    echo $! >"$state/broadwayd.pid"
    eval "$(env -u WAYLAND_DISPLAY -u DISPLAY dbus-launch --sh-syntax)"
    echo "$DBUS_SESSION_BUS_ADDRESS" >"$state/bus"
    echo "$DBUS_SESSION_BUS_PID" >"$state/bus.pid"
    (
        export DBUS_SESSION_BUS_ADDRESS GDK_BACKEND=broadway BROADWAY_DISPLAY=":$num"
        export XDG_DATA_HOME="$data" XDG_CACHE_HOME="$state/cache"
        unset WAYLAND_DISPLAY DISPLAY
        export GTK_A11Y=none NO_AT_BRIDGE=1 ${NORI_DEBUG:+NORI_DEBUG=$NORI_DEBUG} ${TESSDATA_PREFIX:+TESSDATA_PREFIX=$TESSDATA_PREFIX}
        exec /usr/libexec/org.gnome.NautilusPreviewer
    ) >"$state/sushi.log" 2>&1 &
    echo $! >"$state/sushi.pid"
    for _ in $(seq 50); do
        DBUS_SESSION_BUS_ADDRESS=$(cat "$state/bus") gdbus introspect --session \
            --dest org.gnome.NautilusPreviewer --object-path /org/gnome/NautilusPreviewer \
            >/dev/null 2>&1 && break
        sleep 0.1
    done
    echo "sandbox up: http://127.0.0.1:$((8080 + num))"
}

show() {
    # If our Sushi died (Broadway exits when the browser disconnects), D-Bus
    # would auto-start a stock one on the real display: refuse instead.
    if ! kill -0 "$(cat "$state/sushi.pid" 2>/dev/null)" 2>/dev/null; then
        echo "sandbox Sushi is not running: tools/sandbox.sh start" >&2
        exit 1
    fi
    uri=$(gio info "$1" | sed -n 's/^uri: //p')
    DBUS_SESSION_BUS_ADDRESS=$(cat "$state/bus") gdbus call --session \
        --dest org.gnome.NautilusPreviewer --object-path /org/gnome/NautilusPreviewer \
        --method org.gnome.NautilusPreviewer2.ShowFile "$uri" "" false "" >/dev/null
}

stop() {
    for p in sushi broadwayd bus; do
        [ -f "$state/$p.pid" ] && kill "$(cat "$state/$p.pid")" 2>/dev/null || true
        rm -f "$state/$p.pid"
    done
}

case "${1:-}" in
start) start ;;
show) show "$2" ;;
stop) stop ;;
log) cat "$state/sushi.log" ;;
*) echo "usage: $0 start|show FILE|stop|log" >&2; exit 2 ;;
esac
